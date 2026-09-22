/**
 * 从 provider 上游拉取可用模型列表（OpenAI 兼容 `GET {baseUrl}/models`）。
 *
 * 这是自托管版补的「获取模型」能力：官方 v3.14.0 / 3.14.1 都只有手工逐个填模型名
 * （`modelsPlaceholder`：「每行一个模型名称」），没有从服务商拉列表的入口。
 * 手机端 bundle 继承的是同一份 ui 源码，所以桌面端做好即等于远程端也有。
 */

/** 上游返回的模型条目（只保留列表展示需要的字段） */
export interface ProviderModelCatalogEntry {
  readonly modelId: string;
  /** 上游给的归属方（OpenAI 兼容字段 owned_by），仅作展示 */
  readonly ownedBy?: string;
}

export interface FetchProviderModelsInput {
  readonly baseUrl: string;
  readonly apiKey?: string;
  /** provider 配置里的自定义 headers（如某些中转站要求的额外头） */
  readonly headers?: Readonly<Record<string, string>> | null;
  /** 超时（毫秒），默认 15s —— 中转站偶尔很慢，但不能无限等 */
  readonly timeoutMs?: number;
  /** 测试注入用 */
  readonly fetchImpl?: typeof fetch;
}

const DEFAULT_TIMEOUT_MS = 15_000;

/** 把 baseUrl 规范化成 `<origin>/<path>` 形式，去掉尾部斜杠，避免拼出 `//models` */
export function resolveModelsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  return `${trimmed}/models`;
}

/**
 * 解析 `/models` 的响应。OpenAI 兼容格式是 `{ data: [{ id, owned_by }] }`，
 * 但也见到过直接返回数组或 `{ models: [...] }` 的实现，一并兼容。
 */
export function parseProviderModelsPayload(payload: unknown): ProviderModelCatalogEntry[] {
  const rawList: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray((payload as { data?: unknown })?.data)
      ? ((payload as { data: unknown[] }).data ?? [])
      : Array.isArray((payload as { models?: unknown })?.models)
        ? ((payload as { models: unknown[] }).models ?? [])
        : [];

  const seen = new Set<string>();
  const entries: ProviderModelCatalogEntry[] = [];
  for (const item of rawList) {
    // 条目可能是字符串（少数实现直接给 id 列表）或对象
    const record = typeof item === "string" ? { id: item } : (item as Record<string, unknown>);
    const id = typeof record?.id === "string" ? record.id.trim() : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const ownedBy = typeof record?.owned_by === "string" ? record.owned_by.trim() : "";
    entries.push({ modelId: id, ...(ownedBy ? { ownedBy } : {}) });
  }
  return entries;
}

/** 拉取并解析；失败时抛出带可读原因的 Error（UI 直接展示） */
export async function fetchProviderModels(
  input: FetchProviderModelsInput,
): Promise<ProviderModelCatalogEntry[]> {
  const baseUrl = input.baseUrl?.trim();
  if (!baseUrl) {
    throw new Error("该供应商未配置 Base URL，无法获取模型列表");
  }
  const doFetch = input.fetchImpl ?? fetch;
  const endpoint = resolveModelsEndpoint(baseUrl);

  let response: Response;
  try {
    response = await doFetch(endpoint, {
      method: "GET",
      headers: {
        Accept: "application/json",
        ...(input.apiKey ? { Authorization: `Bearer ${input.apiKey}` } : {}),
        ...(input.headers ?? {}),
      },
      signal: AbortSignal.timeout(input.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`请求 ${endpoint} 失败：${reason}`);
  }

  if (!response.ok) {
    // 401/403 是最常见的配置错误，直接点明，省得用户猜
    const hint =
      response.status === 401 || response.status === 403
        ? "（API Key 可能无效或没有列模型权限）"
        : "";
    throw new Error(`上游返回 HTTP ${response.status} ${response.statusText}${hint}`);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("上游返回的不是合法 JSON，可能不是 OpenAI 兼容接口");
  }

  const entries = parseProviderModelsPayload(payload);
  if (entries.length === 0) {
    throw new Error("上游返回了空的模型列表");
  }
  return entries;
}
