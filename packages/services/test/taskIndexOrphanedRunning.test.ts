/**
 * 启动对账：清掉上次进程遗留的 running 任务状态。
 *
 * 背景（2026-09-23）：中继网页里有一条 9.7 天前就已结束的对话一直显示「正在运行」。
 * 根因是会话跑到终态时由 zcodeTaskIndexSyncer.applyTerminalTransition 把 status 收敛成
 * completed/error，而进程被杀（崩溃/强退）时这一步不会执行，task_status 就永久停在
 * running —— 手机端用 `displayStatus === "running"` 判断运行中，于是永远显示运行态。
 *
 * 跑法：cd upstream/packages/services && NODE_OPTIONS="--import tsx" node --test test/*.test.ts
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { TaskIndexRepo } from "../src/session/taskIndexRepo.js";

/** 用真实 schema 建库（让 repo 自己跑迁移），再塞入指定状态的行 */
async function seed(path: string, rows: Array<{ id: string; status: string | null; updatedAt: number }>) {
  const repo = new TaskIndexRepo(path);
  await repo.ensureReady();
  repo.close();

  const db = new DatabaseSync(path);
  for (const row of rows) {
    db.prepare(
      `INSERT INTO tasks (workspace_key, workspace_path, task_id, title, task_status, mode, created_at, updated_at)
       VALUES ('/w', '/w', ?, ?, ?, 'build', 1000, ?)`,
    ).run(row.id, `task ${row.id}`, row.status, row.updatedAt);
  }
  db.close();
}

function readStatuses(path: string): Map<string, { status: string | null; updatedAt: number }> {
  const db = new DatabaseSync(path);
  const out = new Map<string, { status: string | null; updatedAt: number }>();
  for (const row of db.prepare("SELECT task_id, task_status, updated_at FROM tasks").all()) {
    out.set(String(row["task_id"]), {
      status: row["task_status"] === null ? null : String(row["task_status"]),
      updatedAt: Number(row["updated_at"]),
    });
  }
  db.close();
  return out;
}

test("启动时清掉进程遗留的 running，且不动终态与未知态", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-index-orphan-"));
  const path = join(dir, "tasks-index.sqlite");
  try {
    await seed(path, [
      { id: "orphan-running", status: "running", updatedAt: 111 },
      { id: "done", status: "completed", updatedAt: 222 },
      { id: "failed", status: "error", updatedAt: 333 },
      { id: "unknown", status: null, updatedAt: 444 },
    ]);

    // 打开索引库 = 模拟一次进程启动
    const repo = new TaskIndexRepo(path);
    await repo.ensureReady();
    repo.close();

    const after = readStatuses(path);
    assert.equal(after.get("orphan-running")!.status, null, "遗留 running 应被清成 NULL（未知结果）");
    assert.equal(after.get("orphan-running")!.updatedAt, 111, "清理不应改动 updated_at（否则列表会重排）");
    assert.equal(after.get("done")!.status, "completed", "completed 不能被改");
    assert.equal(after.get("failed")!.status, "error", "error 不能被改");
    assert.equal(after.get("unknown")!.status, null, "未知态保持未知");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("对账是幂等的：再次启动不产生额外变化", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-index-orphan-"));
  const path = join(dir, "tasks-index.sqlite");
  try {
    await seed(path, [{ id: "orphan-running", status: "running", updatedAt: 111 }]);

    const first = new TaskIndexRepo(path);
    await first.ensureReady();
    first.close();
    const afterFirst = readStatuses(path);

    const second = new TaskIndexRepo(path);
    await second.ensureReady();
    second.close();
    const afterSecond = readStatuses(path);

    assert.deepEqual(afterSecond, afterFirst, "第二次启动不应再改动任何行");
    assert.equal(afterSecond.get("orphan-running")!.status, null);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("运行中写入的 running 不会被同进程内的后续 ensureReady 误清", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-index-orphan-"));
  const path = join(dir, "tasks-index.sqlite");
  try {
    await seed(path, [{ id: "live", status: null, updatedAt: 111 }]);

    // 进程内：先启动（对账跑完），随后才把任务置为 running
    const repo = new TaskIndexRepo(path);
    await repo.ensureReady();

    const db = new DatabaseSync(path);
    db.prepare("UPDATE tasks SET task_status = 'running' WHERE task_id = 'live'").run();
    db.close();

    // 同一实例再 ensureReady（不会重跑 initialize），running 必须保留
    await repo.ensureReady();
    repo.close();

    assert.equal(readStatuses(path).get("live")!.status, "running", "同进程内的 running 不该被清");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
