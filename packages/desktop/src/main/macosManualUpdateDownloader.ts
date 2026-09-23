/**
 * macOS 未签名构建的自研更新下载器。
 *
 * 为什么不能复用 electron-updater 的 downloadUpdate：
 * MacUpdater.doDownloadUpdate 在下载完成时**立刻**把 zip 交给 nativeUpdater(Squirrel.Mac)，
 * Squirrel 强制校验代码签名，未签名构建在 0.8 秒内就抛 `SQRLCodeSignatureErrorDomain`，
 * 并把 ready 状态清成 idle —— 调用方的 quitAndInstall 分支根本走不到。实测日志：
 *
 *   downloaded: 3.14.3, ready to install on quit or explicit install
 *   error: {"code":-1,"domain":"SQRLCodeSignatureErrorDomain"}   ← 同一秒
 *   cleared ready update after error
 *
 * 所以这里自己按 manifest 的 files[].url 下载（GitHub Releases 直链），
 * 下载完只落到缓存目录、不碰 Squirrel，安装交给 macosManualUpdateInstaller。
 */
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface DownloadProgress {
  transferred: number;
  total: number;
  percent: number;
  bytesPerSecond: number;
}

export interface DownloadManifestArtifactParams {
  /** manifest 里该平台 zip 的绝对 URL */
  url: string;
  /** 期望的 sha512（base64，来自 manifest；用于完整性校验） */
  sha512?: string | null;
  /** 期望字节数 */
  size?: number | null;
  /** 落盘路径（最终文件名） */
  destination: string;
  onProgress?: (progress: DownloadProgress) => void;
  /**
   * 下载实现。**生产环境必须传 Electron 的 `net.fetch`**：
   * 它走 Chromium 网络栈、遵循系统代理；而 Node 自带的 fetch(undici) 不走代理，
   * 实测直连 GitHub 只有 ~4.5KB/s，会直接超时（electron-updater 用的就是 net，所以能到 10MB/s）。
   */
  fetchImpl?: typeof fetch;
}

/**
 * 把任意抛出物转成可读错误。
 * Electron 主进程里 fetch 失败往往抛的是非 Error（或 message 为空的 DOMException），
 * 直接 `{}` 进日志会让线上问题没法定位。
 */
export function describeDownloadError(error: unknown): Error {
  if (error instanceof Error && error.message) return error;
  const cause = (error as { cause?: unknown } | null)?.cause;
  const detail = [
    (error as { name?: string } | null)?.name,
    (error as { message?: string } | null)?.message,
    cause instanceof Error ? `cause: ${cause.message}` : typeof cause === "string" ? `cause: ${cause}` : undefined,
    (error as { code?: string } | null)?.code,
  ]
    .filter((part): part is string => typeof part === "string" && part.length > 0)
    .join(" | ");
  return new Error(detail || `下载失败：${String(error)}`);
}

/** 下载到 `destination`，先写 `.part` 再原子改名，避免中断留下半个包 */
export async function downloadManifestArtifact(
  params: DownloadManifestArtifactParams,
): Promise<{ path: string; bytes: number }> {
  const { url, destination, onProgress } = params;
  const fetchImpl = params.fetchImpl ?? fetch;
  const partPath = `${destination}.part`;

  await mkdir(dirname(destination), { recursive: true });
  await rm(partPath, { force: true });

  const response = await (async () => {
    try {
      return await fetchImpl(url, { redirect: "follow" });
    } catch (error) {
      throw describeDownloadError(error);
    }
  })();
  if (!response.ok || !response.body) {
    throw new Error(`下载更新包失败：HTTP ${response.status} ${url}`);
  }

  const total = Number(response.headers.get("content-length") ?? 0) || (params.size ?? 0);
  let transferred = 0;
  const startedAt = Date.now();
  let lastEmit = 0;

  const source = Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]);
  source.on("data", (chunk: Buffer) => {
    transferred += chunk.length;
    const now = Date.now();
    // 进度事件最多每 200ms 一次：渲染层按百分比渲染，发太密只是徒增 IPC
    if (!onProgress || now - lastEmit < 200) return;
    lastEmit = now;
    const elapsed = Math.max(0.001, (now - startedAt) / 1000);
    onProgress({
      transferred,
      total,
      percent: total > 0 ? Math.min(100, (transferred / total) * 100) : 0,
      bytesPerSecond: transferred / elapsed,
    });
  });

  try {
    await pipeline(source, createWriteStream(partPath));
    await rename(partPath, destination);
  } catch (error) {
    await rm(partPath, { force: true }).catch(() => {});
    throw error;
  }

  const actual = (await stat(destination)).size;
  if (params.size && actual !== params.size) {
    await rm(destination, { force: true }).catch(() => {});
    throw new Error(`更新包大小不符：期望 ${params.size}，实际 ${actual}`);
  }
  if (onProgress) {
    const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
    onProgress({
      transferred: actual,
      total: actual,
      percent: 100,
      bytesPerSecond: actual / elapsed,
    });
  }
  return { path: destination, bytes: actual };
}

/** 未签名构建的 zip 缓存目录（与 electron-updater 的 updaterCacheDirName 区分开，避免互相干扰） */
export function resolveManualUpdateCacheDir(homeDir: string, appName = "zcode-manual-updater"): string {
  return join(homeDir, "Library", "Caches", appName);
}

/** 从下载 URL 里取文件名（manifest 的 files[].url 末段） */
export function resolveArtifactFileName(url: string): string {
  const clean = url.split("?")[0] ?? url;
  const name = clean.slice(clean.lastIndexOf("/") + 1);
  return name.length > 0 ? name : "update.zip";
}
