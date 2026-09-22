/**
 * 自助备份 host 服务
 *
 * 组合引擎调用链（扫描 → 打包 → 加密 → 上传），配置来自
 * settingService（结构化字段）+ credentialService（秘密字段）。
 * 增量基线为进程内 Map；进程重启后回落 baseline（正确性不受损）。
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import type { ISettingService, ICredentialService } from "../index.js";
import {
  type IBackupService,
  type SelfBackupResult,
  type SelfBackupSettings,
  type SelfBackupStatus,
} from "./selfBackup.js";
import {
  type ResolvedBackupConfig,
  buildDelta,
  buildManifest,
  buildObjectKey,
  computeManifestHash,
  scanWorkspace,
  selfEncryptArchive,
  validateBackupConfig,
  writeGzipTar,
} from "./engine.js";
import { deleteObjectsByPrefix, uploadObject } from "./ossTransport.js";

const CREDENTIAL_KEY_SECRET = "selfbackup:oss:accessKeySecret";
const CREDENTIAL_KEY_PASSPHRASE = "selfbackup:encryption:passphrase";
const DEFAULT_MAX_FILE_SIZE_BYTES = 100 * 1024 * 1024;
const DEFAULT_MAX_SNAPSHOTS = 50;

export interface BackupServiceOptions {
  settingService: ISettingService;
  credentialService: ICredentialService;
  /** 临时文件目录；缺省系统 tmp */
  tmpDir?: string;
  /** 测试注入 */
  fetchImpl?: typeof fetch;
  logger?: {
    info: (msg: string, data?: unknown) => void;
    error: (msg: string, data?: unknown) => void;
  };
}

interface SnapshotHistoryEntry {
  snapshotId: string;
  objectPrefix: string;
}

