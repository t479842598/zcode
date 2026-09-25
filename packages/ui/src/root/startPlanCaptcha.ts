import type { CaptchaConfig } from "@zcode/services";

const CAPTCHA_SCRIPT = "https://o.alicdn.com/captcha-frontend/aliyunCaptcha/AliyunCaptcha.js";
const VERIFY_TIMEOUT_MS = 120_000;
let verificationQueue: Promise<void> = Promise.resolve();

async function claimVerificationSlot(signal: AbortSignal): Promise<() => void> {
  let release!: () => void;
  const previous = verificationQueue;
  verificationQueue = new Promise<void>((resolve) => {
    release = resolve;
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const onAbort = () => reject(new Error("Captcha verification cancelled"));
      signal.addEventListener("abort", onAbort, { once: true });
      previous.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
      if (signal.aborted) onAbort();
    });
    signal.throwIfAborted();
    return release;
  } catch (error) {
    release();
    throw error;
  }
}

interface CaptchaInstance {
  show?(): void;
  startTracelessVerification?(): void;
}

type CaptchaInitializer = (options: {
  SceneId: string;
  mode: "popup";
  language: "cn" | "en";
  element: string;
  button: string;
  getInstance: (instance: CaptchaInstance) => void;
  success: (value: string) => void;
  fail: (error: unknown) => void;
  onError: (error: unknown) => void;
}) => void;

async function loadCaptchaScript(signal: AbortSignal): Promise<void> {
  if ((window as Window & { initAliyunCaptcha?: CaptchaInitializer }).initAliyunCaptcha) return;
  const script = document.createElement("script");
  script.src = CAPTCHA_SCRIPT;
  script.async = true;
  try {
    await new Promise<void>((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timeout);
        signal.removeEventListener("abort", onAbort);
        script.onload = null;
        script.onerror = null;
      };
      const onAbort = () => {
        cleanup();
        reject(new Error("Captcha verification cancelled"));
      };
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error("Captcha script load timed out"));
      }, 10_000);
      script.onload = () => {
        cleanup();
        resolve();
      };
      script.onerror = () => {
        cleanup();
        reject(new Error("Captcha script failed to load"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      document.head.appendChild(script);
    });
  } catch (error) {
    script.remove();
    throw error;
  }
}

/** 仅用官方配置初始化SDK；单次结果不落盘、不复用，不读取账号令牌。 */
export async function verifyStartPlanCaptcha(
  config: CaptchaConfig,
  signal: AbortSignal,
  locale: "zh-CN" | "en-US",
): Promise<string> {
  signal.throwIfAborted();
  if (!config.enabled || !config.region || !config.prefix || !config.sceneId) {
    throw new Error("Start Plan verification is unavailable");
  }
  const releaseSlot = await claimVerificationSlot(signal);
  const previousConfig = (window as Window & { AliyunCaptchaConfig?: unknown }).AliyunCaptchaConfig;
  const container = document.createElement("div");
  const id = `zcode-captcha-${crypto.randomUUID()}`;
  const mountId = `${id}-mount`;
  const buttonId = `${id}-button`;
  container.id = id;
  container.className = "fixed bottom-4 right-4 z-[9999]";
  const mount = document.createElement("div");
  mount.id = mountId;
  const button = document.createElement("button");
  button.id = buttonId;
  button.type = "button";
  button.textContent = locale === "zh-CN" ? "进行安全验证" : "Verify request";
  button.className = "rounded border border-border bg-background px-3 py-2 text-foreground";
  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.textContent = locale === "zh-CN" ? "取消验证" : "Cancel verification";
  cancel.className = button.className;
  container.append(mount, button, cancel);
  document.body.appendChild(container);
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    await loadCaptchaScript(signal);
    signal.throwIfAborted();
    const initializer = (window as Window & { initAliyunCaptcha?: CaptchaInitializer })
      .initAliyunCaptcha;
    if (!initializer) throw new Error("Captcha SDK is unavailable");
    (
      window as Window & { AliyunCaptchaConfig?: { region: string; prefix: string } }
    ).AliyunCaptchaConfig = {
      region: config.region,
      prefix: config.prefix,
    };
    return await new Promise<string>((resolve, reject) => {
      let settled = false;
      const finish = (value?: string, error?: Error) => {
        if (settled) return;
        settled = true;
        if (error) reject(error);
        else if (value?.trim()) resolve(value.trim());
        else reject(new Error("Captcha verification failed"));
      };
      abort = () => finish(undefined, new Error("Captcha verification cancelled"));
      cancel.onclick = abort;
      signal.addEventListener("abort", abort, { once: true });
      timeout = setTimeout(
        () => finish(undefined, new Error("Captcha verification timed out")),
        VERIFY_TIMEOUT_MS,
      );
      try {
        initializer({
          SceneId: config.sceneId,
          mode: "popup",
          language: locale === "zh-CN" ? "cn" : "en",
          element: `#${mountId}`,
          button: `#${buttonId}`,
          getInstance(instance) {
            if (settled) return;
            if (instance.startTracelessVerification) instance.startTracelessVerification();
            else button.click();
          },
          success(value) {
            finish(value);
          },
          fail(error) {
            if (settled) return;
            if (
              typeof error === "object" &&
              error !== null &&
              "verifyResult" in error &&
              (error as { verifyResult?: unknown }).verifyResult === false
            ) {
              button.click();
              return;
            }
            finish(undefined, new Error("Captcha verification failed"));
          },
          onError() {
            finish(undefined, new Error("Captcha verification failed"));
          },
        });
      } catch {
        finish(undefined, new Error("Captcha SDK failed to initialize"));
      }
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (abort) signal.removeEventListener("abort", abort);
    cancel.onclick = null;
    container.remove();
    (window as Window & { AliyunCaptchaConfig?: unknown }).AliyunCaptchaConfig = previousConfig;
    releaseSlot();
  }
}
