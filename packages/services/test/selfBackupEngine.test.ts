import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  buildDelta,
  buildManifest,
  buildOssAuthorization,
  computeManifestHash,
  normalizeTarPath,
  scanWorkspace,
  selfDecryptArchive,
  selfEncryptArchive,
  writeGzipTar,
  type TarEntry,
} from "../src/selfBackup/engine.js";

async function makeTmp(): Promise<string> {
  return mkdtemp(join(tmpdir(), "self-backup-test-"));
}

test("normalizeTarPath 拒绝路径遍历与空路径", () => {
  assert.equal(normalizeTarPath("a/b/c"), "a/b/c");
  assert.equal(normalizeTarPath("/abs/path"), "abs/path");
  assert.equal(normalizeTarPath("a\\b"), "a/b");
  assert.throws(() => normalizeTarPath("../escape"));
  assert.throws(() => normalizeTarPath("a/../.."));
  assert.throws(() => normalizeTarPath(""));
});

test("scanWorkspace 尊重 git/lfs/排除目录与大小上限", async () => {
  const root = await makeTmp();
  try {
    await mkdir(join(root, ".git", "lfs", "objects"), { recursive: true });
    await mkdir(join(root, "node_modules", "pkg"), { recursive: true });
    await mkdir(join(root, "src"), { recursive: true });
    await writeFile(join(root, ".git", "config"), "gitconfig");
    await writeFile(join(root, ".git", "lfs", "objects", "oid"), "lfsdata");
    await writeFile(join(root, "node_modules", "pkg", "index.js"), "nm");
    await writeFile(join(root, "src", "main.ts"), "console.log(1)");
    await writeFile(join(root, ".DS_Store"), "junk");
    const bigPath = join(root, "src", "big.bin");

    // 不含 .git
    const withoutGit = await scanWorkspace(root, {
      includeGitDir: false,
      includeGitLfs: false,
      maxFileSizeBytes: 1024,
    });
    const pathsWithout = withoutGit.map((f) => f.path).sort();
    assert.deepEqual(pathsWithout, ["src/main.ts"]);

    // 含 .git 不含 lfs
    const withGit = await scanWorkspace(root, {
      includeGitDir: true,
      includeGitLfs: false,
      maxFileSizeBytes: 1024,
    });
    const pathsWith = withGit.map((f) => f.path).sort();
    assert.deepEqual(pathsWithout.length, 1);
    assert.ok(pathsWith.includes(".git/config"));
    assert.ok(!pathsWith.includes(".git/lfs/objects/oid"));

    // 含 lfs + 大小上限过滤
    await writeFile(bigPath, Buffer.alloc(2048));
    const withLimits = await scanWorkspace(root, {
      includeGitDir: true,
      includeGitLfs: true,
      maxFileSizeBytes: 1024,
    });
    assert.ok(!withLimits.some((f) => f.path === "src/big.bin"));
    assert.ok(withGit.length >= 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("manifest 哈希稳定且 delta 计算正确", () => {
  const files = [
    { path: "a.txt", sizeBytes: 1 },
    { path: "b.txt", sizeBytes: 2 },
  ];
  const m1 = buildManifest(files, "2026-01-01T00:00:00.000Z");
  const m2 = buildManifest([...files], "2026-01-01T00:00:00.000Z");
  assert.equal(computeManifestHash(m1), computeManifestHash(m2));

  const next = buildManifest(
    [
      { path: "a.txt", sizeBytes: 1 },
      { path: "b.txt", sizeBytes: 3 }, // 修改
      { path: "c.txt", sizeBytes: 5 }, // 新增
    ],
    "2026-01-02T00:00:00.000Z",
  );
  const delta = buildDelta(m1, computeManifestHash(m1), next, computeManifestHash(next));
  assert.deepEqual(delta.addedOrModified.map((f) => f.path).sort(), ["b.txt", "c.txt"]);
  assert.deepEqual(delta.deleted, []);
});

test("tar.gz 打包往返：多文件 + 长文件名（PAX）", async () => {
  const root = await makeTmp();
  try {
    const deepName = "very-long-directory-name".repeat(6); // > 100 字节触发 PAX
    const filePath = join(root, deepName, "file.txt");
    await mkdir(join(root, deepName), { recursive: true });
    await writeFile(filePath, "hello pax");
    const content = Buffer.from("buffer entry");

    const entries: TarEntry[] = [
      { path: "snap/meta/manifest.json", content, sizeBytes: content.byteLength },
      {
        path: `snap/files/${deepName}/file.txt`,
        absolutePath: filePath,
        sizeBytes: (await readFile(filePath)).byteLength,
      },
    ];
    const outPath = join(root, "out.tar.gz");
    await writeGzipTar(entries, outPath);

    // 用系统 tar 验证结构可解
    const { execFileSync } = await import("node:child_process");
    const extractDir = join(root, "extract");
    await mkdir(extractDir, { recursive: true });
    execFileSync("tar", ["-xzf", outPath, "-C", extractDir]);
    const extracted = await readFile(join(extractDir, `snap/files/${deepName}/file.txt`), "utf-8");
    assert.equal(extracted, "hello pax");
    const manifest = await readFile(join(extractDir, "snap/meta/manifest.json"), "utf-8");
    assert.equal(manifest, "buffer entry");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("自持加密往返：正确密码解出原文，错误密码得到不同明文", async () => {
  const root = await makeTmp();
  try {
    const plain = join(root, "plain.tar.gz");
    const payload = Buffer.from("secret-workspace-data".repeat(100));
    await writeFile(plain, payload);

    const encryptedPath = join(root, "plain.tar.gz.enc");
    const envelopePath = join(root, "envelope.json");
    const artifact = await selfEncryptArchive({
      plaintextPath: plain,
      encryptedPath,
      envelopePath,
      passphrase: "correct-horse",
    });
    assert.ok(artifact.encryptedSizeBytes > 0);

    // envelope 结构可读
    const envelope = JSON.parse(await readFile(envelopePath, "utf-8"));
    assert.equal(envelope.format, "self-backup-v1");
    assert.equal(envelope.kdf, "pbkdf2-sha256");
    assert.equal(envelope.plaintextSha256, artifact.plaintextSha256);

    // 正确密码解密
    const decryptedPath = join(root, "decrypted.tar.gz");
    const result = await selfDecryptArchive({
      encryptedPath,
      outputPath: decryptedPath,
      passphrase: "correct-horse",
    });
    assert.equal(result.plaintextSha256, artifact.plaintextSha256);
    const decrypted = await readFile(decryptedPath);
    assert.ok(decrypted.equals(payload));

    // 错误密码解密得到不同明文（CTR 无认证标签，只验证内容不同）
    const wrongPath = join(root, "wrong.tar.gz");
    await selfDecryptArchive({ encryptedPath, outputPath: wrongPath, passphrase: "wrong-pass" });
    const wrong = await readFile(wrongPath);
    assert.ok(!wrong.equals(payload));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OSS V4 签名：固定输入产生确定性 Authorization", () => {
  const headers = buildOssAuthorization({
    method: "PUT",
    host: "my-bucket.oss-cn-hangzhou.aliyuncs.com",
    objectKey: "backups/snap-1/backup.tar.gz.enc",
    region: "cn-hangzhou",
    accessKeyId: "LTAI5tExample",
    accessKeySecret: "secret-example",
    dateStamp: "20260922",
    dateTime: "20260922T120000Z",
    contentSha256: "UNSIGNED-PAYLOAD",
    contentType: "application/octet-stream",
  });
  assert.match(
    headers.Authorization,
    /^OSS4-HMAC-SHA256 Credential=LTAI5tExample\/20260922\/cn-hangzhou\/oss\/aliyun_v4_request/,
  );
  assert.match(
    headers.Authorization,
    /SignedHeaders=content-type;host;x-oss-content-sha256;x-oss-date/,
  );
  assert.match(headers.Authorization, /Signature=[0-9a-f]{64}$/);
  assert.equal(headers["x-oss-content-sha256"], "UNSIGNED-PAYLOAD");

  // 相同输入 → 相同签名；objectKey 变化 → 签名变化
  const again = buildOssAuthorization({
    method: "PUT",
    host: "my-bucket.oss-cn-hangzhou.aliyuncs.com",
    objectKey: "backups/snap-1/backup.tar.gz.enc",
    region: "cn-hangzhou",
    accessKeyId: "LTAI5tExample",
    accessKeySecret: "secret-example",
    dateStamp: "20260922",
    dateTime: "20260922T120000Z",
    contentSha256: "UNSIGNED-PAYLOAD",
    contentType: "application/octet-stream",
  });
  assert.equal(headers.Authorization, again.Authorization);
  const different = buildOssAuthorization({
    method: "PUT",
    host: "my-bucket.oss-cn-hangzhou.aliyuncs.com",
    objectKey: "backups/snap-2/backup.tar.gz.enc",
    region: "cn-hangzhou",
    accessKeyId: "LTAI5tExample",
    accessKeySecret: "secret-example",
    dateStamp: "20260922",
    dateTime: "20260922T120000Z",
    contentSha256: "UNSIGNED-PAYLOAD",
    contentType: "application/octet-stream",
  });
  assert.notEqual(headers.Authorization, different.Authorization);
});
