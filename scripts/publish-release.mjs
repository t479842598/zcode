#!/usr/bin/env node
/**
 * 发布产物到自建更新服务器
 *
 * 把桌面端打包产物（zip/dmg/blockmap + latest-mac.yml）上传到中继服务器，
 * 并生成 electron-updater 所需的更新清单接口数据。
 *
 * 客户端更新链路：
 *   electron-updater → GET {origin}/api/v1/releases/electron/manifest
 *                     ?platform=darwin-arm64&channel=1
 *   ← 返回 YAML（version / files[].url+sha512 / path / releaseDate）
 *   → 按 url 下载 zip（有 .blockmap 则走差分）
 *
 * 服务器目录约定：
 *   /www/wwwroot/zcode.tang74.top/releases/           静态产物
 *   /www/wwwroot/zcode.tang74.top/releases/<platform>/manifest.yml   更新清单
 *
 * 用法（在 upstream 目录）：
 *   node scripts/publish-release.mjs                    # 上传 mac-arm64 产物
 *   node scripts/publish-release.mjs --dry-run          # 只打印计划
 *   node scripts/publish-release.mjs --platform darwin-arm64
 *
 * 依赖 sshpass（macOS: brew install hudochenkov/sshpass/sshpass）。
 */
import { existsSync } from "node:fs";
import { readFile, readdir, stat } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const DIST_DIR = join(repoRoot, "packages/desktop/dist");

const HOST = process.env.ZCODE_RELEASE_HOST ?? "root@182.92.127.90";
const REMOTE_ROOT = process.env.ZCODE_RELEASE_ROOT ?? "/www/wwwroot/zcode.tang74.top/releases";
const SSH_PASS = process.env.ZCODE_RELEASE_SSH_PASS ?? "TANGlidong24ban!";

const argv = process.argv.slice(2);
const DRY_RUN = argv.includes("--dry-run");
const platformFlag = argv.indexOf("--platform");
const PLATFORM = platformFlag >= 0 ? argv[platformFlag + 1] : "darwin-aarch64";

/**
 * 平台标识 → 产物文件名特征。
 *
 * ⚠️ 平台名必须与客户端实际请求值一致！客户端用 `getElectronReleasePlatform()`：
 *   arm64 → aarch64、x64 → x86_64、ia32 → x86
 * 即 macOS Apple Silicon 请求的是 `darwin-aarch64`（不是 darwin-arm64）。
 * 服务端按 `$arg_platform` 定位 `releases/<platform>/manifest.yml`，名字不匹配就会 404。
 *
 * 同时注意：blockmap 文件名形如 `xxx-mac-arm64.zip.blockmap`，不能要求后缀紧接；
 * 且需排除历史 Preview 包（`ZCode Preview-*`）。
 */
const PLATFORM_MATCHERS = {
  "darwin-aarch64": { artifact: /^ZCode-.*mac-arm64.*\.(zip|dmg|blockmap)$/, manifest: "latest-mac.yml" },
  "darwin-x86_64": { artifact: /^ZCode-.*mac-x64.*\.(zip|dmg|blockmap)$/, manifest: "latest-mac.yml" },
  "windows-x86_64": { artifact: /^ZCode-.*win-x64.*\.(exe|blockmap)$/, manifest: "latest.yml" },
};

function findSshpass() {
  const candidates = ["sshpass", join(process.env.HOME ?? "", ".homebrew/bin/sshpass")];
  for (const bin of candidates) {
    const r = spawnSync("which", [bin], { encoding: "utf8" });
    if (r.status === 0) return bin;
    if (existsSync(bin)) return bin;
  }
  return null;
}

function run(bin, args, opts = {}) {
  const result = spawnSync(bin, args, { encoding: "utf8", stdio: "pipe", ...opts });
  if (result.status !== 0) {
    throw new Error(
      `${bin} ${args.join(" ")} 失败（exit ${result.status}）：${(result.stderr || result.stdout || "").trim().slice(0, 400)}`,
    );
  }
  return result.stdout ?? "";
}

