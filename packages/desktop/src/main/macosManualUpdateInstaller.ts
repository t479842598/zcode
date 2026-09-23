/**
 * macOS 自托管更新的自研安装器 —— 绕开 Squirrel.Mac 的代码签名校验。
 *
 * 背景：electron-updater 在 macOS 上把下载好的 zip 交给 Squirrel.Mac 安装，而 Squirrel
 * 强制校验代码签名。自托管构建未签名（打包时 `identity` 显式为 null，日志里是
 * `skipped macOS code signing`），因此安装必然失败并抛 `SQRLCodeSignatureErrorDomain`，
 * 实测表现就是「下载 100% 完成、界面回到 idle、版本不变、不重启」。
 *
 * 这里用等价流程替代 Squirrel：
 *   ditto 解压缓存 zip → 先把新 app 拷到 /Applications 下的临时名 → 备份旧 app →
 *   原子改名就位 → 清 quarantine 属性 → 重启
 *
 * 关键取舍：
 *  - 新 app 先落到同卷临时名再 `mv` 就位：`mv` 是同卷原子操作，避免「拷到一半失败」
 *    把用户的应用搞成半成品。
 *  - 旧 app 只备份不删除，并且只在成功后清理更早的备份，失败时能立刻回滚。
 *  - 只在未签名（拿不到 TeamIdentifier）时启用；签名可用时仍走 Squirrel，保持官方行为。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 安装目标（用户可见的应用位置） */
export const DEFAULT_INSTALL_TARGET = "/Applications/ZCode.app";
export interface ManualInstallStep {
  cmd: string;
  args: string[];
}

export interface BuildManualInstallStepsParams {
  /** electron-updater 下载好的 zip（含 ZCode.app） */
  zipPath: string;
  /** 解压目录 */
  stagingDir: string;
  /** 新 app 在 /Applications 下的临时名（同卷，便于 mv 原子就位） */
  stagedAppPath: string;
  /** 最终安装位置 */
  installTarget: string;
  /** 备份路径（旧 app 改名到这里） */
  backupPath: string;
}

/**
 * 生成安装步骤（纯函数，便于单测）。
 * 顺序刻意是「先解压 → 再拷到同卷临时名 → 最后两次 mv」，任一步失败都不会破坏现网应用。
 */
export function buildManualInstallSteps(params: BuildManualInstallStepsParams): ManualInstallStep[] {
  const { zipPath, stagingDir, stagedAppPath, installTarget, backupPath } = params;
  return [
    // 1. 解压 zip（ditto 保留 bundle 的资源分叉与权限位，比 unzip 更贴近 Finder 行为）
    { cmd: "/usr/bin/ditto", args: ["-x", "-k", zipPath, stagingDir] },
    // 2. 拷到 /Applications 下的临时名（同卷，下一步 mv 才是原子的）
    { cmd: "/usr/bin/ditto", args: [join(stagingDir, basename(installTarget)), stagedAppPath] },
    // 3. 旧 app 改名备份（对运行中的进程无影响：进程持有的是 inode）
    { cmd: "/bin/mv", args: [installTarget, backupPath] },
    // 4. 新 app 原子就位
    { cmd: "/bin/mv", args: [stagedAppPath, installTarget] },
    // 5. 清掉下载包带来的隔离属性，否则未签名 app 会被 Gatekeeper 拦下
    { cmd: "/usr/bin/xattr", args: ["-dr", "com.apple.quarantine", installTarget] },
  ];
}

/** 备份路径：`/Applications/ZCode.app.bak-3.14.1` */
export function resolveBackupPath(installTarget: string, currentVersion: string): string {
  const dir = dirname(installTarget);
  const name = basename(installTarget).replace(/\.app$/i, "");
  return join(dir, `${name}.app.bak-${currentVersion}`);
}

/**
 * 读出代码签名的 TeamIdentifier；未签名/签名不完整时返回 null。
 *
 * Squirrel.Mac 需要合法的 Developer ID 签名才能安装；自托管构建没有，
 * 所以这里用「能否拿到 TeamIdentifier」作为是否需要自研安装器的判据。
 */
export async function detectSignatureTeamId(appPath: string): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync("/usr/bin/codesign", [
      "-dv",
      "--verbose=4",
      appPath,
    ]);
    const text = `${stdout}\n${stderr}`;
    const match = /^TeamIdentifier=(.+)$/m.exec(text);
    const value = match?.[1]?.trim();
    if (!value || value === "not set") return null;
    return value;
  } catch {
    // codesign 对未签名 bundle 会以非零码退出
    return null;
  }
}

export interface InstallMacUpdateParams {
  /** 下载好的 zip 路径；为空说明拿不到安装包，直接失败 */
  zipPath: string | null | undefined;
  /** 当前版本，用于备份命名 */
  currentVersion: string;
  /** 覆盖安装位置（测试用） */
  installTarget?: string;
  /** 覆盖执行器（测试用） */
  runStep?: (step: ManualInstallStep) => Promise<void>;
}

export interface InstallMacUpdateResult {
  installedPath: string;
  backupPath: string;
}

async function defaultRunStep(step: ManualInstallStep): Promise<void> {
  await execFileAsync(step.cmd, step.args, { maxBuffer: 16 * 1024 * 1024 });
}

/**
 * 用自研流程把已下载的 zip 安装到位。**不会自己重启**，由调用方在成功后重启，
 * 这样安装与退出时序留在 autoUpdater 里统一处理。
 */
export async function installMacUpdateFromZip(
  params: InstallMacUpdateParams,
): Promise<InstallMacUpdateResult> {
  const installTarget = params.installTarget ?? DEFAULT_INSTALL_TARGET;
  const runStep = params.runStep ?? defaultRunStep;
  const zipPath = params.zipPath?.trim();
  if (!zipPath) {
    throw new Error("找不到已下载的更新包，无法安装");
  }
  if (!existsSync(zipPath)) {
    throw new Error(`更新包不存在：${zipPath}`);
  }

  const stagingDir = await mkdtemp(join(tmpdir(), "zcode-update-"));
  const stagedAppPath = join(dirname(installTarget), `.${basename(installTarget)}.new`);
  const backupPath = resolveBackupPath(installTarget, params.currentVersion);
  const steps = buildManualInstallSteps({
    zipPath,
    stagingDir,
    stagedAppPath,
    installTarget,
    backupPath,
  });

  try {
    // 临时名可能来自上次失败残留
    await rm(stagedAppPath, { recursive: true, force: true });
    for (const [index, step] of steps.entries()) {
      try {
        await runStep(step);
      } catch (error) {
        // 第 3 步（旧 app 改名）之后的失败必须把旧 app 放回去，否则用户就没有应用了。
        if (index >= 2 && existsSync(backupPath) && !existsSync(installTarget)) {
          await runStep({ cmd: "/bin/mv", args: [backupPath, installTarget] }).catch(() => {});
        }
        await rm(stagedAppPath, { recursive: true, force: true }).catch(() => {});
        throw error;
      }
    }
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch(() => {});
  }

  // 只保留本次备份，避免 /Applications 里越堆越多
  await pruneOlderBackups(dirname(installTarget), basename(backupPath)).catch(() => {});

  return { installedPath: installTarget, backupPath };
}

/** 删掉同名项目的更早备份（失败不影响安装结果） */
export async function pruneOlderBackups(dir: string, keepName: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });
  await Promise.all(
    entries
      .filter((entry) => entry.name.includes(".app.bak-") && entry.name !== keepName)
      .map((entry) => rm(join(dir, entry.name), { recursive: true, force: true })),
  );
}
