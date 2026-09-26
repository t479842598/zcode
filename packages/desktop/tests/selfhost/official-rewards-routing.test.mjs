import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../../../..", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("official rewards entry stays on the official origin and injects account context", async () => {
  const endpoint = await read("packages/shared/src/zcodeEndpoint.ts");
  const preload = await read("packages/desktop/src/preload/rewardsWebview.ts");
  const ui = await read("packages/ui/src/settings/OfficialRewardsSection.tsx");
  assert.match(endpoint, /DEFAULT_ZCODE_REWARDS_ORIGIN/);
  assert.match(endpoint, /\/cn\/rewards/);
  assert.match(endpoint, /embedded.*app/);
  assert.match(preload, /isTrustedRewardsWebviewOrigin/);
  assert.match(preload, /zcode-rewards-context/);
  assert.match(ui, /oauth:zai:access_token/);
  assert.match(ui, /oauth:bigmodel:access_token/);
  assert.match(ui, /zcodejwttoken/);
  assert.match(ui, /credentialService\.load/);
});

test("desktop webview build includes a dedicated rewards preload", async () => {
  const tsup = await read("packages/desktop/tsup.config.ts");
  const chrome = await read("packages/desktop/src/main/desktopWindowChrome.ts");
  assert.match(tsup, /preload\/rewardsWebview/);
  assert.match(chrome, /rewardsWebviewPreloadPath/);
  assert.match(chrome, /isRewardsEmbeddedWebviewSrc/);
});
