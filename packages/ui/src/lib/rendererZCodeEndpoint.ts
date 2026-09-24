import { buildZCodeEndpointUrls, DEFAULT_ZCODE_ENDPOINT_ORIGIN } from "@zcode/shared";

// 套餐页会接收账号凭据，不能复用自托管中继/更新站的 Vite base URL。
export const RENDERER_ZCODE_ENDPOINT_URLS = buildZCodeEndpointUrls(DEFAULT_ZCODE_ENDPOINT_ORIGIN);
