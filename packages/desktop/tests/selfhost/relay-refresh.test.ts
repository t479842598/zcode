import assert from "node:assert/strict";
import { test } from "node:test";
import { BufferWriter, serialize } from "@zcode/rpc";
import { ServiceCollection } from "@zcode/services";
import {
  createRelaySocket,
  encodeRelayFrames,
  type RelayDataPayload,
} from "../../src/host/relayDeviceSocket.js";
import { serveRelaySocketOnServices } from "../../src/host/relayChannelServer.js";

const oldIdentity = { bridgeSessionId: "old-bridge", bridgeGeneration: 1 };
const newIdentity = { bridgeSessionId: "new-bridge", bridgeGeneration: 2 };
function socketFixture() {
  const sent: Array<{ payload: RelayDataPayload }> = [];
  const relay = createRelaySocket({ send: (message) => sent.push(message as never), close() {} });
  return { relay, sent };
}

test("refresh rejects frames from the previous bridge", (t) => {
  const { relay } = socketFixture();
  t.after(() => relay.socket.dispose());
  relay.setFrameIdentity(newIdentity);
  let delivered = 0;
  relay.socket.onData(() => delivered++);
  relay.acceptDataPayload(encodeRelayFrames(new Uint8Array([1]), 1, 1, oldIdentity)[0]!);
  assert.equal(delivered, 0);
  relay.acceptDataPayload(encodeRelayFrames(new Uint8Array([2]), 1, 1, newIdentity)[0]!);
  assert.equal(delivered, 1);
});

test("switching bridge clears unfinished fragments with reused messageSeq", (t) => {
  const { relay } = socketFixture();
  t.after(() => relay.socket.dispose());
  relay.setFrameIdentity(oldIdentity);
  const oldFrames = encodeRelayFrames(new Uint8Array(1024 * 1024 + 1), 1, 1, oldIdentity);
  relay.acceptDataPayload(oldFrames[0]!);
  relay.setFrameIdentity(newIdentity);
  let delivered = 0;
  relay.socket.onData(() => delivered++);
  relay.acceptDataPayload(encodeRelayFrames(new Uint8Array([2]), 1, 1, newIdentity)[0]!);
  assert.equal(delivered, 1);
});

test("disposed channel cannot relabel a late RPC response with the new bridge", async (t) => {
  const { relay, sent } = socketFixture();
  t.after(() => relay.socket.dispose());
  relay.setFrameIdentity(oldIdentity);
  let finish!: (value: string) => void;
  const pending = new Promise<string>((resolve) => {
    finish = resolve;
  });
  const services = new ServiceCollection();
  services.register({ channelName: "probe" }, { deferred: () => pending });
  const channel = serveRelaySocketOnServices(relay.socket, services, () => {});
  const writer = new BufferWriter();
  serialize(writer, [100, 1, "probe", "deferred"]);
  serialize(writer, []);
  relay.acceptDataPayload(encodeRelayFrames(writer.buffer.buffer, 1, 1, oldIdentity)[0]!);
  await channel.dispose();
  relay.setFrameIdentity(newIdentity);
  finish("old-result");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(
    sent.map((frame) => frame.payload.zcode_type),
    ["rpc-frame-ack"],
    "old request may be acknowledged, but never sends a late business reply into the new bridge",
  );
  assert.equal(sent[0]?.payload.bridgeSessionId, oldIdentity.bridgeSessionId);
});

test("duplicate identity does not restart the outgoing sequence", (t) => {
  const { relay, sent } = socketFixture();
  t.after(() => relay.socket.dispose());
  relay.setFrameIdentity(oldIdentity);
  const writer = new BufferWriter();
  serialize(writer, [200]);
  relay.socket.write(writer.buffer);
  relay.setFrameIdentity({ ...oldIdentity });
  relay.socket.write(writer.buffer);
  assert.deepEqual(
    sent.map((frame) => frame.payload.seq),
    [1, 2],
  );
});

test("incomplete or corrupt frames do not count as a valid RPC message", (t) => {
  const { relay } = socketFixture();
  t.after(() => relay.socket.dispose());
  relay.setFrameIdentity(newIdentity);
  const fragments = encodeRelayFrames(new Uint8Array(1024 * 1024 + 1), 1, 1, newIdentity);
  assert.equal(relay.acceptDataPayload(fragments[0]!), false);
  const corrupt = encodeRelayFrames(new Uint8Array([1]), 2, 2, newIdentity)[0]!;
  corrupt.checksum.value = "00000000";
  assert.equal(relay.acceptDataPayload(corrupt), false);
});

