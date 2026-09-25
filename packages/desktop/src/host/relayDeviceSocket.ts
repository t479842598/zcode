/**
 * 把自建中继的 JSON `data` 帧适配成 ISocket 字节流。
 *
 * 中继协议（逆向自官方双端，服务端见 zcode-selfhost/relay/server.mjs）：
 *   {type:"data", payload:{zcode_type:"rpc-frame"|"rpc-frame-ack", seq, messageSeq,
 *    fragmentIndex, fragmentCount, messageBytes, checksum:{algorithm:"crc32",value},
 *    dataBase64, ...}}
 *
 * 中继只做原样转发，分片/重组/校验都在客户端完成。
 */
import { Emitter, VSBuffer, type ISocket } from "@zcode/rpc";

/** 单个物理帧上限（协议规定 1MB） */
export const RELAY_MAX_FRAME_BYTES = 1024 * 1024;
/** 单条逻辑消息上限（协议规定 16MB） */
export const RELAY_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;
/** 单条消息最大分片数（协议规定 64） */
export const RELAY_MAX_FRAGMENTS = 64;
/** 未收齐分片的组装超时 */
export const RELAY_ASSEMBLY_TIMEOUT_MS = 30_000;

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

/** CRC32（IEEE），返回 8 位小写十六进制，与协议 checksum.value 一致 */
export function crc32Hex(bytes: Uint8Array): string {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, "0");
}

export interface RelayFrameIdentity {
  bridgeSessionId: string;
  bridgeGeneration?: number;
  recoveryId?: string;
}

/** 三个字段共同标识一次页面接入，不能只比较 sessionId。 */
export function sameRelayFrameIdentity(
  left: RelayFrameIdentity | undefined,
  right: RelayFrameIdentity | undefined,
): boolean {
  return (
    !!left &&
    !!right &&
    left.bridgeSessionId === right.bridgeSessionId &&
    left.bridgeGeneration === right.bridgeGeneration &&
    left.recoveryId === right.recoveryId
  );
}

export interface RelayDataPayload {
  zcode_type: "rpc-frame" | "rpc-frame-ack";
  /**
   * bridge identity。手机端 b0t 用 zod strict schema 校验这三项，缺失或不匹配
   * 会整帧丢弃（表现为「已配对但永远加载不出工作区」）。
   */
  bridgeSessionId?: string;
  bridgeGeneration?: number;
  recoveryId?: string;
  seq: number;
  messageSeq: number;
  fragmentIndex: number;
  fragmentCount: number;
  messageBytes: number;
  checksum: { algorithm: "crc32"; value: string };
  dataBase64: string;
  ackMessageSeq?: number;
}

/**
 * 这个 data 载荷该不该进分片装配器。
 *
 * ACK 只是送达回执：它只有 `ackMessageSeq`，没有 fragmentIndex / fragmentCount /
 * messageSeq。送进 RelayMessageAssembler 必被 `invalid-fragment-params` 判掉，
 * 而丢弃诊断是同步写盘的 —— 手机端每发一个 ACK 就白写一行日志（实测 1:1），
 * 帧风暴时足以拖垮 host 的事件循环。所以只有真正的 rpc-frame 才组装。
 */
export function isAssemblableRelayPayload(payload: { zcode_type?: unknown }): boolean {
  return payload.zcode_type === "rpc-frame";
}

/** 把一段字节切成中继 data 帧；超过 16MB 直接拒绝（协议上限） */
export function encodeRelayFrames(
  bytes: Uint8Array,
  seq: number,
  messageSeq: number,
  identity?: RelayFrameIdentity,
): RelayDataPayload[] {
  if (bytes.byteLength > RELAY_MAX_MESSAGE_BYTES) {
    throw new Error(`relay message too large: ${bytes.byteLength}`);
  }
  const fragmentCount = Math.max(1, Math.ceil(bytes.byteLength / RELAY_MAX_FRAME_BYTES));
  if (fragmentCount > RELAY_MAX_FRAGMENTS) {
    throw new Error(`relay fragment count ${fragmentCount} exceeds ${RELAY_MAX_FRAGMENTS}`);
  }
  const checksum = { algorithm: "crc32" as const, value: crc32Hex(bytes) };
  const frames: RelayDataPayload[] = [];
  for (let index = 0; index < fragmentCount; index += 1) {
    const slice = bytes.subarray(
      index * RELAY_MAX_FRAME_BYTES,
      Math.min((index + 1) * RELAY_MAX_FRAME_BYTES, bytes.byteLength),
    );
    frames.push({
      zcode_type: "rpc-frame",
      ...(identity ?? {}),
      seq,
      messageSeq,
      fragmentIndex: index,
      fragmentCount,
      messageBytes: bytes.byteLength,
      checksum,
      dataBase64: Buffer.from(slice).toString("base64"),
    });
  }
  return frames;
}

