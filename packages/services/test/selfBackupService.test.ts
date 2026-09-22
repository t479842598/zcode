import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import type { AppSettings } from "@zcode/shared";
import { createBackupService } from "../src/selfBackup/selfBackupService.js";
import type { SelfBackupSettings } from "../src/selfBackup/selfBackup.js";

const CREDENTIAL_KEY_SECRET = "selfbackup:oss:accessKeySecret";
const CREDENTIAL_KEY_PASSPHRASE = "selfbackup:encryption:passphrase";

interface UploadCall {
  url: string;
  method: string;
  objectKey: string;
  contentLength: number;
}

function createHarness(options: {
  selfBackup: SelfBackupSettings;
  secrets?: Record<string, string>;
}) {
  const settings = { selfBackup: options.selfBackup } as unknown as AppSettings;
  const secrets = options.secrets ?? {
    [CREDENTIAL_KEY_SECRET]: "test-secret",
    [CREDENTIAL_KEY_PASSPHRASE]: "test-passphrase",
  };
  const uploads: UploadCall[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : String(input);
    const headers = new Headers((init?.headers as Record<string, string>) ?? {});
    const objectKey = decodeURIComponent(url.split(".com/")[1] ?? "");
    uploads.push({
      url,
      method: (init?.method as string) ?? "GET",
      objectKey,
      contentLength: Number(headers.get("content-length") ?? 0),
    });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      headers: new Headers({ etag: '"mock-etag"' }),
      text: async () => "",
    } as unknown as Response;
  };

  const service = createBackupService({
    settingService: {
      get: async () => settings,
      update: async () => {},
      updateDataBaseDir: async () => {},
      ensureDefaultProject: async () => ({ path: "", created: false }),
    },
    credentialService: {
      load: async (key: string) => secrets[key] ?? null,
      save: async (key: string, value: string) => {
        secrets[key] = value;
      },
      delete: async (key: string) => {
        delete secrets[key];
      },
    },
    tmpDir: undefined,
    fetchImpl,
    logger: { info: () => {}, error: () => {} },
  });

  return { service, uploads, settings, secrets };
}

const baseConfig: SelfBackupSettings = {
  enabled: true,
  oss: {
    accessKeyId: "LTAI5tTest",
    bucket: "my-bucket",
    endpoint: "https://oss-cn-hangzhou.aliyuncs.com",
    prefix: "backups/demo",
  },
  encryption: { mode: "aes-256-ctr" },
  schedule: { intervalSeconds: 0, maxSnapshots: 50 },
  filter: { includeGitDir: true, includeGitLfs: true },
};

async function makeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "self-backup-ws-"));
  await mkdir(join(root, ".git", "objects"), { recursive: true });
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, ".git", "HEAD"), "ref: refs/heads/main\n");
  await writeFile(join(root, "src", "index.ts"), "export const a = 1;\n");
  await writeFile(join(root, "README.md"), "# demo\n");
  return root;
}

test("backupNow：未启用时抛错，不产生上传", async () => {
  const { service, uploads } = createHarness({ selfBackup: { ...baseConfig, enabled: false } });
  await assert.rejects(() => service.backupNow({ workspacePath: "/tmp/nope" }), /备份未启用/);
  assert.equal(uploads.length, 0);
});

test("backupNow：配置不完整时抛错并列出缺失项", async () => {
  const { service } = createHarness({
    selfBackup: { ...baseConfig, oss: { accessKeyId: "LTAI5tTest", bucket: "", endpoint: "" } },
  });
  await assert.rejects(
    () => service.backupNow({ workspacePath: "/tmp/nope" }),
    /备份配置不完整：缺少 Bucket 名称；缺少 OSS Endpoint/,
  );
});

