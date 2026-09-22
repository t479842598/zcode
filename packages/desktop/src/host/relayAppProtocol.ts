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
import { homedir } from "node:os";

export interface RelayAppPayload {
  zcode_type: string;
  [key: string]: unknown;
}

/** 手机端 tasks 条目的字段形状（对齐 web-remote 的 zod schema og） */
export interface RelayAppTask {
  taskId: string;
  title: string;
  workspacePath: string;
  workspaceIdentity?: string;
  workspaceLabel: string;
  workspaceKind: "local" | "remote";
  createdAt: number;
  updatedAt: number;
  provider?: string;
  unreadAt?: number;
  displayStatus?: "idle" | "running" | "completed" | "error";
  pinned?: boolean;
  archived?: boolean;
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
  /**
   * 动态刷新工作区名单。静态的 workspaces 字段只有 main 传下来的 agentWarmupTargets
   * （上限 3 个），手机端会抱怨「项目没显示全」；这里应指向 settings.recentProjects /
   * lastWorkspaceSession 这类完整来源。失败时保留旧名单，不影响连接。
   */
  resolveWorkspaces?: () => Promise<
    ReadonlyArray<{ workspacePath: string; workspaceIdentity?: string }>
  >;
  /** 取任务/对话列表（手机端的「N 个任务」与对话列表都靠它）；失败按空数组处理 */
  resolveTasks?: () => Promise<ReadonlyArray<RelayAppTask>>;
  /**
   * bridge 打开成功时回传 identity。手机端 b0t 对每个 rpc-frame 都做 zod strict
   * 校验（bridgeSessionId 必填且需与其一致），所以 host 必须在桥建立后立即
   * 把 identity 安装到出站 socket 上，否则所有响应帧会被对端静默丢弃。
   */
  onBridgeIdentity?: (identity: {
    bridgeSessionId: string;
    bridgeGeneration?: number;
    recoveryId?: string;
  }) => void;
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
  /**
   * 返回要回给手机端的消息；null 表示这条消息不需要响应。
   * 允许返回 Promise：工作区/任务名单要从 Setting / zcode-task 服务异步取，
   * 而底层 onMessage 回调是同步的（调用方需自行 await）。
   */
  handle(payload: RelayAppPayload): RelayAppPayload | null | Promise<RelayAppPayload | null>;
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
  const toWorkspace = (item: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): RelayAppWorkspace => ({
    workspacePath: item.workspacePath,
    ...(item.workspaceIdentity ? { workspaceIdentity: item.workspaceIdentity } : {}),
    label: basename(item.workspacePath) || item.workspacePath,
    kind: "local" as const,
    connectionState: "connected" as const,
  });

  // home 根和 / 不是项目目录：手机端拿到只会「打开工作区」失败，直接不报。
  const homeDir = homedir();
  const isUsableWorkspace = (item: { workspacePath: string }): boolean =>
    Boolean(item.workspacePath) && item.workspacePath !== "/" && item.workspacePath !== homeDir;

  let workspaces: RelayAppWorkspace[] = context.workspaces
    .filter(isUsableWorkspace)
    .map(toWorkspace);

  const active =
    workspaces.find((item) => item.workspacePath === context.activeWorkspacePath) ?? workspaces[0];
  const workspaceKey = active ? resolveRelayWorkspaceKey(active) : "";

  /**
   * 每次列表请求都重新取一遍：设置里的项目列表随时会变，而且静态入参只有 3 个。
   * 取失败就沿用上一份，绝不让一次 Setting 抖动把列表变成空。
   */
  const refreshWorkspaces = async (): Promise<void> => {
    if (!context.resolveWorkspaces) return;
    try {
      const next = (await context.resolveWorkspaces()).filter(isUsableWorkspace).map(toWorkspace);
      if (next.length > 0) workspaces = next;
    } catch {
      /* 保留旧名单 */
    }
  };

  /**
   * 手机端对 tasks 条目跑 zod strict 校验：字段不认识或枚举超范围会让**整个**
   * bootstrap-response 被拒（现象：手机端停在「正在加载工作区」，且不再发
   * workspace-bridge-open，而 host 日志看起来一切正常）。实测踩过一次：
   * host 把 task 的 model 当成 provider 下发，而手机端 provider 只接受
   * claude/opencode/gemini/codex/glm，于是整条响应被丢掉。
   * 所以这里做一次白名单收敛，host 侧以后再传错也不会拖垮连接。
   */
  const TASK_PROVIDERS = new Set(["claude", "opencode", "gemini", "codex", "glm"]);
  const sanitizeTask = (task: RelayAppTask): RelayAppTask | null => {
    if (!task || !task.taskId || !task.workspacePath || !task.workspaceLabel) return null;
    return {
      taskId: String(task.taskId),
      title: String(task.title || "未命名任务"),
      workspacePath: String(task.workspacePath),
      ...(task.workspaceIdentity ? { workspaceIdentity: String(task.workspaceIdentity) } : {}),
      workspaceLabel: String(task.workspaceLabel),
      workspaceKind: task.workspaceKind === "remote" ? "remote" : "local",
      createdAt: Number(task.createdAt) || Date.now(),
      updatedAt: Number(task.updatedAt) || Date.now(),
      ...(task.provider && TASK_PROVIDERS.has(task.provider) ? { provider: task.provider } : {}),
      ...(typeof task.unreadAt === "number" ? { unreadAt: task.unreadAt } : {}),
      displayStatus: task.displayStatus ?? "idle",
      ...(task.pinned === true ? { pinned: true } : {}),
      ...(task.archived === true ? { archived: true } : {}),
    };
  };

  const collectTasks = async (): Promise<RelayAppTask[]> => {
    if (!context.resolveTasks) return [];
    try {
      return (await context.resolveTasks())
        .map(sanitizeTask)
        .filter((task): task is RelayAppTask => task !== null);
    } catch {
      return [];
    }
  };

  const listResult = async () => ({
    workspaces,
    tasks: await collectTasks(),
    ...(workspaceKey ? { activeWorkspaceKey: workspaceKey } : {}),
  });

  return {
    workspaceKey,

    handle(payload: RelayAppPayload) {
      switch (payload.zcode_type) {
        case "bootstrap-request": {
          return (async () => {
            await refreshWorkspaces();
            return {
              zcode_type: "bootstrap-response",
              requestId: payload.requestId,
              success: true,
              result: {
                windowControlSessionId: context.deviceSid,
                workspaces,
                tasks: await collectTasks(),
                initialViewState: {
                  ...(workspaceKey ? { activeWorkspaceKey: workspaceKey } : {}),
                  updatedAt: Date.now(),
                },
              },
            };
          })();
        }

        case "workspace-list-request": {
          return (async () => ({
            zcode_type: "workspace-list-response",
            requestId: payload.requestId,
            success: true,
            result: await listResult(),
          }))();
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
          if (
            requested &&
            !workspaces.some((item) => resolveRelayWorkspaceKey(item) === requested)
          ) {
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
          const bridgeIdentity = {
            bridgeSessionId: String(payload.bridgeSessionId ?? ""),
            ...(typeof payload.bridgeGeneration === "number"
              ? { bridgeGeneration: payload.bridgeGeneration }
              : {}),
            ...(typeof payload.recoveryId === "string" ? { recoveryId: payload.recoveryId } : {}),
          };
          context.onBridgeIdentity?.(bridgeIdentity);
          return {
            ...base,
            zcode_type: "workspace-bridge-ready",
            bridge: {
              ...bridgeIdentity,
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
            success:
              requested === "" ||
              workspaces.some((item) => resolveRelayWorkspaceKey(item) === requested),
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
