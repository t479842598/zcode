import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { isConcurrencyOnlyAmend } from "../../../apps/zcode-cli/packages/core/src/tool/handlers/amend-workflow-retune.js";
import { reduceRunCapsChanged } from "../../shared/src/zcode-protocol-v4/workflow-runs-concurrency.js";

const read = (file: string) => readFileSync(new URL(file, import.meta.url), "utf8");

test("A: 在飞并发调整与脚本修订分路，升至天花板移除自定义限制", () => {
  assert.equal(isConcurrencyOnlyAmend({ run_id: "r", max_concurrency: 3 } as never), true);
  assert.equal(isConcurrencyOnlyAmend({ run_id: "r", max_concurrency: 3, script: "changed" } as never), false);
  const run = { status: "running", concurrencyCeiling: 6, concurrency: { cap: 6, ceiling: 6 } } as never;
  const lowered = reduceRunCapsChanged(run, { caps: { maxConcurrency: 3 }, concurrencyCeiling: 6 });
  assert.equal(lowered.concurrency?.limit, 3);
  const raised = reduceRunCapsChanged(lowered, { caps: { maxConcurrency: 6 }, concurrencyCeiling: 6 });
  assert.equal(raised.concurrency?.limit, undefined);
});

test("B: 修订续跑、卡片稳定性恢复路径仍存在", () => {
  assert.match(read("../../../apps/zcode-cli/packages/bootstrap/src/app/dynamic-workflow-run-retune.ts"), /setMaxConcurrency/);
  assert.match(read("../src/components/workflow-timeline/workflowRunSettings.ts"), /concurrencyLive/);
  assert.match(read("../src/components/workflow-timeline/WorkflowTruncatedNotice.tsx"), /WorkflowTruncatedNotice/);
});

test("C: 大流程名册和投影使用有界表外参与者", () => {
  assert.match(read("../src/components/workflow-timeline/roster-model.ts"), /unlisted\.actors/);
  assert.match(read("../src/components/workflow-timeline/roster-model.ts"), /ROSTER_PINS_CARD/);
  assert.match(read("../../../apps/zcode-cli/packages/bootstrap/src/app/workflow-driver-submit-bridge.ts"), /export/);
});

test("D: 保存、列表、历史、实例图及续跑的现有入口完整", () => {
  const service = read("../../services/src/zcode-agent/zcodeAgent.ts");
  for (const name of ["listSavedWorkflows", "getSavedWorkflow", "updateSavedWorkflowMeta", "moveSavedWorkflow"]) assert.match(service, new RegExp(name));
  assert.match(read("../src/settings/saved-workflows/SavedWorkflowRunHistoryPanel.tsx"), /RunHistory/);
  assert.match(read("../../../apps/zcode-cli/packages/dynamic-workflow-runtime/src/harness.ts"), /resumedFrom/);
});
