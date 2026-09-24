import { DEFAULT_ZCODE_ENDPOINT_ORIGIN, normalizeZCodeEndpointOrigin } from "@zcode/shared";

const DEFAULT_SELFHOST_UPDATE_ORIGIN = "https://zcode.tang74.top";

/** 更新清单和账号业务不能共用 origin；保留已有自建配置但不回退官方升级源。 */
export function resolveSelfhostUpdateOrigin(options: {
  env?: Record<string, string | undefined>;
  overrideOrigin?: string | null;
  envBaseOrigin?: string | null;
} = {}): string {
  const configured = options.env?.ZCODE_SELFHOST_UPDATE_ORIGIN?.trim() ||
    options.overrideOrigin?.trim() || options.envBaseOrigin?.trim();
  const origin = configured ? normalizeZCodeEndpointOrigin(configured) : DEFAULT_SELFHOST_UPDATE_ORIGIN;
  return origin === DEFAULT_ZCODE_ENDPOINT_ORIGIN ? DEFAULT_SELFHOST_UPDATE_ORIGIN : origin;
}
