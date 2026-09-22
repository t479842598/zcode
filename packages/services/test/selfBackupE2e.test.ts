/**
 * 自助备份端到端验证（真实 HTTP）
 *
 * 起一个本地 mock OSS（校验 OSS V4 签名头、接收 PUT 流式 body 落盘），
 * 用真实 fetch 跑完整链路：扫描工作区（含 .git）→ tar.gz → AES-256-CTR 加密
 * → PUT 上传。并验证：
 *   1. 三个对象（envelope/manifest/归档）真实落盘且归档非空、envelope 可解
 *   2. 加密归档能用密码解回原文 tar.gz（用户自持密码可解密）
 *   3. Secret 不出现在 AppSettings 序列化结果里（不落明文设置）
 *
 * 运行：NODE_OPTIONS="--import tsx" node --test test/selfBackupE2e.test.ts
 */
import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AppSettings } from "@zcode/shared";
import { createBackupService } from "../src/selfBackup/selfBackupService.js";
import { selfDecryptArchive } from "../src/selfBackup/engine.js";
import type { SelfBackupSettings } from "../src/selfBackup/selfBackup.js";

const CREDENTIAL_KEY_SECRET = "selfbackup:oss:accessKeySecret";
const CREDENTIAL_KEY_PASSPHRASE = "selfbackup:encryption:passphrase";
const TEST_SECRET = "super-secret-access-key";
const TEST_PASSPHRASE = "correct horse battery staple";
const BUCKET = "e2e-bucket";