interface PendingMessage {
  fragmentCount: number;
  messageBytes: number;
  checksum: string;
  fragments: Map<number, Uint8Array>;
  timer: ReturnType<typeof setTimeout>;
}

/** 收齐分片后按 CRC 校验并拼回完整消息；损坏/超时则丢弃整条消息 */
export class RelayMessageAssembler {
  private readonly pending = new Map<number, PendingMessage>();

  constructor(
    private readonly onMessage: (bytes: Uint8Array) => void,
    /** 丢弃原因回调（诊断用）：非法参数 / 分片数不一致 / CRC 不匹配 / 组装超时 */
    private readonly onDiscard?: (reason: string, messageSeq: number) => void,
  ) {}

  accept(payload: RelayDataPayload): void {
    const { messageSeq, fragmentIndex, fragmentCount, messageBytes } = payload;
    if (
      !Number.isInteger(fragmentIndex) ||
      !Number.isInteger(fragmentCount) ||
      fragmentCount < 1 ||
      fragmentCount > RELAY_MAX_FRAGMENTS ||
      fragmentIndex < 0 ||
      fragmentIndex >= fragmentCount ||
      messageBytes > RELAY_MAX_MESSAGE_BYTES
    ) {
      this.onDiscard?.("invalid-fragment-params", messageSeq);
      return;
    }

    let entry = this.pending.get(messageSeq);
    if (!entry) {
      entry = {
        fragmentCount,
        messageBytes,
        checksum: payload.checksum?.value ?? "",
        fragments: new Map(),
        timer: setTimeout(() => {
          if (this.pending.delete(messageSeq)) this.onDiscard?.("assembly-timeout", messageSeq);
        }, RELAY_ASSEMBLY_TIMEOUT_MS),
      };
      this.pending.set(messageSeq, entry);
    }
    if (entry.fragmentCount !== fragmentCount) {
      this.discard(messageSeq);
      this.onDiscard?.("fragment-count-mismatch", messageSeq);
      return;
    }

    entry.fragments.set(fragmentIndex, Buffer.from(payload.dataBase64, "base64"));
    if (entry.fragments.size < fragmentCount) return;

    this.pending.delete(messageSeq);
    clearTimeout(entry.timer);

    const assembled = new Uint8Array(entry.messageBytes);
    let offset = 0;
    for (let index = 0; index < fragmentCount; index += 1) {
      const fragment = entry.fragments.get(index);
      if (!fragment) {
        this.onDiscard?.("missing-fragment", messageSeq);
        return;
      }
      assembled.set(fragment, offset);
      offset += fragment.byteLength;
    }
    if (crc32Hex(assembled) !== entry.checksum) {
      this.onDiscard?.("crc32-mismatch", messageSeq);
      return;
    }
    this.onMessage(assembled);
  }

  private discard(messageSeq: number): void {
    const entry = this.pending.get(messageSeq);
    if (entry) clearTimeout(entry.timer);
    this.pending.delete(messageSeq);
  }

  dispose(): void {
    for (const entry of this.pending.values()) clearTimeout(entry.timer);
    this.pending.clear();
  }
}

export interface RelaySocketTransport {
  /** 发送一条 JSON 帧（中继信封），由调用方负责序列化前的认证状态 */
  send(message: unknown): void;
  close(): void;
}

