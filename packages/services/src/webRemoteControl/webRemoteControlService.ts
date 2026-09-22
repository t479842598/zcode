import { Emitter, type Event as RpcEvent } from "@zcode/rpc";
import type { IWebRemoteControlService, WebRemoteControlState } from "./webRemoteControl.js";

/** host 侧中继桥暴露给本服务的最小状态源（relayDeviceBootstrap 的 handle 满足此形状） */
export interface WebRemoteControlBridgeSource {
  pairStatus(): "waiting" | "matched" | undefined;
  deviceSid(): string | undefined;
  connectUrl(): string | undefined;
}

/** 状态刷新间隔——状态指示器是人看的，2s 足够且开销可忽略 */
export const WEB_REMOTE_CONTROL_POLL_INTERVAL_MS = 2_000;

export interface WebRemoteControlService extends IWebRemoteControlService {
  /** host 启动中继桥后注入；传 null 表示关闭 */
  attachBridge(bridge: WebRemoteControlBridgeSource | null): void;
  dispose(): void;
}

function deriveState(bridge: WebRemoteControlBridgeSource | null): WebRemoteControlState {
  if (!bridge) {
    return { status: "disabled" };
  }
  const deviceSid = bridge.deviceSid();
  if (!deviceSid) {
    return { status: "connecting" };
  }
  const pairStatus = bridge.pairStatus();
  return {
    status: pairStatus === "matched" ? "connected" : "waiting",
    deviceSid,
    connectUrl: bridge.connectUrl(),
  };
}

function sameState(left: WebRemoteControlState, right: WebRemoteControlState): boolean {
  return (
    left.status === right.status &&
    left.deviceSid === right.deviceSid &&
    left.connectUrl === right.connectUrl
  );
}

export function createWebRemoteControlService(): WebRemoteControlService {
  let bridge: WebRemoteControlBridgeSource | null = null;
  let lastState: WebRemoteControlState = { status: "disabled" };
  let timer: ReturnType<typeof setInterval> | undefined;
  let disposed = false;

  function publish(next: WebRemoteControlState): void {
    if (sameState(next, lastState)) return;
    lastState = next;
    emitter.fire(next);
  }

  function tick(): void {
    publish(deriveState(bridge));
  }

  // 只在有人订阅时才轮询：没人看就不占定时器
  const emitter = new Emitter<WebRemoteControlState>({
    onWillAddFirstListener: () => {
      if (timer || disposed) return;
      timer = setInterval(tick, WEB_REMOTE_CONTROL_POLL_INTERVAL_MS);
      // 轮询只是兜底，不应阻止 host 退出
      timer.unref?.();
    },
    onDidRemoveLastListener: () => {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  });

  return {
    attachBridge(next: WebRemoteControlBridgeSource | null): void {
      bridge = next;
      publish(deriveState(bridge));
    },

    async getState(): Promise<WebRemoteControlState> {
      lastState = deriveState(bridge);
      return lastState;
    },

    onDynamicDidChangeState(): RpcEvent<WebRemoteControlState> {
      return emitter.event;
    },

    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      emitter.dispose();
    },
  };
}
