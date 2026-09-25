import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../src/WorkspaceSidebarFooter.tsx", import.meta.url), "utf8");

test("移动远控入口紧邻侧栏底部设置按钮，头像菜单不重复显示", () => {
  const footerActions = source.indexOf('<div className="flex shrink-0 items-center gap-1.5">');
  const remote = source.indexOf('data-testid="web-remote-control-button"');
  const settings = source.indexOf("TID_TASK_SETTINGS_BUTTON", footerActions);
  assert.ok(footerActions >= 0 && footerActions < remote && remote < settings);
  assert.ok(source.includes("isDesktop && workspacePath"));
  assert.ok(!source.includes('data-testid="web-remote-control-menu-item"'));
});
