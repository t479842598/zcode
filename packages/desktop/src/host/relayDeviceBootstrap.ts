/**
 * 桌面端启动自建中继桥：连自己的 relay → 认证 → 把连接挂成 RPC 服务端，
 * 让手机端（zcode.tang74.top/remote/v4）能远程操控本机 Host。
 *
 * 默认目标可被环境变量覆盖：
 *   ZCODE_SELFHOST_RELAY_WS_URL=wss://zcode.tang74.top/ws
 *   ZCODE_SELFHOST_RELAY_DISABLED=1 关闭桥接
 */
import {
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { ServiceCollection } from "@zcode/services";
import { connectRelayDevice, createPassHash } from "./relayDeviceClient.js";
import { createRelayDebugLog } from "./relayDebugLog.js";
import { createRelayBridgeLifecycle } from "./relayBridgeLifecycle.js";
import type { RelayAppTask } from "./relayAppProtocol.js";

export const DEFAULT_RELAY_WS_URL = "wss://zcode.tang74.top/ws";
/** 手机端工作台地址（自托管静态站） */
export const DEFAULT_WEB_REMOTE_URL = "https://zcode.tang74.top/remote/v4/";

const RECONNECT_MIN_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

export function resolveRelayWsUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZCODE_SELFHOST_RELAY_WS_URL?.trim() || DEFAULT_RELAY_WS_URL;
}

/** 解析手机端工作台地址，可用 ZCODE_SELFHOST_WEB_REMOTE_URL 覆盖 */
export function resolveWebRemoteUrl(env: NodeJS.ProcessEnv = process.env): string {
  return env.ZCODE_SELFHOST_WEB_REMOTE_URL?.trim() || DEFAULT_WEB_REMOTE_URL;
}

function identityFilePath(): string {
  const home = process.env.ZCODE_HOME?.trim() || join(homedir(), ".zcode");
  return join(home, "relay-identity.json");
}

