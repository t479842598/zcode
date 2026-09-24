/**
 * 自建中继的 device（桌面）侧客户端：负责 WS 建连 + 注册 + 挑战应答认证，
 * 认证通过后把中继 data 帧接成 ISocket，供 SocketProtocol 复用。
 *
 * 服务端实现见 zcode-selfhost/relay/server.mjs。
 */
import { createHmac, randomBytes } from "node:crypto";
import WebSocket from "ws";
import { Emitter, type ISocket } from "@zcode/rpc";
import {
  createRelaySocket,
  isAssemblableRelayPayload,
  sameRelayFrameIdentity,
  type RelayFrameIdentity,
  type RelayDataPayload,
} from "./relayDeviceSocket.js";
import {
  createRelayAppResponder,
  type RelayAppResponder,
  type RelayAppTask,
} from "./relayAppProtocol.js";

/** 随机生成 device 侧长期密钥（服务端只当 HMAC key 用，不校验格式） */
export function createPassHash(): string {
  return randomBytes(32).toString("base64url");
}

/** proof = base64url(HMAC-SHA256(key=passHash, msg=`${nonce}|${role}|${deviceSid}`)) */
export function computeProof(
  passHash: string,
  nonce: string,
  role: "device" | "terminal",
  deviceSid: string,
): string {
  return createHmac("sha256", passHash).update(`${nonce}|${role}|${deviceSid}`).digest("base64url");
}

export interface RelayDeviceClientOptions {
  /** 例：wss://zcode.tang74.top/ws */
  relayWsUrl: string;
  deviceMid: string;
  passHash: string;
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
  /** 心跳间隔，默认 25s */
  heartbeatIntervalMs?: number;
  /** ready 回包前完成旧 scope 释放和新 scope 建立；不改变线上协议。 */
  prepareBridge?: (socket: ISocket, identity: RelayFrameIdentity) => Promise<void>;
  releaseBridge?: () => Promise<void>;
  log?: (message: string) => void;
}

export interface RelayDeviceConnection {
  socket: ISocket;
  deviceSid: string;
  /** 当前配对状态：waiting（无手机端）/ matched（手机端已接入） */
  readonly pairStatus: () => "waiting" | "matched";
  /**
   * 配对状态变化。
   * 消费方（relayChannelServer）靠它决定什么时候发 RPC Initialize ——
   * 手机端没在房间里时发出去会丢，之后手机端接入就只能一直等。
   */
  readonly onPairStatusChange: (listener: (status: "waiting" | "matched") => void) => {
    dispose(): void;
  };
  /**
   * 手机端拿到 workspace-bridge-ready 之后才会建 RPC protocol。
   * Initialize 必须在这之后再发：早于此时刻发出去的会落在协议层建立之前没人接收，
   * 手机端的请求就会一直排队（已配对但一直加载工作区）。
   */
  readonly onBridgeOpened: (listener: (identity: RelayFrameIdentity) => void) => { dispose(): void };
  /** 收到手机端第一条 rpc-frame（用于停止重发 Initialize） */
  readonly onRpcFrameReceived: (listener: () => void) => { dispose(): void };
  dispose(): void;
}

const CONNECT_TIMEOUT_MS = 15_000;

