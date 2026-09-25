import type { IZCodeAgentService } from "@zcode/services";
import type { ZCodeSessionInfo } from "@zcode/shared";

type Task = { taskId: string; workspacePath: string; workspaceIdentity?: string; status?: "running" | "completed" | "error" };
type ListSessions = (params: Parameters<IZCodeAgentService["listSessions"]>[0]) => Promise<ReadonlyArray<Pick<ZCodeSessionInfo, "sessionId" | "workspace" | "status">>>;

/** 列表索引可能晚于正在运行的Agent；仅合并同一已有runtime的同身份会话。 */
export async function overlayLiveRelayTaskStatus<T extends Task>(
  tasks: ReadonlyArray<T>,
  listSessions: ListSessions,
): Promise<T[]> {
  const byWorkspace = new Map<string, T[]>();
  for (const task of tasks) {
    const key = task.workspaceIdentity?.trim() || task.workspacePath;
    const existing = byWorkspace.get(key) ?? [];
    existing.push(task);
    byWorkspace.set(key, existing);
  }
  const current = new Map<string, ZCodeSessionInfo["status"]>();
  await Promise.all([...byWorkspace.entries()].map(async ([key, scoped]) => {
    const first = scoped[0]!;
    try {
      const sessions = await listSessions({
        workspacePath: first.workspacePath,
        ...(first.workspaceIdentity ? { workspaceIdentity: first.workspaceIdentity } : {}),
        sessionIds: scoped.map((task) => task.taskId),
        runtimePolicy: "existing-only",
      });
      for (const session of sessions) {
        if (session.workspace.workspaceKey === key) current.set(`${key}\0${session.sessionId}`, session.status);
      }
    } catch {
      // 没有活跃runtime或查询失败时保持持久化索引，不为手机列表启动Agent。
    }
  }));
  return tasks.map((task) => {
    const key = task.workspaceIdentity?.trim() || task.workspacePath;
    const status = current.get(`${key}\0${task.taskId}`);
    return status === "running" || status === "completed" || status === "error"
      ? { ...task, status } : { ...task };
  });
}