/** 长期密钥落盘复用，保证重启后手机端扫码凭据不失效 */
export function loadOrCreatePassHash(filePath = identityFilePath()): string {
  try {
    const parsed = JSON.parse(readFileSync(filePath, "utf8")) as { passHash?: unknown };
    if (typeof parsed.passHash === "string" && parsed.passHash.length > 0) return parsed.passHash;
  } catch {
    /* 首次运行或文件损坏 → 重新生成 */
  }
  const passHash = createPassHash();
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({ passHash }, null, 2)}\n`, { mode: 0o600 });
  return passHash;
}

export interface RelayDeviceBridgeOptions {
  services: ServiceCollection;
  deviceMid: string;
  /** 本 host 能承载的工作区（main 传下来的 agentWarmupTargets，按最近使用排序） */
  workspaces: ReadonlyArray<{ workspacePath: string; workspaceIdentity?: string }>;
  /** 动态刷新工作区名单（settings.recentProjects / lastWorkspaceSession 等完整来源） */
  resolveWorkspaces?: () => Promise<
    ReadonlyArray<{ workspacePath: string; workspaceIdentity?: string }>
  >;
  /** 取任务/对话列表，供手机端展示「N 个任务」与对话列表 */
  resolveTasks?: () => Promise<ReadonlyArray<RelayAppTask>>;
  /** 手机端先打开哪个；缺省用第一个 */
  activeWorkspacePath?: string;
  /** 展示给手机端的设备名，默认主机名 */
  deviceName?: string;
  relayWsUrl?: string;
  log?: (message: string, details?: unknown) => void;
}

export interface RelayDeviceBridgeHandle {
  /** 当前配对状态；未连接时返回 undefined */
  pairStatus(): "waiting" | "matched" | undefined;
  /** 已认证的 device_sid；未连接时 undefined */
  deviceSid(): string | undefined;
  /** 手机端扫码/点击用的连接链接；未连接时 undefined */
  connectUrl(): string | undefined;
  dispose(): void;
}

/**
 * 构造手机端连接链接，参数与官方 buildWebRemoteControlExternalQrUrl 完全一致：
 *   ?sid=<deviceSid>&hash=<passHash>&t=<timestamp>&mid=<deviceMid>&name=<deviceName>&app_version=<version>
 * 手机端（/remote/v4）据此连中继并完成 terminal 侧认证。
 */
export function buildWebRemoteConnectUrl(options: {
  baseUrl: string;
  deviceSid: string;
  passHash: string;
  deviceMid?: string;
  deviceName?: string;
  appVersion?: string;
  timestamp?: number;
}): string {
  const url = new URL(options.baseUrl);
  url.searchParams.set("sid", options.deviceSid);
  url.searchParams.set("hash", options.passHash);
  url.searchParams.set("t", String(options.timestamp ?? Date.now()));
  if (options.deviceMid?.trim()) url.searchParams.set("mid", options.deviceMid.trim());
  if (options.deviceName?.trim()) url.searchParams.set("name", options.deviceName.trim());
  if (options.appVersion?.trim()) url.searchParams.set("app_version", options.appVersion.trim());
  return url.toString();
}

/**
 * 启动桥接并在断线后自动重连。任何失败都只记日志，不阻断 Host 启动——
 * 远程控制是可选能力，本地使用必须不受影响。
 */
export function startRelayDeviceBridge(options: RelayDeviceBridgeOptions): RelayDeviceBridgeHandle {
  const debugLog = createRelayDebugLog();
  const log = (message: string, details?: unknown) => {
    debugLog?.(details === undefined ? message : `${message} ${JSON.stringify(details)}`);
    (options.log ?? (() => {}))(message, details);
  };
  const relayWsUrl = options.relayWsUrl ?? resolveRelayWsUrl();
  let passHash: string;
  try {
    passHash = loadOrCreatePassHash();
  } catch (error) {
    log("relay bridge: cannot persist identity, remote control disabled", error);
    return {
      pairStatus: () => undefined,
      deviceSid: () => undefined,
      connectUrl: () => undefined,
      dispose: () => {},
    };
  }

  let disposed = false;
  let connection: Awaited<ReturnType<typeof connectRelayDevice>> | undefined;
  let lifecycle: ReturnType<typeof createRelayBridgeLifecycle> | undefined;
  let bridgeCleanup: Promise<void> = Promise.resolve();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let delay = RECONNECT_MIN_MS;
  /**
   * 并发保护。attempt() 是 async，而重连既可能来自 catch，也可能来自 socket.onClose，
   * 不锁会让同一 host 同时建出两条 WS（中继日志里会出现同秒两次 ws connect、
   * 后连的把前连顶掉，device_sid 反复重建）。
   */
  let attemptInFlight = false;
  let retryQueued = false;
  /**
   * 连接链接只在会话建立时生成一次。
   * 早前每次 getState() 都重算（内含 Date.now()），导致 UI 每 2s 拿到“新”链接：
   * 二维码不停重绘，手机端也因链接一直变而无法稳定配对。
   */
  let connectUrl: string | undefined;

  const scheduleRetry = () => {
    if (disposed || retryTimer) return;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      void attempt();
    }, delay);
    delay = Math.min(delay * 2, RECONNECT_MAX_MS);
  };

  const attempt = async () => {
    if (disposed) return;
    if (attemptInFlight) {
      retryQueued = true;
      return;
    }
    attemptInFlight = true;
    let activeLifecycle: ReturnType<typeof createRelayBridgeLifecycle> | undefined;
    try {
      const active = await connectRelayDevice({
        relayWsUrl,
        deviceMid: options.deviceMid,
        passHash,
        workspaces: options.workspaces,
        ...(options.resolveWorkspaces ? { resolveWorkspaces: options.resolveWorkspaces } : {}),
        ...(options.resolveTasks ? { resolveTasks: options.resolveTasks } : {}),
        ...(options.activeWorkspacePath
          ? { activeWorkspacePath: options.activeWorkspacePath }
          : {}),
        log: (message) => log(`relay bridge: ${message}`),
        prepareBridge: async (socket, identity) => {
          await bridgeCleanup;
          if (disposed) throw new Error("relay bridge disposed");
          activeLifecycle ??= createRelayBridgeLifecycle(socket, options.services, (...args) =>
            log("relay rpc", args),
          );
          lifecycle = activeLifecycle;
          await activeLifecycle.prepare(identity);
        },
        releaseBridge: async () => {
          const previous = activeLifecycle;
          activeLifecycle = undefined;
          if (lifecycle === previous) lifecycle = undefined;
          bridgeCleanup = previous?.dispose() ?? bridgeCleanup;
          await bridgeCleanup;
        },
      });
      if (disposed) {
        active.dispose();
        return;
      }
      connection = active;
      delay = RECONNECT_MIN_MS;
      connectUrl = buildWebRemoteConnectUrl({
        baseUrl: resolveWebRemoteUrl(),
        deviceSid: active.deviceSid,
        passHash,
        deviceMid: options.deviceMid,
        deviceName: options.deviceName,
      });
      active.onBridgeOpened((identity) => activeLifecycle?.ready(identity));
      log(`relay bridge: connected (device_sid=${active.deviceSid})`);
      active.socket.onClose(() => {
        bridgeCleanup = activeLifecycle?.dispose() ?? bridgeCleanup;
        void bridgeCleanup.catch((error) => log("relay cleanup failed", String(error)));
        // 旧连接的 close 不能清掉随后建立的新连接。
        if (connection !== active) return;
        lifecycle = undefined;
        connection = undefined;
        connectUrl = undefined;
        if (!disposed) {
          log("relay bridge: disconnected, will retry");
          scheduleRetry();
        }
      });
    } catch (error) {
      log(
        `relay bridge: connect failed (${error instanceof Error ? error.message : String(error)}), retry in ${delay}ms`,
      );
      scheduleRetry();
    } finally {
      attemptInFlight = false;
      if (retryQueued && !disposed) {
        retryQueued = false;
        scheduleRetry();
      }
    }
  };

  void attempt();

  return {
    pairStatus: () => connection?.pairStatus(),
    deviceSid: () => connection?.deviceSid,
    connectUrl: () => connectUrl,
    dispose() {
      if (disposed) return;
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      void lifecycle?.dispose().catch((error) => log("relay cleanup failed", String(error)));
      lifecycle = undefined;
      connection?.dispose();
      connection = undefined;
    },
  };
}
