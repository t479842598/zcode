/**
 * 移动端远程控制的「应用层」协议（跑在 relay 通道之上、RPC 帧之外的那层业务消息）。
 *
 * 手机端 /remote/v4 接入后的顺序是：
 *   bootstrap-request → bootstrap-response       拿到工作区/任务清单
 *   workspace-bridge-open → workspace-bridge-ready  索取某个工作区的 bridge 元数据
 *   （之后才在同一通道上用 rpc-frame 走真正的 RPC）
 *
 * 这些 payload 的 zcode_type 不是 rpc-frame，**没有分片字段**，必须单独处理；
 * 早期实现把它们交给 RelayMessageAssembler 会被字段校验静默丢弃，手机侧表现为
 * 「一直加载工作区、最后超时」。
 *
 * 字段形状对齐手机端源码里的 zod schema（/remote/v4 assets 的 src-*.js）：
 *   bootstrap-response: { requestId, success, result: { windowControlSessionId, workspaces, tasks, initialViewState? } }
 *   workspace-list-response: { requestId, success, result: { workspaces, tasks?, activeWorkspaceKey?, activeTaskId? } }
 *   workspace-bridge-ready:  { requestId, bridgeSessionId, bridgeGeneration?, recoveryId?, bridge }
 *   workspace-bridge-error:  { requestId, ..., reason, error }
 *   bridge(local): { bridgeSessionId, bridgeGeneration?, recoveryId?, kind: "local", workspaceKey, workspacePath, initialTaskId? }
 */
import { basename } from "node:path";

export interface RelayAppPayload {
  zcode_type: string;
  [key: string]: unknown;
}

export interface RelayAppWorkspace {
  workspacePath: string;
  workspaceIdentity?: string;
  label: string;
  kind: "local" | "remote";
  connectionState: "connected" | "disconnected" | "reconnecting";
}

export interface RelayAppResponderContext {
  /** 整机级会话标识，手机端用作 windowControlSessionId */
  deviceSid: string;
  /** 本 host 能承载的工作区（与 main 传下来的 agentWarmupTargets 一致，按最近使用排序） */
  workspaces: ReadonlyArray<{ workspacePath: string; workspaceIdentity?: string }>;
  /** 手机端先打开哪个；缺省用第一个 */
  activeWorkspacePath?: string;
}

/** 与官方 resolveWebRemoteControlWorkspaceKey 一致：identity 优先，回退 path */
export function resolveRelayWorkspaceKey(workspace: {
  workspacePath: string;
  workspaceIdentity?: string;
}): string {
  return workspace.workspaceIdentity?.trim() || workspace.workspacePath;
}

export interface RelayAppResponder {
  workspaceKey: string;
  /** 返回要回给手机端的消息；null 表示这条消息不需要响应 */
  handle(payload: RelayAppPayload): RelayAppPayload | null;
}

/** 只声明哪些平台能力没实现，避免手机端在 UI 上误以为可用 */
const UNSUPPORTED_PLATFORM_METHODS = new Set([
  "listSSHConfigAliases",
  "listWSLDistros",
  "listDockerContainers",
  "isDockerAvailable",
  "loadMcpFromUserDirectory",
  "saveMcpToUserDirectory",
  "migrateLegacyCommonMcp",
]);

export function createRelayAppResponder(context: RelayAppResponderContext): RelayAppResponder {
  const workspaces: RelayAppWorkspace[] = context.workspaces.map((item) => ({
    workspacePath: item.workspacePath,
    ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
    label: basename(item.workspacePath) || item.workspacePath,
    kind: "local" as const,
    connectionState: "connected" as const,
  }));

  const active =
    workspaces.find((item) => item.workspacePath === context.activeWorkspacePath) ?? workspaces[0];
  const workspaceKey = active ? resolveRelayWorkspaceKey(active) : "";
  /** 手机端发过来的 workspaceKey 可能对应列表里任意一个，不只看 active */
  const keySet = new Set(workspaces.map((item) => resolveRelayWorkspaceKey(item)));

  const listResult = () => ({
    workspaces,
    tasks: [],
    ...(workspaceKey ? { activeWorkspaceKey: workspaceKey } : {}),
  });

  return {
    workspaceKey,

    handle(payload: RelayAppPayload): RelayAppPayload | null {
      switch (payload.zcode_type) {
        case "bootstrap-request": {
          return {
            zcode_type: "bootstrap-response",
            requestId: payload.requestId,
            success: true,
            result: {
              windowControlSessionId: context.deviceSid,
              workspaces,
              tasks: [],
              initialViewState: {
                ...(workspaceKey ? { activeWorkspaceKey: workspaceKey } : {}),
                updatedAt: Date.now(),
              },
            },
          };
        }

        case "workspace-list-request": {
          return {
            zcode_type: "workspace-list-response",
            requestId: payload.requestId,
            success: true,
            result: listResult(),
          };
        }

        case "workspace-bridge-open": {
          const requested = typeof payload.workspaceKey === "string" ? payload.workspaceKey : "";
          const base = {
            requestId: payload.requestId,
            bridgeSessionId: payload.bridgeSessionId,
            ...(payload.bridgeGeneration === undefined
              ? {}
              : { bridgeGeneration: payload.bridgeGeneration }),
            ...(payload.recoveryId === undefined ? {} : { recoveryId: payload.recoveryId }),
          };
          if (requested && !keySet.has(requested)) {
            return {
              ...base,
              zcode_type: "workspace-bridge-error",
              reason: "workspace-closed",
              error: `workspace not hosted by this process: ${requested}`,
            };
          }
          const target = requested
            ? workspaces.find((item) => resolveRelayWorkspaceKey(item) === requested)
            : active;
          if (!target) {
            return {
              ...base,
              zcode_type: "workspace-bridge-error",
              reason: "workspace-closed",
              error: "no workspace available on this host",
            };
          }
          return {
            ...base,
            zcode_type: "workspace-bridge-ready",
            bridge: {
              bridgeSessionId: payload.bridgeSessionId,
              ...(payload.bridgeGeneration === undefined
                ? {}
                : { bridgeGeneration: payload.bridgeGeneration }),
              ...(payload.recoveryId === undefined ? {} : { recoveryId: payload.recoveryId }),
              kind: "local",
              workspaceKey: resolveRelayWorkspaceKey(target),
              workspacePath: target.workspacePath,
              ...(typeof payload.taskId === "string" ? { initialTaskId: payload.taskId } : {}),
            },
          };
        }

        case "workspace-reconnect-request": {
          const requested = typeof payload.workspaceKey === "string" ? payload.workspaceKey : "";
          return {
            zcode_type: "workspace-reconnect-response",
            requestId: payload.requestId,
            workspaceKey: requested,
            success: requested === "" || keySet.has(requested),
          };
        }

        case "platform-request": {
          const method = String(payload.method ?? "");
          // 平台能力（SSH/WSL/Docker/MCP 目录）本实现未提供：明确回失败，
          // 手机端会走「不支持」分支而不是一直等。
          return {
            zcode_type: "platform-response",
            requestId: payload.requestId,
            method,
            success: false,
            error: UNSUPPORTED_PLATFORM_METHODS.has(method)
              ? `platform method not supported by self-hosted desktop: ${method}`
              : `unknown platform method: ${method}`,
          };
        }

        // mobile-view-state-update / mobile-diagnostic / rpc-frame* 等：无需响应
        default:
          return null;
      }
    },
  };
}
