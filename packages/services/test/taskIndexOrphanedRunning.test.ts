/**
 * 启动对账：清掉上次进程遗留的 running 任务状态。
 *
 * 背景（2026-09-23）：中继网页里有一条 9.7 天前就已结束的对话一直显示「正在运行」。
 * 根因是会话跑到终态时由 zcodeTaskIndexSyncer.applyTerminalTransition 把 status 收敛成
 * completed/error，而进程被杀（崩溃/强退）时这一步不会执行，状态就永久停在 running。
 *
 * ⚠️ 关键坑：状态存两处 —— `task_status` 标量列 与 `meta_json.status`，而 rowToMeta
 * **以 meta_json 为权威**（标量列只覆盖 taskId/workspace/identity/unreadAt/cron/offPeak/
 * titleOverridden，不含 status）。第一版对账只清了列，结果被 meta_json 里的旧 running
 * 盖回来，手机端照样显示运行中。所以这里必须覆盖「只有 meta_json 是 running」的用例。
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

interface SeedRow {
  id: string;
  /** task_status 标量列 */
  status: string | null;
  /** meta_json.status（rowToMeta 的权威来源）；undefined = 不写该键 */
  metaStatus?: string | null;
  updatedAt: number;
}

/** 用真实 schema 建库（让 repo 自己跑迁移），再塞入指定状态的行 */
async function seed(path: string, rows: SeedRow[]) {
  const repo = new TaskIndexRepo(path);
  await repo.ensureReady();
  repo.close();

  const db = new DatabaseSync(path);
  for (const row of rows) {
    const meta: Record<string, unknown> = {
      taskId: row.id,
      traceId: `trace-${row.id}`,
      title: `task ${row.id}`,
      workspacePath: "/w",
      createdAt: 1000,
      updatedAt: row.updatedAt,
      mode: "build",
    };
    if (row.metaStatus !== undefined && row.metaStatus !== null) meta["status"] = row.metaStatus;
    db.prepare(
      `INSERT INTO tasks (workspace_key, workspace_path, task_id, title, task_status, mode, created_at, updated_at, meta_json)
       VALUES ('/w', '/w', ?, ?, ?, 'build', 1000, ?, ?)`,
    ).run(row.id, `task ${row.id}`, row.status, row.updatedAt, JSON.stringify(meta));
  }
  db.close();
}

interface RowState {
  status: string | null;
  metaStatus: unknown;
  updatedAt: number;
  title: string;
}

function readRows(path: string): Map<string, RowState> {
  const db = new DatabaseSync(path);
  const out = new Map<string, RowState>();
  for (const row of db.prepare("SELECT * FROM tasks").all()) {
    let metaStatus: unknown;
    try {
      metaStatus = (JSON.parse(String(row["meta_json"] ?? "{}")) as { status?: unknown }).status;
    } catch {
      metaStatus = "<unparsable>";
    }
    out.set(String(row["task_id"]), {
      status: row["task_status"] === null ? null : String(row["task_status"]),
      metaStatus,
      updatedAt: Number(row["updated_at"]),
      title: String(row["title"]),
    });
  }
  db.close();
  return out;
}

/** 打开一次索引库 = 模拟一次进程启动 */
async function restart(path: string): Promise<void> {
  const repo = new TaskIndexRepo(path);
  await repo.ensureReady();
  repo.close();
}

test("启动时同时清掉列与 meta_json 里的 running，且不动终态/未知态", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-index-orphan-"));
  const path = join(dir, "tasks-index.sqlite");
  try {
    await seed(path, [
      // 列与 meta_json 都是 running（真实崩溃残留的形状）
      { id: "both-running", status: "running", metaStatus: "running", updatedAt: 111 },
      // ⚠️ 只有 meta_json 是 running：第一版对账就是漏了这种，被它盖回来
      { id: "meta-only-running", status: null, metaStatus: "running", updatedAt: 112 },
      { id: "done", status: "completed", metaStatus: "completed", updatedAt: 222 },
      { id: "failed", status: "error", metaStatus: "error", updatedAt: 333 },
      { id: "unknown", status: null, metaStatus: null, updatedAt: 444 },
    ]);

    await restart(path);

    const after = readRows(path);
    assert.equal(after.get("both-running")!.status, null, "列里的 running 应被清");
    assert.equal(after.get("both-running")!.metaStatus, undefined, "meta_json 里的 running 也应被清");
    assert.equal(after.get("meta-only-running")!.metaStatus, undefined, "只有 meta_json 是 running 时也必须清");
    assert.equal(after.get("both-running")!.updatedAt, 111, "清理不应改动 updated_at（否则列表会重排）");
    assert.equal(after.get("both-running")!.title, "task both-running", "不应破坏 meta_json 其它字段");
    assert.equal(after.get("done")!.status, "completed", "completed 不能被改");
    assert.equal(after.get("done")!.metaStatus, "completed", "completed 的 meta_json 不能被改");
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
    await seed(path, [
      { id: "both-running", status: "running", metaStatus: "running", updatedAt: 111 },
      { id: "meta-only-running", status: null, metaStatus: "running", updatedAt: 112 },
    ]);

    await restart(path);
    const afterFirst = readRows(path);
    await restart(path);
    const afterSecond = readRows(path);

    assert.deepEqual(afterSecond, afterFirst, "第二次启动不应再改动任何行");
    assert.equal(afterSecond.get("both-running")!.status, null);
    assert.equal(afterSecond.get("meta-only-running")!.metaStatus, undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("运行中写入的 running 不会被同进程内的后续 ensureReady 误清", async () => {
  const dir = await mkdtemp(join(tmpdir(), "task-index-orphan-"));
  const path = join(dir, "tasks-index.sqlite");
  try {
    await seed(path, [{ id: "live", status: null, metaStatus: null, updatedAt: 111 }]);

    // 进程内：先启动（对账跑完），随后才把任务置为 running
    const repo = new TaskIndexRepo(path);
    await repo.ensureReady();

    const db = new DatabaseSync(path);
    db.prepare("UPDATE tasks SET task_status = 'running' WHERE task_id = 'live'").run();
    db.close();

    // 同一实例再 ensureReady（不会重跑 initialize），running 必须保留
    await repo.ensureReady();
    repo.close();

    assert.equal(readRows(path).get("live")!.status, "running", "同进程内的 running 不该被清");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
