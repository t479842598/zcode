/**
 * ponytail: oxlint max-lines 豁免——扫描/打包/加密/签名同属一条备份管线，
 * 拆散会割裂数据流且需跨 5 个文件追踪；天花板 = 400 行风格约束，
 * 升级路径：按域拆 engine/ossSign/selfCrypt 三文件（约 300/130/140 行）。
 */
/* oxlint-disable eslint(max-lines) */

/**
 * 备份引擎：工作区扫描 → tar.gz（PAX 长名）→ 自持加密（可选）→ OSS V4 签名直传
 *
 * 算法移植自 kuoniya/ZCode-Rev（Apache-2.0）repo-snapshot 模块：
 * tar/PAX 结构与原始 ZCode v3.12.3 反编译产物一致；加密为 PBKDF2-SHA256(100k)
 * 派生 AES-256-CTR，密文格式 [16B salt][16B IV][密文]，用户凭密码可自行解密；
 * OSS 用 V4 签名（HMAC-SHA256, UNSIGNED-PAYLOAD）PUT 直传用户 Bucket。
 * 仅依赖 node 标准库（fs/crypto/zlib），零新依赖。
 */

import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import {
  createHash,
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
  pbkdf2Sync,
} from "node:crypto";
import { createGzip } from "node:zlib";
import { basename, dirname, join, relative } from "node:path";
import { pipeline } from "node:stream/promises";
import type { Writable } from "node:stream";

// ── 常量（与 ZCode-Rev / 原始 ZCode 反编译产物一致）──

const TAR_BLOCK_SIZE = 512;
const PAX_HEADER_PREFIX = "PaxHeaders/";
const AES_KEY_BYTES = 32;
const AES_IV_BYTES = 16;
const AES_ALGORITHM = "aes-256-ctr";
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = "sha256";
const SALT_BYTES = 16;

// ── 配置解析 ──

export interface ResolvedOssConfig {
  accessKeyId: string;
  accessKeySecret: string;
  bucket: string;
  endpoint: string;
  prefix: string;
}

export interface ResolvedBackupConfig {
  enabled: boolean;
  oss: ResolvedOssConfig;
  encryptionMode: "aes-256-ctr" | "none";
  passphrase: string;
  intervalSeconds: number;
  maxSnapshots: number;
  includeGitDir: boolean;
  includeGitLfs: boolean;
  maxFileSizeBytes: number;
}

const DEFAULT_EXCLUDE_DIRS = new Set([
  "node_modules",
  ".cache",
  ".next",
  ".turbo",
  ".venv",
  "venv",
  "__pycache__",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "coverage",
]);

export function validateBackupConfig(config: {
  oss: ResolvedOssConfig;
  encryptionMode: "aes-256-ctr" | "none";
  passphrase: string;
}): string[] {
  const errors: string[] = [];
  if (!config.oss.accessKeyId.trim()) errors.push("缺少 AccessKeyId");
  if (!config.oss.accessKeySecret.trim()) errors.push("缺少 AccessKeySecret");
  if (!config.oss.bucket.trim()) errors.push("缺少 Bucket 名称");
  if (!config.oss.endpoint.trim()) errors.push("缺少 OSS Endpoint");
  if (config.encryptionMode === "aes-256-ctr" && !config.passphrase.trim()) {
    errors.push("加密模式为 AES-256-CTR 时必须填写加密密码");
  }
  return errors;
}

// ── 工作区扫描 ──

export interface ScannedFile {
  path: string;
  sizeBytes: number;
}

function shouldExcludeDir(name: string, includeGitDir: boolean): boolean {
  if (name === ".git") return !includeGitDir;
  return DEFAULT_EXCLUDE_DIRS.has(name);
}

function matchesExcludedFile(path: string): boolean {
  // ponytail: 朴素后缀/精确名过滤，覆盖日志、临时文件、DS_Store；需要 glob 语义时换 ignore 库
  const name = path.split("/").pop() ?? "";
  return name === ".DS_Store" || name.endsWith(".log") || name.endsWith(".swp");
}

