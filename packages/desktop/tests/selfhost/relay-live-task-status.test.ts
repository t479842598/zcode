import assert from "node:assert/strict";
import { test } from "node:test";
import { overlayLiveRelayTaskStatus } from "../../src/host/relayLiveTaskStatus.js";

const completed = { taskId: "task-1", workspacePath: "/project", createdAt: 1, updatedAt: 2, status: "completed" as const };

test("current running session overrides stale completed index status", async () => {
  const observed: string[] = [];
  const result = await overlayLiveRelayTaskStatus([completed], async (request) => {
    observed.push(request.runtimePolicy);
    return [{ sessionId: "task-1", workspace: { workspacePath: "/project", workspaceKey: "/project" }, status: "running" }];
  });
  assert.equal(result[0]?.status, "running");
  assert.deepEqual(observed, ["existing-only"]);
});

test("different workspace identity cannot change a task; missing runtime retains terminal status", async () => {
  const tasks = [{ ...completed, workspaceIdentity: "id-A" }];
  const mismatched = await overlayLiveRelayTaskStatus(tasks, async () => [
    { sessionId: "task-1", workspace: { workspacePath: "/project", workspaceIdentity: "id-B", workspaceKey: "id-B" }, status: "running" },
  ]);
  assert.equal(mismatched[0]?.status, "completed");
  const offline = await overlayLiveRelayTaskStatus(tasks, async () => { throw Error("runtime unavailable"); });
  assert.equal(offline[0]?.status, "completed");
});
