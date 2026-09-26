import { contextBridge } from "electron";
import { isTrustedRewardsWebviewOrigin } from "@zcode/shared";

function isTrustedRewardsLocation(): boolean {
  try {
    const url = new URL(window.location.href);
    return (
      isTrustedRewardsWebviewOrigin(url.origin) &&
      /^\/(cn|en)\/rewards\/?$/u.test(url.pathname) &&
      url.searchParams.get("embedded") === "app"
    );
  } catch {
    return false;
  }
}

function installRewardsPageBridge(): void {
  // Prevent stale credentials from a previous embedded session from winning over
  // the token injected by the renderer after dom-ready.
  for (const key of ["oauth:zai:access_token", "oauth:bigmodel:access_token", "zcodejwttoken"]) {
    window.localStorage.removeItem(key);
  }
  const listeners = {
    theme: new Set<(value: "zai-light" | "zai-dark") => void>(),
    locale: new Set<(value: "zh-CN" | "en-US") => void>(),
    auth: new Set<(value: unknown) => void>(),
  };
  let context: {
    theme: "zai-light" | "zai-dark";
    locale: "zh-CN" | "en-US";
    auth: unknown;
  } | null = null;
  window.addEventListener("zcode-rewards-context", (event) => {
    const next = (event as CustomEvent).detail;
    if (!next || !next.theme || !next.locale || !next.auth) return;
    const previous = context;
    context = next;
    if (previous?.theme !== next.theme) listeners.theme.forEach((listener) => listener(next.theme));
    if (previous?.locale !== next.locale)
      listeners.locale.forEach((listener) => listener(next.locale));
    if (JSON.stringify(previous?.auth) !== JSON.stringify(next.auth))
      listeners.auth.forEach((listener) => listener(next.auth));
  });
  Object.defineProperty(window, "zcodeBridge", {
    configurable: false,
    writable: false,
    value: {
      getTheme: () => context?.theme ?? null,
      getLang: () => context?.locale ?? null,
      getAuthState: () => context?.auth ?? null,
      onThemeChange(listener: (value: "zai-light" | "zai-dark") => void) {
        listeners.theme.add(listener);
        return () => listeners.theme.delete(listener);
      },
      onLangChange(listener: (value: "zh-CN" | "en-US") => void) {
        listeners.locale.add(listener);
        return () => listeners.locale.delete(listener);
      },
      onAuthChange(listener: (value: unknown) => void) {
        listeners.auth.add(listener);
        return () => listeners.auth.delete(listener);
      },
    },
  });
}

if (isTrustedRewardsLocation()) {
  contextBridge.executeInMainWorld({ func: installRewardsPageBridge, args: [] });
}