export async function scanWorkspace(
  rootPath: string,
  opts: { includeGitDir: boolean; includeGitLfs: boolean; maxFileSizeBytes: number },
  signal?: AbortSignal,
): Promise<ScannedFile[]> {
  const files: ScannedFile[] = [];

  async function walk(dirPath: string, inGitDir: boolean): Promise<void> {
    signal?.throwIfAborted();
    let entries;
    try {
      entries = await readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      signal?.throwIfAborted();
      const fullPath = join(dirPath, entry.name);
      const relPath = relative(rootPath, fullPath).replaceAll("\\", "/");
      if (entry.isDirectory()) {
        if (inGitDir) {
          // .git 内部：只按 LFS 开关过滤
          if (entry.name === "lfs" && !opts.includeGitLfs) continue;
        } else if (shouldExcludeDir(entry.name, opts.includeGitDir)) {
          continue;
        }
        await walk(fullPath, inGitDir || entry.name === ".git");
      } else if (entry.isFile()) {
        if (!inGitDir && matchesExcludedFile(relPath)) continue;
        try {
          const fileStat = await stat(fullPath);
          if (fileStat.size > opts.maxFileSizeBytes) continue;
          files.push({ path: relPath, sizeBytes: fileStat.size });
        } catch {
          // 跳过无法 stat 的文件（权限/竞态删除）
        }
      }
    }
  }

  await walk(rootPath, false);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// ── manifest ──

export interface BackupManifest {
  schema: string;
  createdAt: string;
  files: ScannedFile[];
  stats: { includedFileCount: number; includedBytes: number };
}

export function buildManifest(files: ScannedFile[], createdAt: string): BackupManifest {
  return {
    schema: "self_backup_manifest/v1",
    createdAt,
    files,
    stats: {
      includedFileCount: files.length,
      includedBytes: files.reduce((sum, f) => sum + f.sizeBytes, 0),
    },
  };
}

export function computeManifestHash(manifest: BackupManifest): string {
  return createHash("sha256")
    .update(JSON.stringify(manifest, null, 2))
    .digest("hex");
}

export function buildDelta(
  baseManifest: BackupManifest,
  baseManifestHash: string,
  nextManifest: BackupManifest,
  nextManifestHash: string,
): {
  schema: string;
  baseManifestHash: string;
  nextManifestHash: string;
  addedOrModified: ScannedFile[];
  deleted: string[];
} {
  const baseMap = new Map(baseManifest.files.map((f) => [f.path, f]));
  const nextMap = new Map(nextManifest.files.map((f) => [f.path, f]));
  const addedOrModified = nextManifest.files
    .filter((f) => {
      const base = baseMap.get(f.path);
      return !base || base.sizeBytes !== f.sizeBytes;
    })
    .sort((a, b) => a.path.localeCompare(b.path));
  const deleted = baseManifest.files
    .filter((f) => !nextMap.has(f.path))
    .map((f) => f.path)
    .sort((a, b) => a.localeCompare(b));
  return {
    schema: "self_backup_delta/v1",
    baseManifestHash,
    nextManifestHash,
    addedOrModified,
    deleted,
  };
}

// ── tar.gz 打包（PAX 长名支持；结构与 ZCode-Rev 一致）──

export interface TarEntry {
  path: string;
  content?: Buffer;
  absolutePath?: string;
  sizeBytes: number;
}

export function normalizeTarPath(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!normalized || normalized.split("/").some((seg) => !seg || seg === "..")) {
    throw new Error(`备份归档路径非法: ${path}`);
  }
  return normalized;
}