test("refresh releases the old agent scope before creating a fresh client identity", async (t) => {
  const { IZCodeAgentService } = await import("@zcode/services");
  const { createRelayBridgeLifecycle } = await import("../../src/host/relayBridgeLifecycle.js");
  const { relay } = socketFixture();
  let attached = 0;
  let detached = 0;
  const scopes: any[] = [];
  class ObservedServices extends ServiceCollection {
    override exposeOnChannelServer(
      server: any,
      overrides: ReadonlyMap<string, unknown> = new Map(),
    ) {
      scopes.push(overrides.get(IZCodeAgentService.channelName));
      super.exposeOnChannelServer(server, overrides);
    }
  }
  const services = new ObservedServices();
  services.register(IZCodeAgentService, {
    onAgentRuntimeLifecycle() {
      assert.equal(attached, detached, "new scope must wait for old scope disposal");
      attached++;
      return {
        dispose() {
          detached++;
        },
      };
    },
  } as any);
  const lifecycle = createRelayBridgeLifecycle(relay.socket, services, () => {});
  t.after(async () => {
    await lifecycle.dispose();
    relay.socket.dispose();
  });
  await lifecycle.prepare(oldIdentity);
  const hello = await scopes[0].helloConversationV4();
  assert.equal(hello.deliveryProfile, "replayable");
  await scopes[0].initializeConversationV4({
    kind: "clientHello",
    protocolVersion: hello.protocolVersion,
    clientId: "client-old",
    appVersion: "fixture",
  });
  await lifecycle.prepare(newIdentity);
  assert.equal(detached, 1);
  await assert.rejects(scopes[0].helloConversationV4(), /connection.closed/);
  await scopes[1].helloConversationV4();
  await scopes[1].initializeConversationV4({
    kind: "clientHello",
    protocolVersion: hello.protocolVersion,
    clientId: "client-new",
    appVersion: "fixture",
  });
  await lifecycle.prepare({ ...newIdentity });
  assert.equal(scopes.length, 2);
});

test("desktop scope remains continuous while relay remains replayable", async () => {
  const { createZCodeAgentConnectionScope } = await import("@zcode/services");
  const desktop = createZCodeAgentConnectionScope({} as any, {
    connectionId: "desktop-fixture",
    clientMode: "desktop-continuous",
    role: "terminal-client",
  });
  assert.equal((await desktop.service.helloConversationV4()).deliveryProfile, "continuous");
  await desktop.dispose();
});

test("valid complete inbound RPC frame is acknowledged, duplicates only re-ACK", (t) => {
  const { relay, sent } = socketFixture();
  t.after(() => relay.socket.dispose());
  relay.setFrameIdentity(newIdentity);
  let delivered = 0;
  relay.socket.onData(() => delivered++);
  const frame = encodeRelayFrames(new Uint8Array([1]), 1, 7, newIdentity)[0]!;
  assert.equal(relay.acceptDataPayload(frame), true);
  assert.equal(delivered, 1);
  assert.equal(sent.at(-1)?.payload.zcode_type, "rpc-frame-ack");
  assert.equal(sent.at(-1)?.payload.ackMessageSeq, 7);
  assert.equal(sent.at(-1)?.payload.bridgeSessionId, newIdentity.bridgeSessionId);
  assert.equal(relay.acceptDataPayload(frame), false);
  assert.equal(delivered, 1, "same RPC must not execute twice");
  assert.equal(sent.filter((entry) => entry.payload.zcode_type === "rpc-frame-ack").length, 2);
});

test("incomplete, corrupt or stale frames never receive an ACK", (t) => {
  const { relay, sent } = socketFixture();
  t.after(() => relay.socket.dispose());
  relay.setFrameIdentity(newIdentity);
  const parts = encodeRelayFrames(new Uint8Array(1024 * 1024 + 1), 1, 4, newIdentity);
  relay.acceptDataPayload(parts[0]!);
  const corrupt = encodeRelayFrames(new Uint8Array([1]), 2, 5, newIdentity)[0]!;
  corrupt.checksum.value = "ffffffff";
  relay.acceptDataPayload(corrupt);
  relay.acceptDataPayload(encodeRelayFrames(new Uint8Array([1]), 3, 6, oldIdentity)[0]!);
  assert.equal(sent.length, 0);
});
