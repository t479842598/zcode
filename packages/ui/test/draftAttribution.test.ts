import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const draft = readFileSync(
  new URL("../src/v4/ConversationDraftEmptyState.tsx", import.meta.url),
  "utf8",
);
const attribution = readFileSync(
  new URL("../src/v4/ConversationDraftAttribution.tsx", import.meta.url),
  "utf8",
);

test("草稿欢迎态展示品牌和仓库链接，不出现在已建会话", () => {
  assert.match(draft, /<ConversationDraftAttribution\s*\/>/);
  assert.match(attribution, /Zcode_满血_青棠/);
  assert.match(attribution, /github\.com\/t479842598\/Zcode_Full/);
  assert.match(attribution, /（当前）/);
  assert.match(attribution, /ZCODE_VERSION/);
  assert.doesNotMatch(attribution, /LOCAL_REPOSITORY_PATH|openInFileManager/);
});
