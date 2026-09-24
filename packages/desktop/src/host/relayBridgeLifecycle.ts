import type { ISocket } from "@zcode/rpc";
import type { ServiceCollection } from "@zcode/services";
import { serveRelaySocketOnServices, type RelayChannelServerHandle } from "./relayChannelServer.js";
import { sameRelayFrameIdentity, type RelayFrameIdentity } from "./relayDeviceSocket.js";

const INITIALIZE_INTERVAL_MS = 400;
const INITIALIZE_TIMEOUT_MS = 10_000;

/** 一个物理设备连接的页面 bridge owner；不创建或终止会话 runtime。 */
export function createRelayBridgeLifecycle(
  socket: ISocket,
  services: ServiceCollection,
  log: (...args: unknown[]) => void,
) {
  let channel: RelayChannelServerHandle | undefined;
  let identity: RelayFrameIdentity | undefined;
  let initializing = false;
  let initialized = false;
  let closed = false;
  let interval: ReturnType<typeof setInterval> | undefined;
  let deadline: ReturnType<typeof setTimeout> | undefined;
  let cleanup: Promise<void> = Promise.resolve();

  const clearTimers = () => {
    if (interval) clearInterval(interval);
    if (deadline) clearTimeout(deadline);
    interval = undefined;
    deadline = undefined;
    initializing = false;
  };
  const releaseChannel = () => {
    clearTimers();
    identity = undefined;
    initialized = false;
    const old = channel;
    channel = undefined;
    // dispose 先同步关闭旧出站门，再等待 owned attachment 释放，避免新旧 scope 交错。
    if (old) cleanup = old.dispose();
    return cleanup;
  };
  const dispose = () => {
    closed = true;
    for (const subscription of subscriptions) subscription.dispose();
    return releaseChannel();
  };
  const onClose = () => { void dispose().catch((error) => log("relay bridge cleanup failed", error)); };
  const subscriptions = [
    socket.onClose(onClose),
    socket.onEnd(onClose),
    socket.onData(() => {
      if (!initializing) return;
      initialized = true;
      clearTimers();
      log("relay bridge: first valid RPC message, initialize complete");
    }),
  ];

  return {
    async prepare(next: RelayFrameIdentity) {
      if (closed) throw new Error("relay bridge closed");
      if (sameRelayFrameIdentity(identity, next)) return;
      await releaseChannel();
      if (closed) throw new Error("relay bridge closed during cleanup");
      channel = serveRelaySocketOnServices(socket, services, log);
      identity = { ...next };
    },
    ready(next: RelayFrameIdentity) {
      if (closed || !sameRelayFrameIdentity(identity, next) || !channel) return;
      // 相同 bridge-open 重试不重建 scope，不重置序号或延长初始化截止时间。
      if (initialized || initializing) return;
      initializing = true;
      channel.ready();
      interval = setInterval(() => channel?.ready(), INITIALIZE_INTERVAL_MS);
      deadline = setTimeout(() => {
        log("relay bridge: initialize timeout, reconnecting transport");
        onClose();
        socket.end();
      }, INITIALIZE_TIMEOUT_MS);
      interval.unref?.();
      deadline.unref?.();
    },
    dispose,
  };
}