async function main() {
  const matcher = PLATFORM_MATCHERS[PLATFORM];
  if (!matcher) {
    throw new Error(`不支持的 platform：${PLATFORM}（可选：${Object.keys(PLATFORM_MATCHERS).join(", ")}）`);
  }
  if (!existsSync(DIST_DIR)) {
    throw new Error(`未找到打包目录：${DIST_DIR}\n  请先执行 pnpm bundle:desktop -- --os mac --arch arm64`);
  }

  const files = await readdir(DIST_DIR);
  const artifacts = files.filter((f) => matcher.artifact.test(f));
  if (artifacts.length === 0) {
    throw new Error(`在 ${DIST_DIR} 未找到匹配 ${PLATFORM} 的产物（${matcher.artifact}）`);
  }
  // 同名旧身份产物（Preview / 旧版本）不应混入本次发布
  const stale = artifacts.filter((f) => /^ZCode Preview/.test(f));
  if (stale.length > 0) {
    throw new Error(`产物中混入 Preview 身份文件，拒绝发布：${stale.join(", ")}`);
  }
  if (!files.includes(matcher.manifest)) {
    throw new Error(`未找到更新清单 ${matcher.manifest}（electron-builder 应自动生成）`);
  }

  const manifestRaw = await readFile(join(DIST_DIR, matcher.manifest), "utf8");
  const version = /^version:\s*(.+)$/m.exec(manifestRaw)?.[1]?.trim();
  if (!version) {
    throw new Error(`${matcher.manifest} 中未找到 version 字段`);
  }

  console.log(`平台：${PLATFORM}`);
  console.log(`版本：${version}`);
  console.log(`产物：${artifacts.join(", ")}`);
  console.log(`清单：${matcher.manifest}`);
  console.log(`目标：${HOST}:${REMOTE_ROOT}/${PLATFORM}/`);

  if (DRY_RUN) {
    console.log("\n[dry-run] 跳过实际上传");
    return;
  }

  const sshpass = findSshpass();
  if (!sshpass) {
    throw new Error(
      "未找到 sshpass，无法非交互上传。\n  安装：brew install hudochenkov/sshpass/sshpass\n  或设置 ZCODE_RELEASE_SSH_PASS 后用 ssh key 免密",
    );
  }

  const sshOpts = ["-o", "StrictHostKeyChecking=no", "-o", "ConnectTimeout=20"];
  const remoteDir = `${REMOTE_ROOT}/${PLATFORM}`;

  // 1. 准备远端目录
  run(sshpass, ["-p", SSH_PASS, "ssh", ...sshOpts, HOST, `mkdir -p ${remoteDir}`]);
  console.log("• 远端目录就绪");

  // 2. 上传产物与清单（-C 压缩，大包明显更快）
  for (const name of [...artifacts, matcher.manifest]) {
    const localPath = join(DIST_DIR, name);
    const size = (await stat(localPath)).size;
    console.log(`• 上传 ${name}（${(size / 1024 / 1024).toFixed(1)} MiB）…`);
    run(sshpass, ["-p", SSH_PASS, "scp", ...sshOpts, "-C", localPath, `${HOST}:${remoteDir}/`]);
  }

  // 3. 生成更新接口数据：把 manifest 里的相对 url 改写为可下载的绝对地址
  const baseUrl = process.env.ZCODE_RELEASE_BASE_URL ?? "https://zcode.tang74.top/releases";
  const manifestForClient = manifestRaw
    .split("\n")
    .map((line) => {
      const m = /^(\s*-?\s*url:\s*)(\S+)$/.exec(line);
      if (!m) return line;
      const [, prefix, url] = m;
      if (/^https?:\/\//.test(url)) return line;
      return `${prefix}${baseUrl}/${PLATFORM}/${url}`;
    })
    .join("\n");

  const manifestPath = join(DIST_DIR, `${PLATFORM}-manifest.yml`);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(manifestPath, manifestForClient, "utf8");
  run(sshpass, ["-p", SSH_PASS, "scp", ...sshOpts, manifestPath, `${HOST}:${remoteDir}/manifest.yml`]);
  console.log("• 已上传更新清单 manifest.yml");

  // 4. 修正属主，保证 nginx 可读
  run(sshpass, ["-p", SSH_PASS, "ssh", ...sshOpts, HOST, `chown -R www:www ${REMOTE_ROOT}`]);
  console.log("• 属主已修正");

  console.log(`\n✓ 发布完成：${version}（${PLATFORM}）`);
  console.log(`  更新接口：https://zcode.tang74.top/api/v1/releases/electron/manifest?platform=${PLATFORM}&channel=1`);
}

main().catch((error) => {
  console.error(`✗ 发布失败：${error.message}`);
  process.exit(1);
});