/** 建立一条已认证的中继连接；失败抛错，由调用方决定重试 */
export function connectRelayDevice(
  options: RelayDeviceClientOptions,
): Promise<RelayDeviceConnection> {
  const log = options.log ?? (() => {});
  const wsUrl = `${options.relayWsUrl}${options.relayWsUrl.includes("?") ? "&" : "?"}mid=${encodeURIComponent(options.deviceMid)}`;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl, { headers: { "X-Device-ID": options.deviceMid } });
    const pairStatusEmitter = new Emitter<"waiting" | "matched">();
    const bridgeOpenedEmitter = new Emitter<RelayFrameIdentity>();
    const rpcFrameEmitter = new Emitter<void>();
    let deviceSid = "";
    let pairStatus: "waiting" | "matched" = "waiting";
    /** 只在状态真的变化时通知，避免心跳重复触发 Initialize */
    const setPairStatus = (next: "waiting" | "matched") => {
      if (next === pairStatus) return;
      pairStatus = next;
      pairStatusEmitter.fire(next);
    };
    let settled = false;
    let disposed = false;
    let heartbeat: ReturnType<typeof setInterval> | undefined;
    let awaitingHeartbeat = false;
    let bridgeIdentity: RelayFrameIdentity | undefined;
    // 控制消息串行：异步释放旧 scope 期间不能让下一次 open 越过当前请求。
    let controlQueue = Promise.resolve();
    /** 认证拿到 device_sid 后创建；负责 relay 之上的应用层消息 */
    let appResponder: RelayAppResponder | undefined;

    const relaySocket = createRelaySocket(
      {
        send(message) {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
        },
        close() {
          try {
            ws.close();
          } catch {
            /* 已关闭 */
          }
        },
      },
      (reason, messageSeq) => log(`relay frame discarded: ${reason} messageSeq=${messageSeq}`),
    );

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        ws.close();
        reject(new Error(`relay connect timeout: ${wsUrl}`));
      }
    }, CONNECT_TIMEOUT_MS);

    const cleanup = () => {
      clearTimeout(timer);
      if (heartbeat) clearInterval(heartbeat);
      heartbeat = undefined;
    };

    const fail = (error: Error) => {
      if (settled) {
        ws.close();
        return;
      }
      settled = true;
      cleanup();
      try {
        ws.close();
      } catch {
        /* ignore */
      }
      reject(error);
    };

    const send = (message: Record<string, unknown>) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(message));
    };

    const meta = { name: "zcode-desktop", platform: process.platform, version: "self-host" };

    ws.on("open", () => {
      log(`relay ws open → ${wsUrl}`);
      send({
        type: "device_register_init",
        device_mid: options.deviceMid,
        pass_hash: options.passHash,
        meta,
        client_ts: Date.now(),
      });
    });

    ws.on("message", (raw) => {
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(raw.toString()) as Record<string, unknown>;
      } catch {
        return;
      }
      const type = String(message.type ?? "");

      switch (type) {
        case "device_register_ack": {
          deviceSid = String(message.device_sid ?? "");
          if (!deviceSid) return fail(new Error("relay: device_register_ack missing device_sid"));
          log(`relay registered device_sid=${deviceSid}`);
          send({
            type: "auth_init",
            role: "device",
            device_sid: deviceSid,
            meta,
            client_ts: Date.now(),
          });
          return;
        }
        case "auth_challenge": {
          const nonce = String(message.nonce ?? "");
          if (!nonce) return fail(new Error("relay: auth_challenge missing nonce"));
          send({
            type: "auth_response",
            device_sid: deviceSid,
            proof: computeProof(options.passHash, nonce, "device", deviceSid),
            client_ts: Date.now(),
          });
          return;
        }
        case "auth_ack": {
          pairStatus = message.pair_status === "matched" ? "matched" : "waiting";
          log(`relay authenticated, pair_status=${pairStatus}`);
          appResponder = createRelayAppResponder({
            deviceSid,
            workspaces: options.workspaces,
            ...(options.resolveWorkspaces ? { resolveWorkspaces: options.resolveWorkspaces } : {}),
            ...(options.resolveTasks ? { resolveTasks: options.resolveTasks } : {}),
            ...(options.activeWorkspacePath
              ? { activeWorkspacePath: options.activeWorkspacePath }
              : {}),
          });
          log(`relay app protocol ready workspaceKey=${appResponder.workspaceKey}`);
          if (!settled) {
            settled = true;
            cleanup();
            heartbeat = setInterval(() => {
              // TCP 半开不一定触发 close；一轮无回应后终结，交给 bootstrap 单一路径重连。
              if (awaitingHeartbeat) {
                log("relay heartbeat timeout");
                ws.terminate();
                return;
              }
              awaitingHeartbeat = true;
              send({ type: "pair_status_query", client_ts: Date.now() });
            }, options.heartbeatIntervalMs ?? 25_000);
            resolve({
              socket: relaySocket.socket,
              deviceSid,
              pairStatus: () => pairStatus,
              onPairStatusChange: pairStatusEmitter.event,
              onBridgeOpened: bridgeOpenedEmitter.event,
              onRpcFrameReceived: rpcFrameEmitter.event,
              dispose() {
                if (disposed) return;
                disposed = true;
                cleanup();
                relaySocket.socket.end();
                pairStatusEmitter.dispose();
                bridgeOpenedEmitter.dispose();
                rpcFrameEmitter.dispose();
              },
            });
          }
          return;
        }
        case "pair_status_ack": {
          awaitingHeartbeat = false;
          if (pairStatus === "matched" && message.pair_status !== "matched") {
            relaySocket.setFrameIdentity(undefined);
            bridgeIdentity = undefined;
            controlQueue = controlQueue.then(() => options.releaseBridge?.()).catch((error: unknown) => {
              log(`relay bridge release failed: ${error instanceof Error ? error.message : "unknown"}`);
              if (!disposed) ws.close();
            });
          }
          setPairStatus(message.pair_status === "matched" ? "matched" : "waiting");
          return;
        }
        case "data": {
          const payload = message.payload as RelayDataPayload | undefined;
          if (!payload) return;
          const zcodeType = String(payload.zcode_type ?? "");
          if (zcodeType !== "rpc-frame" && zcodeType !== "rpc-frame-ack") {
            // 手机端的应用层 payload（bootstrap-request / workspace-bridge-open /
            // platform-request 等）没有分片字段，不能送去当 RPC 分片帧组装，
            // 否则会被 RelayMessageAssembler 的字段校验静默丢弃、手机侧超时。
            // 工作区/任务名单要从 Setting 与 zcode-task 服务异步取，而这里是同步的
            // onMessage 回调，所以自己去 await，不阻塞后续帧的处理。
            controlQueue = controlQueue.then(async () => {
              if (disposed) return;
              const reply = await appResponder?.handle(
                payload as unknown as { zcode_type: string },
              );
              if (!reply || disposed) return;
              let opened: RelayFrameIdentity | undefined;
              if (reply.zcode_type === "workspace-bridge-ready") {
                opened = {
                  bridgeSessionId: String(reply.bridgeSessionId ?? ""),
                  ...(typeof reply.bridgeGeneration === "number"
                    ? { bridgeGeneration: reply.bridgeGeneration } : {}),
                  ...(typeof reply.recoveryId === "string" ? { recoveryId: reply.recoveryId } : {}),
                };
                if (!opened.bridgeSessionId) throw new Error("missing bridge identity");
                if (!sameRelayFrameIdentity(bridgeIdentity, opened)) {
                  // 暂停旧入站及分片；prepare 同步关闭旧出站门后等待 attachment 清理。
                  relaySocket.setFrameIdentity(undefined);
                  await options.prepareBridge?.(relaySocket.socket, opened);
                  if (disposed) return;
                  bridgeIdentity = opened;
                  relaySocket.setFrameIdentity(opened);
                }
              }
              log(`relay app <- ${zcodeType} -> ${String(reply.zcode_type)}`);
              send({ type: "data", payload: reply, client_ts: Date.now() });
              if (opened) bridgeOpenedEmitter.fire(opened);
            }).catch((error: unknown) => {
              log(`relay app failed: ${error instanceof Error ? error.message : "unknown"}`);
              if (!disposed) ws.close();
            });
            return;
          }
          // 只有当前 bridge 校验并重组成功的完整消息才证明 Initialize 已被消费。
          if (isAssemblableRelayPayload(payload) && relaySocket.acceptDataPayload(payload)) {
            rpcFrameEmitter.fire();
          }
          return;
        }
        case "error": {
          const code = String(message.code ?? "INTERNAL");
          const detail = String(message.message ?? "");
          log(`relay error: ${code} ${detail}`);
          if (code === "AUTH_FAILED" || code === "KICKED") {
            fail(new Error(`relay ${code}: ${detail}`));
          }
          return;
        }
        default:
          return;
      }
    });

    const handleGone = () => {
      if (disposed) return;
      disposed = true;
      cleanup();
      // 关键：把断开告知**上层持有的 socket**。
      // 上层（relayDeviceBootstrap）订阅的是 relaySocket.socket.onClose，
      // 而它只在 socket.end() 时触发；早前这里只 fire 本地 emitter，
      // 导致 WS 一断上层毫无感知 —— 不重连、也不释放 channelServer，
      // 表现就是桌面端静默掉线、手机端一直卡在加载工作区。
      relaySocket.socket.end();
      pairStatusEmitter.dispose();
      bridgeOpenedEmitter.dispose();
      rpcFrameEmitter.dispose();
      if (!settled) fail(new Error(`relay ws closed before authenticated: ${wsUrl}`));
    };
    ws.on("close", handleGone);
    ws.on("error", (error) => {
      log(`relay ws error: ${String(error)}`);
      handleGone();
    });
  });
}
