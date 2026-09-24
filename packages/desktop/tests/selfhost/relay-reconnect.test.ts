import assert from "node:assert/strict";
import { once } from "node:events";
import { test } from "node:test";
import WebSocket from "ws";
import { BufferReader, BufferWriter, VSBuffer, deserialize, serialize } from "@zcode/rpc";
import { ServiceCollection } from "@zcode/services";
import { createRelay } from "../../../../../relay/server.mjs";
import { connectRelayDevice, computeProof } from "../../src/host/relayDeviceClient.js";
import { createRelayBridgeLifecycle } from "../../src/host/relayBridgeLifecycle.js";
import { encodeRelayFrames, type RelayFrameIdentity } from "../../src/host/relayDeviceSocket.js";

async function terminal(url: string, sid: string) {
  const ws = new WebSocket(url);
  const queue: Record<string, any>[] = [];
  let wake: (() => void) | undefined;
  ws.on("message", (raw) => { queue.push(JSON.parse(String(raw))); wake?.(); });
  await once(ws, "open");
  async function next(predicate: (message: Record<string, any>) => boolean) {
    const deadline = Date.now() + 2000;
    while (true) {
      const index = queue.findIndex(predicate);
      if (index >= 0) return queue.splice(index, 1)[0]!;
      if (Date.now() >= deadline) throw new Error("terminal response timeout");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => { wake = undefined; resolve(); }, 20);
        wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
      });
    }
  }
  const send = (message: unknown) => ws.send(JSON.stringify(message));
  send({ type: "auth_init", role: "terminal", device_sid: sid });
  const challenge = await next((m) => m.type === "auth_challenge");
  send({ type: "auth_response", proof: computeProof("fixture-key", challenge.nonce, "terminal", sid) });
  await next((m) => m.type === "auth_ack");
  return {
    ws, send, next,
    async open(identity: RelayFrameIdentity) {
      send({ type: "data", payload: { zcode_type: "workspace-bridge-open", requestId: identity.bridgeSessionId, workspaceKey: "/fixture", ...identity } });
      await next((m) => m.payload?.zcode_type === "workspace-bridge-ready" && m.payload.bridgeSessionId === identity.bridgeSessionId);
      await next((m) => m.payload?.zcode_type === "rpc-frame" && m.payload.bridgeSessionId === identity.bridgeSessionId);
    },
    async ping(identity: RelayFrameIdentity, requestId: number) {
      const writer = new BufferWriter();
      serialize(writer, [100, requestId, "probe", "ping"]);
      serialize(writer, []);
      for (const payload of encodeRelayFrames(writer.buffer.buffer, requestId, requestId, identity)) send({ type: "data", payload });
      const message = await next((m) => {
        if (m.payload?.zcode_type !== "rpc-frame" || m.payload.bridgeSessionId !== identity.bridgeSessionId) return false;
        const reader = new BufferReader(VSBuffer.wrap(Buffer.from(m.payload.dataBase64, "base64")));
        const header = deserialize(reader);
        return header?.[0] === 201 && header?.[1] === requestId;
      });
      const reader = new BufferReader(VSBuffer.wrap(Buffer.from(message.payload.dataBase64, "base64")));
      deserialize(reader);
      assert.equal(deserialize(reader), "pong");
    },
  };
}

test("ten terminal refreshes reuse the device connection and service", { timeout: 15000 }, async (t) => {
  const relay = createRelay({ port: 0, host: "127.0.0.1", store: {}, persist() {} });
  await once(relay, "listening");
  t.after(async () => { for (const ws of relay.clients) ws.terminate(); await new Promise<void>((resolve) => relay.close(() => resolve())); });
  const address = relay.address();
  assert.ok(address && typeof address !== "string");
  const url = `ws://127.0.0.1:${address.port}/ws`;
  const services = new ServiceCollection();
  let calls = 0;
  services.register({ channelName: "probe" }, { ping: () => { calls++; return "pong"; } });
  let lifecycle: ReturnType<typeof createRelayBridgeLifecycle> | undefined;
  let released = 0;
  const device = await connectRelayDevice({
    relayWsUrl: url, deviceMid: "fixture-device", passHash: "fixture-key", workspaces: [{ workspacePath: "/fixture" }],
    prepareBridge: async (socket, identity) => {
      lifecycle ??= createRelayBridgeLifecycle(socket, services, () => {});
      await lifecycle.prepare(identity);
    },
    releaseBridge: async () => {
      await lifecycle?.dispose();
      lifecycle = undefined;
      released++;
    },
  });
  device.onBridgeOpened((identity) => lifecycle?.ready(identity));
  t.after(async () => { await lifecycle?.dispose(); device.dispose(); });
  let previous: Awaited<ReturnType<typeof terminal>> | undefined;
  for (let index = 1; index <= 10; index++) {
    const previousClosed = previous ? once(previous.ws, "close") : undefined;
    const current = await terminal(url, device.deviceSid);
    if (previousClosed) assert.equal((await previousClosed)[0], 4001, "new terminal revokes the previous page");
    t.after(() => current.ws.terminate());
    const identity = { bridgeSessionId: `page-${index}`, bridgeGeneration: index };
    await current.open(identity);
    // 刷新期间旧 TCP 可能尚未关闭；新页面已建立后关闭它也不能清掉新连接。
    previous?.ws.close();
    await current.ping(identity, 1);
    previous = current;
  }
  assert.equal(calls, 10, "每次刷新只发送一次业务请求");
  assert.equal(device.pairStatus(), "matched");
  const waiting = new Promise<void>((resolve) => device.onPairStatusChange((status) => {
    if (status === "waiting") resolve();
  }));
  previous!.ws.close();
  await waiting;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(released, 1, "last terminal disconnect releases the bridge");
});

test("an authenticated device closes on heartbeat loss or a fatal relay error", { timeout: 5000 }, async () => {
  const { WebSocketServer } = await import("ws");
  for (const mode of ["heartbeat", "auth-error"] as const) {
    const relay = new WebSocketServer({ port: 0, host: "127.0.0.1" });
    await once(relay, "listening");
    let peer: WebSocket | undefined;
    relay.on("connection", (ws) => {
      peer = ws;
      ws.on("message", (raw) => {
        const m = JSON.parse(String(raw));
        if (m.type === "device_register_init") ws.send(JSON.stringify({ type: "device_register_ack", device_sid: "fixture" }));
        if (m.type === "auth_init") ws.send(JSON.stringify({ type: "auth_challenge", nonce: "fixture" }));
        if (m.type === "auth_response") ws.send(JSON.stringify({ type: "auth_ack", pair_status: "waiting" }));
      });
    });
    const address = relay.address();
    assert.ok(address && typeof address !== "string");
    const device = await connectRelayDevice({ relayWsUrl: `ws://127.0.0.1:${address.port}/ws`, deviceMid: "fixture", passHash: "fixture", workspaces: [], heartbeatIntervalMs: 15 });
    try {
      const closed = new Promise<void>((resolve) => device.socket.onClose(() => resolve()));
      if (mode === "auth-error") peer!.send(JSON.stringify({ type: "error", code: "KICKED", message: "fixture" }));
      await closed;
    } finally {
      device.dispose();
      for (const ws of relay.clients) ws.terminate();
      await new Promise<void>((resolve) => relay.close(() => resolve()));
    }
  }
});
