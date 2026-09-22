/**
 * 中继桥的诊断日志落盘。
 *
 * 打包后的 app 通常用 `open -a` 启动，stdout 拿不到；而中继链路的问题（连接、
 * 应用层消息、RPC 帧）只有 host 里能看到，所以额外写一份文件便于排查。
 * 默认开启（可用 ZCODE_SELFHOST_RELAY_DEBUG=0 关闭），超过 2MB 自动轮转一次。
 *
 * 单独成文件（不依赖 workspace 包）是为了能被脱离 workspace 的测试直接导入。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const RELAY_DEBUG_MAX_BYTES = 2 * 1024 * 1024;

/**
 * 每个窗口最多写多少行。
 *
 * 日志是 appendFileSync（同步写盘），而中继帧风暴实测能到 170+ 帧/秒；
 * 不加限速就等于在事件循环热路径上做同步磁盘 I/O，叠加 2MB 轮转会拖垮 host。
 * 超出的行丢弃，并在下个窗口记一行统计，不丢「风暴发生过」这个事实。
 */
export const RELAY_DEBUG_MAX_LINES_PER_WINDOW = 40;
export const RELAY_DEBUG_WINDOW_MS = 1_000;

export function createRelayDebugLog(): ((message: string) => void) | undefined {
  if (process.env.ZCODE_SELFHOST_RELAY_DEBUG === "0") return undefined;
  const home = process.env.ZCODE_HOME?.trim() || join(homedir(), ".zcode");
  const file = join(home, "relay-debug.log");
  const write = (line: string): void => {
    try {
      mkdirSync(home, { recursive: true });
      try {
        if (statSync(file).size > RELAY_DEBUG_MAX_BYTES) renameSync(file, `${file}.1`);
      } catch {
        /* 首次写入 */
      }
      appendFileSync(file, line);
    } catch {
      /* 诊断日志失败不能影响主流程 */
    }
  };
  let windowStart = 0;
  let windowCount = 0;
  let suppressed = 0;
  return (message: string) => {
    const now = Date.now();
    if (now - windowStart >= RELAY_DEBUG_WINDOW_MS) {
      windowStart = now;
      windowCount = 0;
      if (suppressed > 0) {
        write(
          `${new Date(now).toISOString()} [pid:${process.pid}] relay debug log: 上 1s 丢弃 ${suppressed} 行\n`,
        );
        suppressed = 0;
      }
    }
    if (windowCount >= RELAY_DEBUG_MAX_LINES_PER_WINDOW) {
      suppressed += 1;
      return;
    }
    windowCount += 1;
    write(`${new Date(now).toISOString()} [pid:${process.pid}] ${message}\n`);
  };
}
