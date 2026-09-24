import assert from "node:assert/strict";
import { test } from "node:test";
import { ServiceCollection } from "@zcode/services";
import { BufferWriter, serialize } from "@zcode/rpc";
import { createRelaySocket, encodeRelayFrames, type RelayDataPayload } from "../../src/host/relayDeviceSocket.js";
import { createRelayBridgeLifecycle } from "../../src/host/relayBridgeLifecycle.js";

const identity = { bridgeSessionId: "bridge", bridgeGeneration: 1 };
function fixture() {
  const sent: Array<{ payload: RelayDataPayload }> = [];
  let closed = 0;
  const socket = createRelaySocket({ send: (message) => sent.push(message as never), close: () => closed++ });
  const lifecycle = createRelayBridgeLifecycle(socket.socket, new ServiceCollection(), () => {});
  return { socket, lifecycle, sent, closed: () => closed };
}

test("initialize retry expires at 10 seconds and closes transport", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture();
  t.after(async () => { await f.lifecycle.dispose(); f.socket.socket.dispose(); });
  await f.lifecycle.prepare(identity);
  f.socket.setFrameIdentity(identity);
  f.lifecycle.ready(identity);
  assert.equal(f.sent.length, 1);
  t.mock.timers.tick(400);
  assert.equal(f.sent.length, 2);
  t.mock.timers.tick(9600);
  assert.equal(f.closed(), 1);
  const count = f.sent.length;
  t.mock.timers.tick(10000);
  assert.equal(f.sent.length, count);
});

test("valid RPC stops initialization retry; duplicate open preserves scope", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture();
  t.after(async () => { await f.lifecycle.dispose(); f.socket.socket.dispose(); });
  await f.lifecycle.prepare(identity);
  f.socket.setFrameIdentity(identity);
  f.lifecycle.ready(identity);
  const writer = new BufferWriter();
  serialize(writer, [101, 999]); // 合法取消帧，不会触发业务任务。
  serialize(writer, undefined);
  f.socket.acceptDataPayload(encodeRelayFrames(writer.buffer.buffer, 1, 1, identity)[0]!);
  await f.lifecycle.prepare({ ...identity });
  f.lifecycle.ready(identity);
  t.mock.timers.tick(20000);
  assert.equal(f.sent.length, 1);
  assert.equal(f.closed(), 0);
});

test("disconnect releases initialization timers and rejects another prepare", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout", "setInterval"] });
  const f = fixture();
  await f.lifecycle.prepare(identity);
  f.socket.setFrameIdentity(identity);
  f.lifecycle.ready(identity);
  f.socket.socket.end();
  await f.lifecycle.dispose();
  t.mock.timers.tick(20000);
  assert.equal(f.sent.length, 1);
  await assert.rejects(f.lifecycle.prepare(identity), /closed/);
});
