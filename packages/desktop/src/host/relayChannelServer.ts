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
  SocketProtocol,
  type ISocket,
} from "@zcode/rpc";
import {
  IZCodeAgentService,
  createZCodeAgentConnectionScope,
  type ServiceCollection,
} from "@zcode/services";

export interface RelayChannelServerHandle {
  dispose(): void;
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
  const protocol = new SocketProtocol(socket);
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

  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    void connectionScope?.dispose();
    rawServer.dispose();
  };
  socket.onClose(dispose);
  socket.onEnd(dispose);

  return {
    dispose,
    ready() {
      if (disposed) return;
      rawServer.ready();
    },
  };
}