export function createBackupService(
  options: BackupServiceOptions,
): IBackupService & { dispose(): void } {
  const { settingService, credentialService } = options;
  const log = options.logger ?? { info: () => {}, error: () => {} };
  const transport = { fetchImpl: options.fetchImpl };

  // 进程内增量基线与快照历史（按 workspaceKey 隔离）
  const baseManifestByWorkspace = new Map<
    string,
    { manifest: ReturnType<typeof buildManifest>; hash: string }
  >();
  const snapshotHistory: SnapshotHistoryEntry[] = [];
  let intervalTimer: ReturnType<typeof setInterval> | undefined;
  let lastWorkspace: { path: string; identity?: string } | null = null;

  async function loadConfig(): Promise<ResolvedBackupConfig> {
    const settings = await settingService.get();
    const selfBackup = (settings as { selfBackup?: SelfBackupSettings }).selfBackup ?? {};
    const accessKeySecret = (await credentialService.load(CREDENTIAL_KEY_SECRET)) ?? "";
    const passphrase = (await credentialService.load(CREDENTIAL_KEY_PASSPHRASE)) ?? "";
    return {
      enabled: selfBackup.enabled === true,
      oss: {
        accessKeyId: selfBackup.oss?.accessKeyId ?? "",
        accessKeySecret,
        bucket: selfBackup.oss?.bucket ?? "",
        endpoint: selfBackup.oss?.endpoint ?? "",
        prefix: selfBackup.oss?.prefix ?? "",
      },
      encryptionMode: selfBackup.encryption?.mode ?? "aes-256-ctr",
      passphrase,
      intervalSeconds: selfBackup.schedule?.intervalSeconds ?? 0,
      maxSnapshots: selfBackup.schedule?.maxSnapshots ?? DEFAULT_MAX_SNAPSHOTS,
      includeGitDir: selfBackup.filter?.includeGitDir ?? true,
      includeGitLfs: selfBackup.filter?.includeGitLfs ?? true,
      maxFileSizeBytes: DEFAULT_MAX_FILE_SIZE_BYTES,
    };
  }

  async function getStatus(): Promise<SelfBackupStatus> {
    const config = await loadConfig();
    return {
      configured:
        Boolean(
          config.oss.accessKeyId &&
          config.oss.accessKeySecret &&
          config.oss.bucket &&
          config.oss.endpoint,
        ) && validateBackupConfig(config).length === 0,
      enabled: config.enabled,
      intervalSeconds: config.intervalSeconds,
    };
  }

  /** interval 定时备份：用最近一次手动/定时备份的工作区 */
  function syncIntervalTimer(config: ResolvedBackupConfig): void {
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = undefined;
    }
    if (config.enabled && config.intervalSeconds > 0 && lastWorkspace) {
      // ponytail: 定时器内闭持最近工作区，切换工作区需重新保存设置才会生效；多工作区轮询后续按需加
      intervalTimer = setInterval(() => {
        if (!lastWorkspace) return;
        void backupNow({
          workspacePath: lastWorkspace.path,
          workspaceIdentity: lastWorkspace.identity,
        }).catch((err) => {
          log.error("定时备份失败", { error: err instanceof Error ? err.message : String(err) });
        });
      }, config.intervalSeconds * 1000);
      intervalTimer.unref?.();
    }
  }

  async function runBackup(
    config: ResolvedBackupConfig,
    input: { workspacePath: string; workspaceIdentity?: string },
  ): Promise<SelfBackupResult> {
    const startTime = Date.now();
    const snapshotId = randomUUID();
    const workspaceKey = input.workspaceIdentity?.trim() || input.workspacePath;
    const createdAt = new Date().toISOString();
    const tmpDir = options.tmpDir ?? join(tmpdir(), "zcode-self-backup");
    const tmpPaths: string[] = [];

    try {
      // 1. 扫描工作区
      log.info("备份: 扫描工作区", { workspaceKey });
      const files = await scanWorkspace(input.workspacePath, {
        includeGitDir: config.includeGitDir,
        includeGitLfs: config.includeGitLfs,
        maxFileSizeBytes: config.maxFileSizeBytes,
      });
      const manifest = buildManifest(files, createdAt);
      const manifestHash = computeManifestHash(manifest);

      // 2. 增量判定
      const base = baseManifestByWorkspace.get(workspaceKey);
      const kind: "baseline" | "increment" = base ? "increment" : "baseline";
      const delta = base ? buildDelta(base.manifest, base.hash, manifest, manifestHash) : undefined;

      // 3. 确定打包文件
      const filesToPack =
        kind === "increment" && delta
          ? delta.addedOrModified.map((f) => ({
              path: f.path,
              absolutePath: join(input.workspacePath, f.path),
              sizeBytes: f.sizeBytes,
            }))
          : files.map((f) => ({
              path: f.path,
              absolutePath: join(input.workspacePath, f.path),
              sizeBytes: f.sizeBytes,
            }));

      // 4. 构建 tar.gz（meta/prompt.json + meta/manifest.json [+ delta.json] + files/）
      const archivePath = join(tmpDir, `backup-${snapshotId}.tar.gz`);
      tmpPaths.push(archivePath);
      const entries = [
        {
          path: `${snapshotId}/meta/prompt.json`,
          content: Buffer.from(
            JSON.stringify({ schema: "self-backup/v1", createdAt, kind }, null, 2),
            "utf-8",
          ),
          sizeBytes: 0,
        },
        {
          path: `${snapshotId}/meta/manifest.json`,
          content: Buffer.from(JSON.stringify(manifest, null, 2), "utf-8"),
          sizeBytes: 0,
        },
        ...(delta
          ? [
              {
                path: `${snapshotId}/meta/delta.json`,
                content: Buffer.from(JSON.stringify(delta, null, 2), "utf-8"),
                sizeBytes: 0,
              },
            ]
          : []),
        ...filesToPack.map((f) => ({
          path: `${snapshotId}/files/${f.path}`,
          absolutePath: f.absolutePath,
          sizeBytes: f.sizeBytes,
        })),
      ].map((e) => ("content" in e ? { ...e, sizeBytes: e.content.byteLength } : e));
      await writeGzipTar(entries, archivePath);

      // 5. 上传（可选加密）
      // objectPrefix 必须带尾斜杠：buildObjectKey 在 filename 为空时会滤掉尾段，
      // 否则拼接出 "<snapshotId>backup.tar.gz.enc" 这类粘在一起的错误对象键。
      const objectPrefix = `${buildObjectKey(config.oss.prefix, snapshotId, "")}/`;
      let uploadPath = archivePath;
      let uploadFilename = "backup.tar.gz";
      let encrypted = false;
      let archiveSizeBytes = (await stat(archivePath)).size;

      if (config.encryptionMode === "aes-256-ctr") {
        log.info("备份: AES-256-CTR 加密（用户自持密码）");
        const encryptedPath = join(tmpDir, `backup-${snapshotId}.tar.gz.enc`);
        const envelopePath = join(tmpDir, `backup-${snapshotId}.envelope.json`);
        tmpPaths.push(encryptedPath, envelopePath);
        await selfEncryptArchive({
          plaintextPath: archivePath,
          encryptedPath,
          envelopePath,
          passphrase: config.passphrase,
        });
        uploadPath = encryptedPath;
        uploadFilename = "backup.tar.gz.enc";
        encrypted = true;
        archiveSizeBytes = (await stat(encryptedPath)).size;
        await uploadObject(
          config,
          {
            localPath: envelopePath,
            objectKey: `${objectPrefix}envelope.json`,
            contentType: "application/json",
          },
          transport,
        );
      }

      // manifest.json 始终明文上传（无敏感内容，用于快速浏览备份内容）
      const manifestPath = join(tmpDir, `backup-${snapshotId}.manifest.json`);
      tmpPaths.push(manifestPath);
      await writeFile(manifestPath, JSON.stringify(manifest, null, 2), "utf-8");
      await uploadObject(
        config,
        {
          localPath: manifestPath,
          objectKey: `${objectPrefix}manifest.json`,
          contentType: "application/json",
        },
        transport,
      );

      log.info("备份: 上传到用户 OSS", { bucket: config.oss.bucket });
      const objectKey = `${objectPrefix}${uploadFilename}`;
      await uploadObject(
        config,
        {
          localPath: uploadPath,
          objectKey,
          contentType: "application/octet-stream",
        },
        transport,
      );

      // 6. 更新基线与历史
      baseManifestByWorkspace.set(workspaceKey, { manifest, hash: manifestHash });
      snapshotHistory.push({ snapshotId, objectPrefix });
      await pruneOldSnapshots(config.maxSnapshots, config);

      const result: SelfBackupResult = {
        snapshotId,
        kind,
        fileCount: files.length,
        totalBytes: manifest.stats.includedBytes,
        archiveSizeBytes,
        encrypted,
        ossObjectKey: objectKey,
        durationMs: Date.now() - startTime,
      };
      log.info("备份: 完成", result);
      return result;
    } finally {
      // 清理本地临时文件（成功失败都清）
      for (const p of tmpPaths) {
        await rm(p, { force: true }).catch(() => {});
      }
    }
  }

  /** 超出上限时从最旧的快照开始删（删除失败只记日志，不影响本次备份结果） */
  async function pruneOldSnapshots(
    maxSnapshots: number,
    config: ResolvedBackupConfig,
  ): Promise<void> {
    while (snapshotHistory.length > maxSnapshots) {
      const oldest = snapshotHistory.shift();
      if (!oldest) break;
      try {
        await deleteObjectsByPrefix(config, oldest.objectPrefix, transport);
      } catch (err) {
        log.error("备份: 清理旧快照失败", {
          snapshotId: oldest.snapshotId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  async function backupNow(input: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<SelfBackupResult> {
    const config = await loadConfig();
    if (!config.enabled) {
      throw new Error("备份未启用：请先在设置中开启");
    }
    const errors = validateBackupConfig(config);
    if (errors.length > 0) {
      throw new Error(`备份配置不完整：${errors.join("；")}`);
    }
    lastWorkspace = { path: input.workspacePath, identity: input.workspaceIdentity };
    try {
      return await runBackup(config, input);
    } finally {
      syncIntervalTimer(config);
    }
  }

  async function reloadSchedule(input?: {
    workspacePath?: string;
    workspaceIdentity?: string;
  }): Promise<void> {
    if (input?.workspacePath) {
      lastWorkspace = { path: input.workspacePath, identity: input.workspaceIdentity };
    }
    const config = await loadConfig();
    syncIntervalTimer(config);
  }

  // 设置变化后同步定时器（读一次当前配置即可；interval 改动保存后下次 backupNow 也会重排）
  void loadConfig()
    .then(syncIntervalTimer)
    .catch(() => {});

  return {
    getStatus,
    backupNow,
    reloadSchedule,
    dispose() {
      if (intervalTimer) {
        clearInterval(intervalTimer);
        intervalTimer = undefined;
      }
      baseManifestByWorkspace.clear();
      snapshotHistory.length = 0;
    },
  };
}
