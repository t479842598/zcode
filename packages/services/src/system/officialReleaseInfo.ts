import { compareSemverVersions } from "@zcode/shared";
import { parse as parseYaml } from "yaml";

const OFFICIAL_RELEASE_MANIFEST_PATH = "/api/v1/releases/electron/manifest";
const PLATFORM_NAME: Record<string, string> = {
  darwin: "darwin",
  win32: "windows",
  linux: "linux",
};
const ARCH_NAME: Record<string, string> = { arm64: "aarch64", x64: "x86_64", ia32: "x86" };
export function officialReleaseSourceUrl(platform = process.platform, arch = process.arch): string {
  const url = new URL(OFFICIAL_RELEASE_MANIFEST_PATH, "https://zcode.z.ai");
  url.searchParams.set(
    "platform",
    `${PLATFORM_NAME[platform] ?? platform}-${ARCH_NAME[arch] ?? arch}`,
  );
  url.searchParams.set("channel", "1");
  return url.href;
}
export const OFFICIAL_RELEASE_SOURCE_URL = officialReleaseSourceUrl();
export const OFFICIAL_RELEASE_PAGE_URL = "https://zcode.z.ai/cn/changelog";
const OFFICIAL_RELEASE_EN_PAGE_URL = "https://zcode.z.ai/en/changelog";

export interface OfficialReleaseInfo {
  version: string;
  releaseDate: string | null;
  releaseNotes: string;
  sourceUrl: string;
  checkedAt: number;
}

/** 查询公开稳定版元数据，不经带账号/设备头的 ApiClient，也不调用安装更新器。 */
export async function fetchOfficialReleaseInfo(
  options: { fetchImpl?: typeof fetch; now?: () => number; locale?: "zh-CN" | "en-US" } = {},
): Promise<OfficialReleaseInfo> {
  const response = await (options.fetchImpl ?? fetch)(OFFICIAL_RELEASE_SOURCE_URL, {
    method: "GET",
    headers: { Accept: "application/yaml" },
    credentials: "omit",
    cache: "no-store",
    signal: AbortSignal.timeout(10_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Official release check failed: HTTP ${response.status}`);
  const body = await response.text();
  if (body.length > 64_000) throw new Error("Official release manifest is too large");
  const parsed: unknown = parseYaml(body);
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid official release manifest");
  const release = parsed as Record<string, unknown>;
  if (
    typeof release.version !== "string" ||
    compareSemverVersions(release.version, "0.0.0") === null
  ) {
    throw new Error("Invalid official release version");
  }
  const localized = release.releaseNotesByLocale;
  const locale = options.locale ?? "zh-CN";
  const selected =
    localized && typeof localized === "object"
      ? (localized as Record<string, unknown>)[locale]
      : null;
  const localizedNotes =
    selected && typeof selected === "object"
      ? (selected as Record<string, unknown>).markdown
      : null;
  const notes = typeof localizedNotes === "string" ? localizedNotes : release.releaseNotes;
  return {
    version: release.version,
    releaseDate: typeof release.releaseDate === "string" ? release.releaseDate : null,
    releaseNotes: typeof notes === "string" ? notes.slice(0, 16_000) : "",
    sourceUrl: locale === "zh-CN" ? OFFICIAL_RELEASE_PAGE_URL : OFFICIAL_RELEASE_EN_PAGE_URL,
    checkedAt: (options.now ?? Date.now)(),
  };
}
