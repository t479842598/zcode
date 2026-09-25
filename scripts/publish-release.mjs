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
const SSH_PASS = process.env.ZCODE_RELEASE_SSH_PASS?.trim() ?? "";
/**
 * 安装包实际托管在 GitHub Releases；服务器只放几百字节的 manifest。
 *
 * 原因：阿里云 ECS 出网带宽只有 ~2Mbps（实测 232 KB/s），177MB 要下 12 分钟；
 * GitHub 走系统代理实测 ~10 MB/s（17 秒）。而「检测更新」只有一个几百字节的请求，
 * 放自建服务器更快更稳，所以拆开：**清单走自建，安装包走 GitHub**。
 */
const GITHUB_REPO = process.env.ZCODE_RELEASE_GITHUB_REPO ?? "t479842598/zcode";
/** 默认不再往服务器传安装包（只传 manifest）；置 1 可回退到旧行为 */
const UPLOAD_INSTALLERS = process.env.ZCODE_RELEASE_UPLOAD_INSTALLERS === "1";

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

/**
 * 把 manifest 里 files[].url 的相对文件名改写为 GitHub Releases 绝对地址。
 * 只改 url 不改 path：electron-updater 按 files[] 下载，path 保持相对是被实测跑通的形状。
 */
function rewriteManifestUrls(manifestRaw, baseUrl) {
  return manifestRaw
    .split("\n")
    .map((line) => {
      const m = /^(\s*-?\s*url:\s*)(\S+)$/.exec(line);
      if (!m) return line;
      const [, prefix, url] = m;
      if (/^https?:\/\//.test(url)) return line;
      return `${prefix}${baseUrl}/${url}`;
    })
    .join("\n");
}

/**
 * 把更新说明写进 manifest。
 *
 * 对齐官方 manifest 的形状（实测 zcode.z.ai 的 manifest）：
 *   releaseNotes: |-
 *       ## 新功能
 *
 *       - 一条一句纯文字
 * 用块标量 `|-` + 4 空格缩进，不把 markdown 里换行/缩进写成转义字符串；
 * 客户端 autoUpdater 解析后会在更新按钮 hover 与更新弹窗里按 markdown 渲染。
 * 注意：不要写 markdown 表格 —— 弹窗宽度有限，表格会折行得很难看，官方也只用列表。
 */
function appendReleaseNotes(manifest, notes) {
  if (!notes) return manifest;
  const base = manifest.endsWith("\n") ? manifest : `${manifest}\n`;
  const body = notes
    .split("\n")
    .map((line) => (line.trim().length > 0 ? `    ${line}` : ""))
    .join("\n");
  return `${base}releaseNotes: |-\n${body}\n`;
}

/** 优先环境变量，其次本机 git 凭据助手（macOS keychain 里存的 github token） */
function resolveGithubToken() {
  const fromEnv = (process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "").trim();
  if (fromEnv) return fromEnv;
  const r = spawnSync("git", ["credential", "fill"], {
    input: "protocol=https\nhost=github.com\n\n",
    encoding: "utf8",
  });
  return /^password=(.+)$/m.exec(r.stdout ?? "")?.[1]?.trim() ?? "";
}

/**
 * 取 GitHub Release 正文作为更新说明（单一事实来源就是 GitHub）。
 * 可用 ZCODE_RELEASE_NOTES_FILE 指定本地文件覆盖；都取不到就不写 releaseNotes（不报错）。
 */
async function resolveReleaseNotes(tag) {
  const file = process.env.ZCODE_RELEASE_NOTES_FILE;
  if (file && existsSync(file)) {
    console.log(`• releaseNotes 来自本地文件 ${file}`);
    return (await readFile(file, "utf8")).trim();
  }
  const token = resolveGithubToken();
  if (!token) {
    console.log("• 未找到 GitHub token，manifest 不含 releaseNotes");
    return "";
  }
  try {
    const res = await fetch(`https://api.github.com/repos/${GITHUB_REPO}/releases/tags/${tag}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "zcode-selfhost-release",
      },
    });
    if (!res.ok) {
      console.log(`• GitHub API ${res.status}，manifest 不含 releaseNotes`);
      return "";
    }
    const body = ((await res.json()).body ?? "").trim();
    console.log(`• releaseNotes 来自 GitHub Release（${body.length} 字符）`);
    return body;
  } catch (error) {
    console.log(`• 取 GitHub Release 失败（${error.message}），manifest 不含 releaseNotes`);
    return "";
  }
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
  if (!files.includes(matcher.manifest)) {
    throw new Error(`未找到更新清单 ${matcher.manifest}（electron-builder 应自动生成）`);
  }

  // 先读版本号：dist 里会残留历史版本的产物，必须只发布与清单版本一致的那一套，
  // 否则旧版本会被一并上传（实测：发 3.14.2 时把 3.14.1 也传了），
  // 而且「清理旧产物」的 keep 名单会把它们当成本次产物保护起来、永远清不掉。
  const manifestRaw = await readFile(join(DIST_DIR, matcher.manifest), "utf8");
  const version = /^version:\s*(.+)$/m.exec(manifestRaw)?.[1]?.trim();
  if (!version) {
    throw new Error(`${matcher.manifest} 中未找到 version 字段`);
  }

  const artifacts = files.filter((f) => matcher.artifact.test(f) && f.includes(version));
  if (artifacts.length === 0) {
    throw new Error(
      `在 ${DIST_DIR} 未找到 ${version} 匹配 ${PLATFORM} 的产物（${matcher.artifact}）`,
    );
  }
  // 同名旧身份产物（Preview）不应混入本次发布
  const stale = artifacts.filter((f) => f.startsWith("ZCode Preview"));
  if (stale.length > 0) {
    throw new Error(`产物中混入 Preview 身份文件，拒绝发布：${stale.join(", ")}`);
  }

  console.log(`平台：${PLATFORM}`);
  console.log(`版本：${version}`);
  console.log(`产物：${artifacts.join(", ")}`);
  console.log(`清单：${matcher.manifest}`);
  console.log(`目标：${HOST}:${REMOTE_ROOT}/${PLATFORM}/`);

  // 生成客户端清单：安装包 URL 指向 GitHub Releases，并注入更新说明。
  // 服务器只托管这个几百字节的清单（检测更新走自建、毫秒级且稳定）。
  const tag = `v${version}`;
  const ghBase = `https://github.com/${GITHUB_REPO}/releases/download/${tag}`;
  const releaseNotes = await resolveReleaseNotes(tag);
  const manifestForClient = appendReleaseNotes(rewriteManifestUrls(manifestRaw, ghBase), releaseNotes);
  const manifestPath = join(DIST_DIR, `${PLATFORM}-manifest.yml`);
  const { writeFile } = await import("node:fs/promises");
  await writeFile(manifestPath, manifestForClient, "utf8");
  console.log(`清单下载基址：${ghBase}`);
  console.log(`更新说明：${releaseNotes ? `${releaseNotes.length} 字符` : "（无）"}`);

  if (DRY_RUN) {
    console.log("\n--- 客户端清单预览 ---");
    console.log(manifestForClient);
    console.log("[dry-run] 跳过实际上传");
    return;
  }

  // 发布密钥只来自明确提供的运行时环境；不能从仓库源码回退出服务器密码。
  if (!SSH_PASS) throw new Error("缺少 ZCODE_RELEASE_SSH_PASS，拒绝发布");
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

  // 2. 可选：把安装包也传到服务器（默认不传：安装包已托管在 GitHub，
  //    阿里云 2Mbps 出网带宽撑不住 177MB 的分发）
  if (UPLOAD_INSTALLERS) {
    for (const name of [...artifacts, matcher.manifest]) {
      const localPath = join(DIST_DIR, name);
      const size = (await stat(localPath)).size;
      console.log(`• 上传 ${name}（${(size / 1024 / 1024).toFixed(1)} MiB）…`);
      run(sshpass, ["-p", SSH_PASS, "scp", ...sshOpts, "-C", localPath, `${HOST}:${remoteDir}/`]);
    }
  }

  // 3. 上传客户端清单（几百字节）
  run(sshpass, ["-p", SSH_PASS, "scp", ...sshOpts, manifestPath, `${HOST}:${remoteDir}/manifest.yml`]);
  console.log("• 已上传更新清单 manifest.yml");

  // 4. 清理服务端：只留 manifest.yml。安装包走 GitHub 后，服务器不再需要存它们
  //    （每个版本约 350MB，磁盘只有 40G）。
  const keepPatterns = UPLOAD_INSTALLERS ? [...artifacts, matcher.manifest, "manifest.yml"] : ["manifest.yml"];
  const keepList = keepPatterns.map((n) => `'${n.replace(/'/g, "'\\''")}'`).join(" ");
  const pruneOut = run(sshpass, [
    "-p",
    SSH_PASS,
    "ssh",
    ...sshOpts,
    HOST,
    `cd ${remoteDir} && for f in *; do [ -f "$f" ] || continue; keep=0; for k in ${keepList}; do [ "$f" = "$k" ] && keep=1; done; [ "$keep" = 0 ] && rm -f "$f" && echo "  已删 $f"; done; true`,
  ]);
  const pruned = (pruneOut ?? "").trim();
  console.log(pruned ? `• 清理服务端旧文件：\n${pruned}` : "• 服务端无需清理");

  // 5. 修正属主，保证 nginx 可读
  run(sshpass, ["-p", SSH_PASS, "ssh", ...sshOpts, HOST, `chown -R www:www ${REMOTE_ROOT}`]);
  console.log("• 属主已修正");

  console.log(`\n✓ 发布完成：${version}（${PLATFORM}）`);
  console.log(`  检测更新：https://zcode.tang74.top/api/v1/releases/electron/manifest?platform=${PLATFORM}&channel=1`);
  console.log(`  下载安装包：${ghBase}/`);

  // 6. 发布后自检：把服务端清单拉回来，核对「声明的 version」与「产物文件名里的版本」一致。
  //
  // 为什么必须查：曾出现服务端 manifest 声明 version: 3.14.3、files[].url 却指向
  // ZCode-3.14.2-mac-arm64.zip（手工改的「验证用临时版本」）。后果是客户端永远认为
  // 有新版可装，装完版本号还是 3.14.2，于是「更新按钮常亮、点了也升不上去」。
  // 这里在发布收口处直接揭发，而不是等用户点更新时才发现。
  await verifyPublishedManifest(version, PLATFORM);
}

async function verifyPublishedManifest(version, platform) {
  const url = `https://zcode.tang74.top/api/v1/releases/electron/manifest?platform=${platform}&channel=1`;
  let text;
  try {
    const res = await fetch(url, { headers: { Accept: "application/x-yaml" } });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    text = await res.text();
  } catch (error) {
    throw new Error(`发布后自检失败：无法读取服务端清单（${error.message}）`);
  }

  const declared = /^version:\s*(.+)$/m.exec(text)?.[1]?.trim();
  if (declared !== version) {
    throw new Error(
      `发布后自检失败：服务端清单声明 version=${declared}，本次发布的是 ${version}。` +
        `客户端会因此永远认为有新版本可装。请重跑发布或排查 nginx 缓存。`,
    );
  }

  const urls = [...text.matchAll(/^\s*-?\s*url:\s*(\S+)$/gm)].map((m) => m[1]);
  if (urls.length === 0) {
    throw new Error("发布后自检失败：服务端清单没有任何 files[].url");
  }
  // 产物文件名里必须带本次版本号；文件名与声明版本不符时，装上去的就不是这一版。
  const mismatched = urls.filter((u) => {
    const name = decodeURIComponent(u.split("?")[0].split("/").pop() ?? "");
    // 只校验 ZCode-<version>- 开头的安装包；latest-mac.yml 之类的辅助文件不参与
    if (!/^ZCode[-.]/.test(name)) return false;
    return !name.includes(`-${version}-`) && !name.includes(`-${version}.`);
  });
  if (mismatched.length > 0) {
    throw new Error(
      `发布后自检失败：清单声明 ${version}，但产物指向其他版本：\n  ${mismatched.join("\n  ")}\n` +
        `这会导致客户端下载到版本不符的包，装完版本号不变、更新提示永远重现。`,
    );
  }

  console.log(`• 发布后自检通过：清单声明与产物文件名版本一致（${version}）`);
}

main().catch((error) => {
  console.error(`✗ 发布失败：${error.message}`);
  process.exit(1);
});
