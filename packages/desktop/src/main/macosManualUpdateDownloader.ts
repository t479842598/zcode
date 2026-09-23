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
   * 下载实现注入点，**仅供测试**；生产不传，走下面的 `net.request`。
   * 保留它是为了让测试能在纯 Node 下跑，不必拉起 Electron。
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

/**
 * 用 Electron 的 net.request 下载（与 electron-updater 同一条网络栈，实测 10MB/s）。
 *
 * 为什么不用 net.fetch：实测在本项目 Electron 41 环境下 net.fetch 会直接卡住不返回数据
 * （.part 永远是 0 字节），而 electron-updater 用 net.request 能跑满带宽 ——
 * 两者虽同属 Chromium 网络栈但行为不同。
 * 也不用 Node 的 fetch(undici)：它不遵循系统代理，直连 GitHub 只有 0.14MB/s。
 *
 * `electron` 用动态 import：这个文件会被纯 Node 的测试直接加载，静态 import 会解析失败。
 */
async function downloadWithNetRequest(
  url: string,
  destination: string,
  onProgress: ((progress: DownloadProgress) => void) | undefined,
  expectedSize: number | null,
): Promise<number> {
  const { net } = await import("electron");
  return new Promise<number>((resolve, reject) => {
    const startedAt = Date.now();
    let transferred = 0;
    let lastEmit = 0;
    let total = expectedSize ?? 0;
    const file = createWriteStream(destination);
    let settled = false;

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      file.destroy();
      void rm(destination, { force: true }).catch(() => {});
      reject(describeDownloadError(error));
    };

    const finish = () => {
      if (settled) return;
      settled = true;
      file.end(() => {
        if (onProgress) {
          const elapsed = Math.max(0.001, (Date.now() - startedAt) / 1000);
          onProgress({ transferred, total: transferred, percent: 100, bytesPerSecond: transferred / elapsed });
        }
        resolve(transferred);
      });
    };

    // redirect 只能用 "follow"：net.request 不支持 "manual"，传 manual 会直接报 "Redirect was cancelled"。
    // GitHub Releases 会 302 到 objects.githubusercontent.com，交给 Chromium 自己跟。
    const request = net.request({ url, redirect: "follow" });
    request.on("response", (response) => {
      if (response.statusCode >= 400) {
        fail(new Error(`下载更新包失败：HTTP ${response.statusCode} ${url}`));
        return;
      }
      const declared = Number(response.headers["content-length"] ?? 0);
      if (declared > 0) total = declared;
      response.on("data", (chunk: Buffer) => {
        transferred += chunk.length;
        file.write(chunk);
        const now = Date.now();
        // 进度最多每 200ms 一次：渲染层按百分比渲染，发太密只是徒增 IPC
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
      response.on("end", finish);
      response.on("error", fail);
    });
    request.on("error", fail);
    request.end();

    file.on("error", fail);
  });
}

/** 测试用：从标准 Response 读流写盘（生产不走这里） */
async function downloadWithFetch(
  fetchImpl: typeof fetch,
  url: string,
  destination: string,
  onProgress: ((progress: DownloadProgress) => void) | undefined,
  expectedSize: number | null,
): Promise<number> {
  const startedAt = Date.now();
  let lastEmit = 0;
  let transferred = 0;
  const file = createWriteStream(destination);
  try {
    const response = await fetchImpl(url, { redirect: "follow" });
    if (!response.ok || !response.body) {
      throw new Error(`下载更新包失败：HTTP ${response.status} ${url}`);
    }
    const total = Number(response.headers.get("content-length") ?? 0) || (expectedSize ?? 0);
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      const buf = Buffer.from(chunk);
      transferred += buf.length;
      if (!file.write(buf)) await new Promise<void>((resolve) => file.once("drain", resolve));
      const now = Date.now();
      if (!onProgress || now - lastEmit < 200) continue;
      lastEmit = now;
      const elapsed = Math.max(0.001, (now - startedAt) / 1000);
      onProgress({
        transferred,
        total,
        percent: total > 0 ? Math.min(100, (transferred / total) * 100) : 0,
        bytesPerSecond: transferred / elapsed,
      });
    }
    await new Promise<void>((resolve, reject) => {
      file.end(() => resolve());
      file.once("error", reject);
    });
    return transferred;
  } catch (error) {
    file.destroy();
    throw describeDownloadError(error);
  }
}

/** 下载到 `destination`，先写 `.part` 再原子改名，避免中断留下半个包 */
export async function downloadManifestArtifact(
  params: DownloadManifestArtifactParams,
): Promise<{ path: string; bytes: number }> {
  const { url, destination, onProgress } = params;
  const partPath = `${destination}.part`;

  await mkdir(dirname(destination), { recursive: true });
  await rm(partPath, { force: true });

  const bytes = params.fetchImpl
    ? await downloadWithFetch(params.fetchImpl, url, partPath, onProgress, params.size ?? null)
    : await downloadWithNetRequest(url, partPath, onProgress, params.size ?? null);

  if (params.size && bytes !== params.size) {
    await rm(partPath, { force: true }).catch(() => {});
    throw new Error(`更新包大小不符：期望 ${params.size}，实际 ${bytes}`);
  }
  await rename(partPath, destination);
  const actual = (await stat(destination)).size;
  if (onProgress) {
    onProgress({ transferred: actual, total: actual, percent: 100, bytesPerSecond: 0 });
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
