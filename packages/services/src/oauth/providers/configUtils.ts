import {
  ZCODE_VERSION,
  buildOfficialZCodeApiUrl,
  DEFAULT_ZCODE_ENDPOINT_ORIGIN,
} from "@zcode/shared";

const DESKTOP_OAUTH_CALLBACK_URI = "zcode://oauth/callback";

export function readEnv(env: NodeJS.ProcessEnv, key: string): string | undefined {
  const value = env[key];
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function readBoolean(env: NodeJS.ProcessEnv, key: string, fallback: boolean): boolean {
  const raw = readEnv(env, key);
  if (raw == null) {
    return fallback;
  }

  return raw !== "0" && raw.toLowerCase() !== "false";
}

export function buildZCodeApiUrlFromEnv(_env: NodeJS.ProcessEnv, path: string): string {
  // 中继站不具备官方账号授权能力，不把 code/JWT/轮询凭据送到通用自建 origin。
  return buildOfficialZCodeApiUrl(path);
}

export function buildDesktopOAuthRedirectUriFromEnv(_env: NodeJS.ProcessEnv): string {
  const url = new URL("/app/oauth/login", DEFAULT_ZCODE_ENDPOINT_ORIGIN);
  url.searchParams.set("redirect", DESKTOP_OAUTH_CALLBACK_URI);
  // Website 需要按 App 版本决定是否关闭自动 deep link；缺少版本时必须兼容旧客户端行为。
  url.searchParams.set("app_version", ZCODE_VERSION);
  return url.toString();
}