function normalizeTarPathForHeader(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

function fitsInStandardHeader(path: string): boolean {
  return Buffer.byteLength(path, "utf-8") <= 100;
}

function createPaxRecord(keyword: string, value: string): Buffer {
  const content = `${keyword}=${value}\n`;
  const prefix = `${content.length + String(content.length).length + 1} `;
  const record = `${prefix.length + content.length} ${content}`;
  return Buffer.from(record, "utf-8");
}

function createPaxPathHeader(
  entry: TarEntry,
  index: number,
): { path: string; content: Buffer; sizeBytes: number } | null {
  const normalized = normalizeTarPathForHeader(entry.path);
  if (fitsInStandardHeader(normalized)) return null;
  const content = createPaxRecord("path", normalized);
  return { path: `${PAX_HEADER_PREFIX}${index}`, content, sizeBytes: content.byteLength };
}

function buildTarHeaderBuffer(
  entry: { path: string; sizeBytes: number },
  opts?: { typeFlag?: string },
): Buffer {
  const header = Buffer.alloc(TAR_BLOCK_SIZE);
  const path = normalizeTarPathForHeader(entry.path);
  header.write(path.slice(0, 100), 0, 100, "utf-8");
  header.write("0000644\0", 100, 8, "utf-8");
  header.write("0001000\0", 108, 8, "utf-8");
  header.write("0001000\0", 116, 8, "utf-8");
  header.write(entry.sizeBytes.toString(8).padStart(11, "0") + "\0", 124, 12, "utf-8");
  header.write(
    Math.floor(Date.now() / 1000)
      .toString(8)
      .padStart(11, "0") + "\0",
    136,
    12,
    "utf-8",
  );
  header.write(opts?.typeFlag ?? "0", 156, 1, "utf-8");
  header.write("ustar\0", 257, 6, "utf-8");
  header.write("00", 263, 2, "utf-8");
  header.fill(0x20, 148, 156);
  let checksum = 0;
  for (let i = 0; i < TAR_BLOCK_SIZE; i++) checksum += header[i]!;
  header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148, 8, "utf-8");
  return header;
}

function waitForStreamDrain(stream: Writable): Promise<void> {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      stream.off("drain", onDrain);
      stream.off("error", onError);
      stream.off("close", onClose);
    };
    const onDrain = () => {
      cleanup();
      resolve();
    };
    const onError = (err: Error) => {
      cleanup();
      reject(err);
    };
    const onClose = () => {
      cleanup();
      reject(new Error("备份 gzip 流提前关闭"));
    };
    stream.once("drain", onDrain);
    stream.once("error", onError);
    stream.once("close", onClose);
  });
}

