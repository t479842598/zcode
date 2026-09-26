import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { collectBuildMetadata } from "../../scripts/build-metadata.mjs";

test("selfhost patch release is newer than the installed official 3.14.3 target", async () => {
  const root = new URL("../../../../package.json", import.meta.url);
  const pkg = JSON.parse(await readFile(root, "utf8"));
  assert.equal(pkg.version, "3.14.6");
  assert.equal(collectBuildMetadata().appVersion, pkg.version);
  const publish = await readFile(
    new URL("../../../../scripts/publish-release.mjs", import.meta.url),
    "utf8",
  );
  assert.match(publish, /ZCODE_RELEASE_GITHUB_REPO/);
  assert.match(publish, /github\.com\/\$\{GITHUB_REPO\}\/releases\/download/);
  assert.doesNotMatch(publish, /const GITHUB_REPO =[^\n]*"zai-org\//);
});