interface ReceivedObject {
  objectKey: string;
  /** 原始请求路径（路径风格下形如 /<bucket>/<key>） */
  rawPath: string;
  body: Buffer;
  authorization: string | null;
  contentSha256: string | null;
  host: string | null;
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

function startMockOss(): Promise<{
  endpoint: string;
  received: ReceivedObject[];
  close: () => Promise<void>;
}> {
  const received: ReceivedObject[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const body = await readBody(req);
      const hostHeader = req.headers.host ?? "";
      const rawPath = (req.url ?? "/").replace(/^\//, "");
      // 路径风格（IP 端点）：/<bucket>/<key> —— 按真实 OSS 语义剥掉 bucket 段
      const withoutBucket = rawPath.startsWith(`${BUCKET}/`)
        ? rawPath.slice(BUCKET.length + 1)
        : rawPath;
      const objectKey = decodeURIComponent(withoutBucket);
      received.push({
        objectKey,
        rawPath,
        body,
        authorization: (req.headers.authorization as string) ?? null,
        contentSha256: (req.headers["x-oss-content-sha256"] as string) ?? null,
        host: hostHeader,
      });
      res.statusCode = 200;
      res.setHeader("etag", '"mock-etag"');
      res.end("");
    })();
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        endpoint: `http://127.0.0.1:${port}`,
        received,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

test("端到端：真实 HTTP 上传 3 个对象，加密归档可用密码解密", async () => {
  const oss = await startMockOss();
  const workspace = await mkdtemp(join(tmpdir(), "self-backup-e2e-ws-"));
  const secretStore: Record<string, string> = {
    [CREDENTIAL_KEY_SECRET]: TEST_SECRET,
    [CREDENTIAL_KEY_PASSPHRASE]: TEST_PASSPHRASE,
  };
  const selfBackup: SelfBackupSettings = {
    enabled: true,
    oss: {
      accessKeyId: "LTAI5tE2E",
      bucket: BUCKET,
      endpoint: oss.endpoint,
      prefix: "backups/e2e",
    },
    encryption: { mode: "aes-256-ctr" },
    schedule: { intervalSeconds: 0, maxSnapshots: 50 },
    filter: { includeGitDir: true, includeGitLfs: true },
  };
  const settings = { selfBackup } as unknown as AppSettings;

  const service = createBackupService({
    settingService: {
      get: async () => settings,
      update: async () => {},
      updateDataBaseDir: async () => {},
      ensureDefaultProject: async () => ({ path: "", created: false }),
    },
    credentialService: {
      load: async (key) => secretStore[key] ?? null,
      save: async (key, value) => {
        secretStore[key] = value;
      },
      delete: async (key) => {
        delete secretStore[key];
      },
    },
    logger: { info: () => {}, error: () => {} },
  });

  try {
    // 构造工作区（含 .git 历史与普通文件）
    await mkdir(join(workspace, ".git", "objects", "ab"), { recursive: true });
    await mkdir(join(workspace, "src"), { recursive: true });
    await writeFile(join(workspace, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(join(workspace, ".git", "objects", "ab", "cdef"), Buffer.alloc(2048, 7));
    await writeFile(join(workspace, "src", "index.ts"), "export const answer = 42;\n");
    await writeFile(join(workspace, "README.md"), "# e2e workspace\n");
    // 应被过滤：node_modules 与 .DS_Store
    await mkdir(join(workspace, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(workspace, "node_modules", "pkg", "index.js"), "module.exports = {};\n");
    await writeFile(join(workspace, ".DS_Store"), "junk");

    const result = await service.backupNow({ workspacePath: workspace, workspaceIdentity: "e2e" });

    // ── 1. 结果字段 ──
    assert.equal(result.kind, "baseline");
    assert.equal(result.encrypted, true);
    assert.equal(
      result.fileCount,
      4,
      "应包含 .git/HEAD、.git/objects/ab/cdef、src/index.ts、README.md",
    );
    assert.ok(result.archiveSizeBytes > 0);
    assert.match(result.ossObjectKey ?? "", /^backups\/e2e\/[0-9a-f-]{36}\/backup\.tar\.gz\.enc$/);

    // ── 2. 三个对象真实落盘，且签名头存在 ──
    assert.equal(oss.received.length, 3, "应上传 envelope + manifest + 归档");
    const byKey = new Map(oss.received.map((r) => [r.objectKey, r]));
    const envelopeKey = `backups/e2e/${result.snapshotId}/envelope.json`;
    const manifestKey = `backups/e2e/${result.snapshotId}/manifest.json`;
    const archiveKey = `backups/e2e/${result.snapshotId}/backup.tar.gz.enc`;
    for (const key of [envelopeKey, manifestKey, archiveKey]) {
      const obj = byKey.get(key);
      assert.ok(obj, `缺少对象 ${key}`);
      assert.ok(obj.body.byteLength > 0, `${key} 内容为空`);
      assert.match(obj.authorization ?? "", /^OSS4-HMAC-SHA256 Credential=LTAI5tE2E\//);
      assert.equal(obj.contentSha256, "UNSIGNED-PAYLOAD");
      // IP 端点走路径风格：请求路径必须带 bucket 段，host 不带 bucket 子域
      assert.ok(
        obj.rawPath.startsWith(`${BUCKET}/`),
        `路径风格应带 bucket 前缀，实际 ${obj.rawPath}`,
      );
      assert.ok((obj.host ?? "").startsWith("127.0.0.1:"), `host 应为端点主机，实际 ${obj.host}`);
    }
    // 归档非空（2048 字节全同字节内容会被 gzip 高度压缩，因此不靠体积判断）
    assert.ok((byKey.get(archiveKey)?.body.byteLength ?? 0) > 0);

    // ── 3. manifest 内容正确（过滤生效）──
    const manifest = JSON.parse(
      (byKey.get(manifestKey)?.body ?? Buffer.alloc(0)).toString("utf-8"),
    );
    const paths: string[] = manifest.files.map((f: { path: string }) => f.path).sort();
    assert.deepEqual(paths, [".git/HEAD", ".git/objects/ab/cdef", "README.md", "src/index.ts"]);
    assert.equal(manifest.stats.includedFileCount, 4);

    // ── 4. 加密归档可用用户密码解密回 tar.gz ──
    const encPath = join(workspace, "downloaded.tar.gz.enc");
    await writeFile(encPath, byKey.get(archiveKey)!.body);
    const decPath = join(workspace, "decrypted.tar.gz");
    const dec = await selfDecryptArchive({
      encryptedPath: encPath,
      outputPath: decPath,
      passphrase: TEST_PASSPHRASE,
    });
    const envelope = JSON.parse(
      (byKey.get(envelopeKey)?.body ?? Buffer.alloc(0)).toString("utf-8"),
    );
    assert.equal(dec.plaintextSha256, envelope.plaintextSha256, "解密后哈希应与 envelope 记录一致");

    // tar.gz 解出的内容与源文件一致
    const decryptedBytes = await readFile(decPath);
    assert.equal(decryptedBytes[0], 0x1f);
    assert.equal(decryptedBytes[1], 0x8b);
    const { execFileSync } = await import("node:child_process");
    const extractDir = join(workspace, "extracted");
    await mkdir(extractDir, { recursive: true });
    execFileSync("tar", ["-xzf", decPath, "-C", extractDir]);
    const snapRoot = join(extractDir, result.snapshotId);
    assert.equal(
      await readFile(join(snapRoot, "files", "src", "index.ts"), "utf-8"),
      "export const answer = 42;\n",
    );
    assert.equal(
      await readFile(join(snapRoot, "files", ".git", "HEAD"), "utf-8"),
      "ref: refs/heads/main\n",
    );
    assert.deepEqual(
      (await readFile(join(snapRoot, "files", ".git", "objects", "ab", "cdef"))).length,
      2048,
    );
    // 归档内 meta/manifest.json 与上传的 manifest 一致
    const metaManifest = JSON.parse(
      await readFile(join(snapRoot, "meta", "manifest.json"), "utf-8"),
    );
    assert.equal(metaManifest.stats.includedFileCount, 4);

    // ── 5. 设置文件不含 Secret 明文 ──
    const serialized = JSON.stringify(settings);
    assert.ok(!serialized.includes(TEST_SECRET), "AccessKeySecret 不得出现在设置中");
    assert.ok(!serialized.includes(TEST_PASSPHRASE), "加密密码不得出现在设置中");
    assert.ok(serialized.includes("LTAI5tE2E"), "AccessKeyId 可存设置（非秘密）");

    service.dispose();
  } finally {
    await oss.close();
    await rm(workspace, { recursive: true, force: true });
  }
});