async function writeTarFileEntry(
  stream: Writable,
  entry: TarEntry & { absolutePath: string },
): Promise<void> {
  const beforeStat = await stat(entry.absolutePath);
  const sized = { ...entry, sizeBytes: beforeStat.size };
  stream.write(buildTarHeaderBuffer(sized)) || (await waitForStreamDrain(stream));
  let bytesWritten = 0;
  const readable = createReadStream(entry.absolutePath);
  try {
    for await (const chunk of readable) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      bytesWritten += buf.byteLength;
      stream.write(buf) || (await waitForStreamDrain(stream));
    }
  } finally {
    readable.destroy();
  }
  const afterStat = await stat(entry.absolutePath);
  if (bytesWritten !== beforeStat.size || afterStat.size !== beforeStat.size) {
    throw new Error(`备份打包时文件发生变化: ${entry.path}`);
  }
  const remainder = (TAR_BLOCK_SIZE - (beforeStat.size % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
  if (remainder > 0) stream.write(Buffer.alloc(remainder)) || (await waitForStreamDrain(stream));
}

async function writeTarBufferEntry(
  stream: Writable,
  entry: TarEntry & { content: Buffer },
): Promise<void> {
  stream.write(buildTarHeaderBuffer(entry)) || (await waitForStreamDrain(stream));
  stream.write(entry.content) || (await waitForStreamDrain(stream));
  const remainder = (TAR_BLOCK_SIZE - (entry.sizeBytes % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
  if (remainder > 0) stream.write(Buffer.alloc(remainder)) || (await waitForStreamDrain(stream));
}

async function writeTarEntry(stream: Writable, entry: TarEntry, index: number): Promise<void> {
  const pax = createPaxPathHeader(entry, index);
  if (pax) {
    // PAX 扩展头条目：typeflag "x"，内容为 path 记录
    stream.write(buildTarHeaderBuffer(pax, { typeFlag: "x" })) ||
      (await waitForStreamDrain(stream));
    stream.write(pax.content) || (await waitForStreamDrain(stream));
    const paxRemainder = (TAR_BLOCK_SIZE - (pax.sizeBytes % TAR_BLOCK_SIZE)) % TAR_BLOCK_SIZE;
    if (paxRemainder > 0)
      stream.write(Buffer.alloc(paxRemainder)) || (await waitForStreamDrain(stream));
  }
  const effective = pax ? { ...entry, path: `${PAX_HEADER_PREFIX}${index}.data` } : entry;
  if ("content" in effective && effective.content) {
    await writeTarBufferEntry(stream, effective as TarEntry & { content: Buffer });
  } else {
    await writeTarFileEntry(stream, effective as TarEntry & { absolutePath: string });
  }
}

export async function writeGzipTar(
  entries: TarEntry[],
  outputPath: string,
  opts: { signal?: AbortSignal } = {},
): Promise<void> {
  opts.signal?.throwIfAborted();
  await mkdir(dirname(outputPath), { recursive: true });
  const tmpPath = `${outputPath}.tmp-${process.pid}-${Date.now()}`;
  const fileStream = createWriteStream(tmpPath);
  const gzipStream = createGzip();

  const abort = () => {
    gzipStream.destroy();
    fileStream.destroy();
  };
  opts.signal?.addEventListener("abort", abort, { once: true });
  gzipStream.pipe(fileStream);

  const finished = new Promise<void>((resolve, reject) => {
    fileStream.on("finish", resolve);
    fileStream.on("error", reject);
    gzipStream.on("error", reject);
  });
  finished.catch(() => {});

  try {
    for (const [index, entry] of entries.entries()) {
      opts.signal?.throwIfAborted();
      await writeTarEntry(gzipStream, entry, index);
    }
    // tar 结束标记：1024 字节零填充
    gzipStream.end(Buffer.alloc(1024));
    await finished;
    await rename(tmpPath, outputPath);
  } catch (err) {
    gzipStream.unpipe(fileStream);
    gzipStream.destroy();
    fileStream.destroy();
    await rm(tmpPath, { force: true }).catch(() => {});
    throw err;
  } finally {
    opts.signal?.removeEventListener("abort", abort);
  }
}

// ── 自持加密（用户凭密码可解密）──

async function sha256File(filePath: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash("sha256");
  return new Promise((resolve, reject) => {
    const stream = createReadStream(filePath, { signal });
    stream.on("data", (chunk: Buffer) => hash.update(chunk));
    stream.on("error", reject);
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

function deriveKey(passphrase: string, salt: Buffer): Buffer {
  return pbkdf2Sync(passphrase, salt, PBKDF2_ITERATIONS, AES_KEY_BYTES, PBKDF2_DIGEST);
}

export interface SelfEncryptedArtifact {
  encryptedPath: string;
  envelopePath: string;
  plaintextSha256: string;
  encryptedSizeBytes: number;
}

export async function selfEncryptArchive(opts: {
  plaintextPath: string;
  encryptedPath: string;
  envelopePath: string;
  passphrase: string;
  signal?: AbortSignal;
}): Promise<SelfEncryptedArtifact> {
  await mkdir(dirname(opts.encryptedPath), { recursive: true });
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(AES_IV_BYTES);
  const aesKey = deriveKey(opts.passphrase, salt);
  opts.signal?.throwIfAborted();

  const plaintextSha256 = await sha256File(opts.plaintextPath, opts.signal);
  const cipher = createCipheriv(AES_ALGORITHM, aesKey, iv);
  // 密文格式 [16B salt][16B IV][密文]：解密侧凭头部即可用密码重新派生密钥
  const output = createWriteStream(opts.encryptedPath);
  await new Promise<void>((resolve, reject) => {
    output.write(Buffer.concat([salt, iv]), (err) => (err ? reject(err) : resolve()));
  });
  await pipeline(createReadStream(opts.plaintextPath, { signal: opts.signal }), cipher, output);

  const envelope = {
    format: "self-backup-v1",
    algorithm: AES_ALGORITHM,
    kdf: "pbkdf2-sha256",
    kdfIterations: PBKDF2_ITERATIONS,
    saltHex: salt.toString("hex"),
    ivHex: iv.toString("hex"),
    plaintextSha256,
  };
  await writeFile(opts.envelopePath, JSON.stringify(envelope, null, 2), "utf-8");

  return {
    encryptedPath: opts.encryptedPath,
    envelopePath: opts.envelopePath,
    plaintextSha256,
    encryptedSizeBytes: (await stat(opts.encryptedPath)).size,
  };
}

export async function selfDecryptArchive(opts: {
  encryptedPath: string;
  outputPath: string;
  passphrase: string;
  signal?: AbortSignal;
}): Promise<{ outputPath: string; plaintextSha256: string }> {
  await mkdir(dirname(opts.outputPath), { recursive: true });
  const needed = SALT_BYTES + AES_IV_BYTES;
  const header = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    const stream = createReadStream(opts.encryptedPath, { start: 0, end: needed - 1 });
    stream.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
      total += chunk.length;
    });
    stream.on("error", reject);
    stream.on("end", () => {
      if (total < needed) {
        reject(new Error("加密文件头部不完整"));
        return;
      }
      resolve(Buffer.concat(chunks));
    });
  });
  const salt = header.subarray(0, SALT_BYTES);
  const iv = header.subarray(SALT_BYTES, needed);
  const aesKey = deriveKey(opts.passphrase, salt);
  await pipeline(
    createReadStream(opts.encryptedPath, { start: needed, signal: opts.signal }),
    createDecipheriv(AES_ALGORITHM, aesKey, iv),
    createWriteStream(opts.outputPath),
  );
  return {
    outputPath: opts.outputPath,
    plaintextSha256: await sha256File(opts.outputPath, opts.signal),
  };
}

// ── 阿里云 OSS V4 签名客户端 ──

export function sha256Hex(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

export function getDateStrings(): { dateStamp: string; dateTime: string } {
  const now = new Date();
  return {
    dateStamp: now.toISOString().slice(0, 10).replace(/-/g, ""),
    dateTime: now
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d+Z$/, "Z"),
  };
}

export function extractRegionFromEndpoint(endpoint: string): string {
  return endpoint.match(/oss-([a-z0-9-]+)\./)?.[1] ?? "cn-hangzhou";
}

export function buildObjectKey(prefix: string, snapshotId: string, filename: string): string {
  const cleanPrefix = prefix.replace(/\/+$/, "");
  return [cleanPrefix, snapshotId, filename].filter(Boolean).join("/");
}

export function buildOssAuthorization(opts: {
  method: string;
  host: string;
  objectKey: string;
  region: string;
  accessKeyId: string;
  accessKeySecret: string;
  dateStamp: string;
  dateTime: string;
  contentSha256: string;
  contentType: string;
}): Record<string, string> {
  const scope = `${opts.dateStamp}/${opts.region}/oss/aliyun_v4_request`;
  const headers: Record<string, string> = {
    host: opts.host,
    "x-oss-date": opts.dateTime,
    "x-oss-content-sha256": opts.contentSha256,
  };
  if (opts.contentType) headers["content-type"] = opts.contentType;

  const sortedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = sortedHeaderNames.map((name) => `${name}:${headers[name]}\n`).join("");
  const signedHeaders = sortedHeaderNames.join(";");

  const canonicalRequest = [
    opts.method,
    `/${opts.objectKey}`,
    "",
    canonicalHeaders,
    signedHeaders,
    opts.contentSha256,
  ].join("\n");

  const stringToSign = ["OSS4-HMAC-SHA256", opts.dateTime, scope, sha256Hex(canonicalRequest)].join(
    "\n",
  );

  const dateKey = hmacSha256(`aliyun_v4${opts.accessKeySecret}`, opts.dateStamp);
  const regionKey = hmacSha256(dateKey, opts.region);
  const serviceKey = hmacSha256(regionKey, "oss");
  const signingKey = hmacSha256(serviceKey, "aliyun_v4_request");
  const signature = hmacSha256(signingKey, stringToSign).toString("hex");

  return {
    ...headers,
    Authorization:
      `OSS4-HMAC-SHA256 ` +
      `Credential=${opts.accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, ` +
      `Signature=${signature}`,
  };
}
