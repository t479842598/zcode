/**
 * 把一条中继连接挂成 RPC 服务端，语义等同 packages/server/src/http.ts 的 setupChannelServer，
 * 但底层 socket 来自自建中继（relayDeviceSocket），clientMode 固定为手机端用的 web-remote-replayable。
 *
 * 注意：刻意不注册 IWindowControllerService / IMediaPreviewService / IProviderProvisioningTargetService
 * 这类桌面专属 override——远端（手机）客户端不应拿到窗口控制与跨环境凭据写入能力。
 */
import { randomUUID } from "node:crypto";
import {
  ChannelServer,
  LoggingChannelServer,
  type IMessagePassingProtocol,
  type ISocket,
} from "@zcode/rpc";
import {
  IZCodeAgentService,
  createZCodeAgentConnectionScope,
  type ServiceCollection,
} from "@zcode/services";

export interface RelayChannelServerHandle {
  dispose(): Promise<void>;
  /**
   * 向对端发 Initialize。
   * 必须等手机端**真正接入后**再调：ChannelServer 构造时若直接发（deferInit=false），
   * 而当时中继房间里还没有 terminal，这条 Initialize 就丢给了空房间 ——
   * 手机端随后连上会一直等不到它，ChannelClient 的请求全部排队不发出（表现为
   * 「已配对、正在加载工作区」然后超时）。
   */
  ready(): void;
}

/** 用中继 socket 起一个 RPC 服务端；默认延迟 Initialize，由调用方在手机接入后 ready() */
export function serveRelaySocketOnServices(
  socket: ISocket,
  services: ServiceCollection,
  log: (...args: unknown[]) => void,
): RelayChannelServerHandle {
  // 注意：这里刻意不用 SocketProtocol。
  // 手机端（web-remote）用的是 bridge protocol（b0t），它把每条 relay data 帧直接当作
  // 一整条 RPC 消息的字节，不带 SocketProtocol 那层 13 字节帧头。若这层再包一层
  // SocketProtocol，对端 onBuffer 收到的就是 `01 00 ... 06 <正文>`（实测），
  // deserialize 出 undefined，ChannelClient 永远停在 Uninitialized，所有请求排队不发。
  // 一次 socket.write 对应一个中继 data 帧，正好与对端“一帧一消息”对称。
  let disposed = false;
  const protocol: IMessagePassingProtocol = {
    onMessage: socket.onData,
    // rawServer.dispose 会取消请求，但服务可能忽略取消；禁止旧 Promise 向新 bridge 回包。
    send: (buffer) => { if (!disposed) socket.write(buffer); },
    drain: () => Promise.resolve(),
  };
  const rawServer = new ChannelServer(protocol, "server", 1000, true);
  const server = new LoggingChannelServer(rawServer, log);

  const agentService = services.getOptional(IZCodeAgentService);
  const connectionScope = agentService
    ? createZCodeAgentConnectionScope(agentService, {
        connectionId: `relay-ws-${randomUUID()}`,
        clientMode: "web-remote-replayable",
        role: "terminal-client",
      })
    : undefined;

  const overrides = new Map<string, unknown>();
  if (connectionScope) {
    overrides.set(IZCodeAgentService.channelName, connectionScope.service);
  }
  services.exposeOnChannelServer(server, overrides);

  let disposal: Promise<void> | undefined;
  const dispose = (): Promise<void> => {
    if (disposal) return disposal;
    disposed = true;
    rawServer.dispose();
    for (const subscription of subscriptions) subscription.dispose();
    disposal = Promise.resolve().then(() => connectionScope?.dispose());
    return disposal;
  };
  const onSocketClosed = () => { void dispose().catch((error) => log("relay scope cleanup failed", error)); };
  const subscriptions = [socket.onClose(onSocketClosed), socket.onEnd(onSocketClosed)];

  return {
    dispose,
    ready() {
      if (disposed) return;
      rawServer.ready();
    },
  };
}
