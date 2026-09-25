import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  fetchOfficialReleaseInfo,
  OFFICIAL_RELEASE_SOURCE_URL,
  officialReleaseSourceUrl,
} from "../src/system/officialReleaseInfo.js";

const manifest = `version: 3.14.4\nreleaseDate: 2026-09-25T01:00:00Z\nreleaseNotes: default\nreleaseNotesByLocale:\n  zh-CN:\n    markdown: |\n      ## 新功能\n      - 安全展示\n`;

test("公开版本检查只发匿名 GET，读取中文更新说明", async () => {
  let requests = 0;
  const result = await fetchOfficialReleaseInfo({
    now: () => 123,
    fetchImpl: async (input, init) => {
      requests++;
      assert.equal(input, OFFICIAL_RELEASE_SOURCE_URL);
      assert.equal(init?.method, "GET");
      assert.equal(init?.credentials, "omit");
      assert.equal(init?.redirect, "error");
      assert.equal(new Headers(init?.headers).get("Authorization"), null);
      assert.equal(new Headers(init?.headers).get("X-Device-Mid"), null);
      return new Response(manifest, { status: 200 });
    },
  });
  assert.equal(requests, 1);
  assert.equal(result.version, "3.14.4");
  assert.match(result.releaseNotes, /新功能/);
  assert.equal(result.checkedAt, 123);
});

test("无说明保持空值，错误不能伪装成最新版", async () => {
  const empty = await fetchOfficialReleaseInfo({
    fetchImpl: async () => new Response("version: 3.14.3"),
  });
  assert.equal(empty.releaseNotes, "");
  await assert.rejects(
    fetchOfficialReleaseInfo({ fetchImpl: async () => new Response("oops", { status: 503 }) }),
    /503/,
  );
  await assert.rejects(
    fetchOfficialReleaseInfo({ fetchImpl: async () => new Response("version: invalid") }),
    /version/,
  );
});

test("官方桌面清单按实际平台选择，英文更新内容可读取", async () => {
  assert.match(officialReleaseSourceUrl("win32", "x64"), /platform=windows-x86_64/);
  assert.match(officialReleaseSourceUrl("linux", "arm64"), /platform=linux-aarch64/);
  const result = await fetchOfficialReleaseInfo({
    locale: "en-US",
    fetchImpl: async () =>
      new Response("version: 3.14.4\nreleaseNotesByLocale:\n  en-US:\n    markdown: Hello\n"),
  });
  assert.equal(result.releaseNotes, "Hello");
  assert.match(result.sourceUrl, /\/en\/changelog$/);
});
