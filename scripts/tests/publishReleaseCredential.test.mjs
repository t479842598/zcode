import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const source = readFileSync(new URL("../publish-release.mjs", import.meta.url), "utf8");

test("发布凭据只可由环境变量提供，缺失时拒绝上传", () => {
  assert.match(source, /process\.env\.ZCODE_RELEASE_SSH_PASS\?\.trim\(\) \?\? ""/);
  assert.match(source, /if \(!SSH_PASS\) throw new Error/);
  assert.doesNotMatch(source, /ZCODE_RELEASE_SSH_PASS \?\? "[^"]+"/);
});