test("backupNow：完整链路——扫描含 .git、加密上传 3 个对象、清理临时文件", async () => {
  const root = await makeWorkspace();
  const { service, uploads } = createHarness({ selfBackup: baseConfig });
  try {
    const result = await service.backupNow({ workspacePath: root, workspaceIdentity: "ws-1" });

    assert.equal(result.kind, "baseline");
    assert.equal(result.encrypted, true);
    // 三个文件：.git/HEAD、README.md、src/index.ts
    assert.equal(result.fileCount, 3);
    assert.ok(result.totalBytes > 0);
    assert.ok(result.archiveSizeBytes > 0);
    assert.match(result.ossObjectKey ?? "", /^backups\/demo\/[0-9a-f-]{36}\/backup\.tar\.gz\.enc$/);
    assert.ok((result.ossObjectKey ?? "").includes(result.snapshotId));

    // envelope.json + manifest.json + backup.tar.gz.enc
    assert.equal(uploads.length, 3);
    const keys = uploads.map((u) => u.objectKey).sort();
    assert.deepEqual(keys, [
      `backups/demo/${result.snapshotId}/backup.tar.gz.enc`,
      `backups/demo/${result.snapshotId}/envelope.json`,
      `backups/demo/${result.snapshotId}/manifest.json`,
    ]);
    for (const upload of uploads) {
      assert.equal(upload.method, "PUT");
      assert.ok(upload.url.startsWith("https://my-bucket.oss-cn-hangzhou.aliyuncs.com/"));
      assert.ok(upload.contentLength > 0);
    }

    // 本地临时文件已清理
    const leftover = (await readdir(tmpdir())).filter((name) => name.startsWith("backup-"));
    assert.deepEqual(leftover, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("backupNow：不加密模式只上传 manifest 与归档", async () => {
  const root = await makeWorkspace();
  const { service, uploads } = createHarness({
    selfBackup: { ...baseConfig, encryption: { mode: "none" } },
  });
  try {
    const result = await service.backupNow({ workspacePath: root });
    assert.equal(result.encrypted, false);
    assert.equal(uploads.length, 2);
    assert.ok(uploads.some((u) => u.objectKey.endsWith("manifest.json")));
    assert.ok(uploads.some((u) => u.objectKey.endsWith("backup.tar.gz")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("getStatus：按凭证与结构化配置判定 configured", async () => {
  const complete = createHarness({ selfBackup: baseConfig });
  assert.deepEqual(await complete.service.getStatus(), {
    configured: true,
    enabled: true,
    intervalSeconds: 0,
  });

  const missingSecret = createHarness({ selfBackup: baseConfig, secrets: {} });
  assert.equal((await missingSecret.service.getStatus()).configured, false);

  const missingPassphrase = createHarness({
    selfBackup: baseConfig,
    secrets: { [CREDENTIAL_KEY_SECRET]: "test-secret" },
  });
  assert.equal((await missingPassphrase.service.getStatus()).configured, false);

  const noEncryption = createHarness({
    selfBackup: { ...baseConfig, encryption: { mode: "none" } },
    secrets: { [CREDENTIAL_KEY_SECRET]: "test-secret" },
  });
  assert.equal((await noEncryption.service.getStatus()).configured, true);
});

test("reloadSchedule：接受工作区并静默重排定时器（interval=0 不启动）", async () => {
  const { service } = createHarness({ selfBackup: baseConfig });
  await service.reloadSchedule({ workspacePath: "/tmp/ws", workspaceIdentity: "ws" });
  service.dispose();
});

test("OSS 上传失败时抛出错误且不残留本地临时文件", async () => {
  const root = await makeWorkspace();
  const failingFetch: typeof fetch = async () =>
    ({
      ok: false,
      status: 403,
      statusText: "Forbidden",
      headers: new Headers(),
      text: async () => "<Error>AccessDenied</Error>",
    }) as unknown as Response;
  const service = createBackupService({
    settingService: {
      get: async () => ({ selfBackup: baseConfig }) as unknown as AppSettings,
      update: async () => {},
      updateDataBaseDir: async () => {},
      ensureDefaultProject: async () => ({ path: "", created: false }),
    },
    credentialService: {
      load: async (key: string) =>
        key === CREDENTIAL_KEY_SECRET
          ? "test-secret"
          : key === CREDENTIAL_KEY_PASSPHRASE
            ? "test-passphrase"
            : null,
      save: async () => {},
      delete: async () => {},
    },
    fetchImpl: failingFetch,
    logger: { info: () => {}, error: () => {} },
  });
  try {
    await assert.rejects(
      () => service.backupNow({ workspacePath: root }),
      /OSS 上传失败: 403 Forbidden/,
    );
    const leftover = (await readdir(tmpdir())).filter((name) => name.startsWith("backup-"));
    assert.deepEqual(leftover, []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
