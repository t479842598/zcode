/**
 * 自建中继的 device（桌面）侧客户端：负责 WS 建连 + 注册 + 挑战应答认证，
 * 认证通过后把中继 data 帧接成 ISocket，供 SocketProtocol 复用。
 *
 * 服务端实现见 zcode-selfhost/relay/server.mjs。
 */
import { createHmac, randomBytes } from "node:crypto";
import WebSocket from "ws";
import { Emitter, type ISocket } from "@zcode/rpc";
import { createRelaySocket, type RelayDataPayload } from "./relayDeviceSocket.js";
import { createRelayAppResponder, type RelayAppResponder } from "./relayAppProtocol.js";

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
  return createHmac("sha256", passHash)
    .update(`${nonce}|${role}|${deviceSid}`)
    .digest("base64url");
}

export interface RelayDeviceClientOptions {
  /** 例：wss://zcode.tang74.top/ws */
  relayWsUrl: string;
  deviceMid: string;
  passHash: string;
  /** 本 host 能承载的工作区（main 传下来的 agentWarmupTargets，按最近使用排序） */
  workspaces: ReadonlyArray<{ workspacePath: string; workspaceIdentity?: string }>;
  /** 手机端先打开哪个；缺省用第一个 */
  activeWorkspacePath?: string;
  /** 心跳间隔，默认 25s */
  heartbeatIntervalMs?: number;
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
  readonly onPairStatusChange: (
    listener: (status: "waiting" | "matched") => void,
  ) => { dispose(): void };
  /**
   * 手机端拿到 workspace-bridge-ready 之后才会建 RPC protocol。
   * Initialize 必须在这之后再发：早于此时刻发出去的会落在协议层建立之前没人接收，
   * 手机端的请求就会一直排队（已配对但一直加载工作区）。
   */
  readonly onBridgeOpened: (listener: () => void) => { dispose(): void };
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
    const onCloseEmitter = new Emitter<void>();
    const onEndEmitter = new Emitter<void>();
    const pairStatusEmitter = new Emitter<"waiting" | "matched">();
    const bridgeOpenedEmitter = new Emitter<void>();
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
      if (settled) return;
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
          log(`relay authenticated, pair_status=${pairStatus}`);          appResponder = createRelayAppResponder({
            deviceSid,
            workspaces: options.workspaces,
            ...(options.activeWorkspacePath
              ? { activeWorkspacePath: options.activeWorkspacePath }
              : {}),
          });
          log(`relay app protocol ready workspaceKey=${appResponder.workspaceKey}`);
          if (!settled) {
            settled = true;
            cleanup();
            heartbeat = setInterval(() => {
              send({ type: "pair_status_query", client_ts: Date.now() });
            }, options.heartbeatIntervalMs ?? 25_000);
            resolve({
              socket: relaySocket.socket,
              deviceSid,
              pairStatus: () => pairStatus,
              onPairStatusChange: pairStatusEmitter.event,
              onBridgeOpened: bridgeOpenedEmitter.event,
              dispose() {
                if (disposed) return;
                disposed = true;
                if (heartbeat) clearInterval(heartbeat);
                heartbeat = undefined;
                relaySocket.socket.end();
              },
            });
          }
          return;
        }
        case "pair_status_ack": {
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
            const reply = appResponder?.handle(payload as unknown as { zcode_type: string });
            if (reply) {
              log(`relay app <- ${zcodeType} -> ${String(reply.zcode_type)}`);
              send({ type: "data", payload: reply, client_ts: Date.now() });
              // bridge-ready 发出后，手机端才会建 RPC protocol，这时发 Initialize 才有人收
              if (reply.zcode_type === "workspace-bridge-ready") {
                bridgeOpenedEmitter.fire();
              }
            } else {
              log(`relay app <- ${zcodeType} (no response)`);
            }
            return;
          }
          // bridge 建好后手机端才开始发 RPC 帧；记首片，便于判断卡在「没发」还是「没送达」
          if (payload.fragmentIndex === 0) {
            log(
              `relay rpc-frame <- ${zcodeType} messageSeq=${payload.messageSeq} fragments=${payload.fragmentCount} bytes=${payload.messageBytes}`,
            );
          }
          relaySocket.acceptDataPayload(payload);
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
      onCloseEmitter.fire();
      onEndEmitter.fire();
      if (!settled) fail(new Error(`relay ws closed before authenticated: ${wsUrl}`));
    };
    ws.on("close", handleGone);
    ws.on("error", (error) => {
      log(`relay ws error: ${String(error)}`);
      handleGone();
    });
  });
}