/** 用中继连接构造 ISocket：写侧分片，读侧重组 */
export function createRelaySocket(
  transport: RelaySocketTransport,
  /** 丢弃诊断（可选）：分片非法/CRC 不匹配/组装超时会走到这里 */
  onDiscard?: (reason: string, messageSeq: number) => void,
): {
  socket: ISocket;
  acceptDataPayload(payload: RelayDataPayload): boolean;
  /** 设出站帧的 bridge identity；须在手机端 bridge-open 之后设置，否则帧会被对端丢弃 */
  setFrameIdentity(identity: RelayFrameIdentity | undefined): void;
} {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();
  let seq = 0;
  let messageSeq = 0;
  let closed = false;
  let frameIdentity: RelayFrameIdentity | undefined;

  let deliveredMessages = 0;
  const deliveredSeqs = new Set<number>();
  let highestDeliveredSeq = 0;
  const assembler = new RelayMessageAssembler((bytes) => {
    deliveredMessages += 1;
    onData.fire(VSBuffer.wrap(bytes));
  }, onDiscard);

  return {
    socket: {
      onData: onData.event,
      onClose: onClose.event,
      onEnd: onEnd.event,
      write(buffer: VSBuffer) {
        if (closed || !frameIdentity) return;
        for (const payload of encodeRelayFrames(
          buffer.buffer,
          (seq += 1),
          (messageSeq += 1),
          frameIdentity,
        )) {
          transport.send({ type: "data", payload, client_ts: Date.now() });
        }
      },
      end() {
        if (closed) return;
        closed = true;
        assembler.dispose();
        transport.close();
        onClose.fire();
        onEnd.fire();
        onData.dispose();
        onClose.dispose();
        onEnd.dispose();
      },
      drain() {
        return Promise.resolve();
      },
      dispose() {
        if (closed) return;
        closed = true;
        assembler.dispose();
        transport.close();
        onData.dispose();
        onClose.dispose();
        onEnd.dispose();
      },
    },
    acceptDataPayload(payload) {
      if (closed) return false;
      // 刷新后的 clientId/messageSeq 会重用；旧身份不能进入当前 RPC 或分片缓存。
      if (
        !frameIdentity ||
        !sameRelayFrameIdentity(frameIdentity, {
          bridgeSessionId: payload.bridgeSessionId ?? "",
          bridgeGeneration: payload.bridgeGeneration,
          recoveryId: payload.recoveryId,
        })
      ) {
        onDiscard?.("stale-bridge", payload.messageSeq);
        return false;
      }
      // 手机端在45秒内收不到ACK会主动重连；成功交付完整消息后立刻回执。
      // 重复messageSeq只补ACK，不再把同一RPC命令执行第二次。
      if (Number.isSafeInteger(payload.messageSeq) && deliveredSeqs.has(payload.messageSeq)) {
        transport.send({
          type: "data",
          payload: {
            zcode_type: "rpc-frame-ack",
            ...frameIdentity,
            ackMessageSeq: payload.messageSeq,
          },
          client_ts: Date.now(),
        });
        return false;
      }
      if (Number.isSafeInteger(payload.messageSeq) && payload.messageSeq <= highestDeliveredSeq) {
        onDiscard?.("stale-message-seq", payload.messageSeq);
        return false;
      }
      const before = deliveredMessages;
      assembler.accept(payload);
      if (deliveredMessages === before) return false;
      deliveredSeqs.add(payload.messageSeq);
      highestDeliveredSeq = Math.max(highestDeliveredSeq, payload.messageSeq);
      if (deliveredSeqs.size > 128) deliveredSeqs.delete(deliveredSeqs.values().next().value!);
      transport.send({
        type: "data",
        payload: {
          zcode_type: "rpc-frame-ack",
          ...frameIdentity,
          ackMessageSeq: payload.messageSeq,
        },
        client_ts: Date.now(),
      });
      return true;
    },
    setFrameIdentity(identity) {
      if (sameRelayFrameIdentity(frameIdentity, identity)) return;
      assembler.dispose();
      deliveredSeqs.clear();
      highestDeliveredSeq = 0;
      frameIdentity = identity ? { ...identity } : undefined;
      // 对端 b0t 的 assembler 按物理 seq 连续性校验，且以 bridge 建立为起点。
      // 本 socket 在桥建立前已经发过东西（Initialize 重发等），不归零会让
      // 对端看到 seq=4198 而期望 1，于是每帧都被当乱序丢掉（表现为收得到、不处理、不回 ack）。
      seq = 0;
      messageSeq = 0;
    },
  };
}
