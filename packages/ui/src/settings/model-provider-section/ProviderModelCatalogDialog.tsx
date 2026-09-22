/**
 * 「获取模型」弹窗：从 provider 上游拉取可用模型列表（OpenAI 兼容 GET /models），
 * 勾选后批量加入该供应商的模型列表。
 *
 * 官方 v3.14.0 / 3.14.1 都没有这个入口（只有「每行一个模型名称」的手工填写），
 * 这里是自托管版补的能力。加入时走 useRecommendedConfig，让智能配置自动填好
 * 上下文长度 / 最大输出 / 图片支持等参数，之后仍可在模型编辑器里单独调整。
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2Icon, RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Input } from "@/components/ui/input.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import type { ProviderModelCatalogEntry } from "@zcode/services";
import { cn } from "@/components/lib/utils.js";

export interface ProviderModelCatalogDialogProps {
  open: boolean;
  providerId: string;
  providerName?: string;
  /** 已经在列表里的模型，置灰不可重复勾选 */
  existingModelIds: readonly string[];
  /** 拉取上游模型列表（失败时抛 Error，message 直接展示） */
  listModels: (providerId: string) => Promise<readonly ProviderModelCatalogEntry[]>;
  /** 批量加入选中的模型 */
  onAdd: (modelIds: readonly string[]) => Promise<void>;
  onOpenChange: (open: boolean) => void;
}

export function ProviderModelCatalogDialog({
  open,
  providerId,
  providerName,
  existingModelIds,
  listModels,
  onAdd,
  onOpenChange,
}: ProviderModelCatalogDialogProps) {
  const { intl } = useZCodeIntl();
  const [entries, setEntries] = useState<readonly ProviderModelCatalogEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [keyword, setKeyword] = useState("");
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  const existing = useMemo(() => new Set(existingModelIds), [existingModelIds]);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await listModels(providerId);
      setEntries(next);
      setSelected(new Set());
    } catch (cause) {
      setEntries(null);
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, [listModels, providerId]);

  // 每次打开都重新拉一次：上游模型列表会变，缓存反而误导。
  useEffect(() => {
    if (!open) return;
    setKeyword("");
    setSelected(new Set());
    void load();
  }, [open, load]);

  const visible = useMemo(() => {
    const all = entries ?? [];
    const trimmed = keyword.trim().toLowerCase();
    if (!trimmed) return all;
    return all.filter((item) => item.modelId.toLowerCase().includes(trimmed));
  }, [entries, keyword]);

  const toggle = (modelId: string): void => {
    if (existing.has(modelId)) return;
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(modelId)) next.delete(modelId);
      else next.add(modelId);
      return next;
    });
  };

  const commit = async (): Promise<void> => {
    if (saving || selected.size === 0) return;
    setSaving(true);
    setError(null);
    try {
      await onAdd([...selected]);
      onOpenChange(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[80vh] flex-col overflow-hidden sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {intl.formatMessage({ id: "settings.modelProvider.fetchModels.title" })}
          </DialogTitle>
          <DialogDescription className="min-w-0 break-words">
            {intl.formatMessage(
              { id: "settings.modelProvider.fetchModels.description" },
              { provider: providerName || providerId },
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2">
          <Input
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder={intl.formatMessage({
              id: "settings.modelProvider.fetchModels.searchPlaceholder",
            })}
            className="min-w-0 flex-1"
          />
          <Button
            type="button"
            variant="ghost"
            size="default"
            disabled={loading || saving}
            onClick={() => void load()}
            aria-label={intl.formatMessage({ id: "settings.modelProvider.fetchModels.retry" })}
          >
            <RefreshCw className={cn("size-4", loading && "animate-spin")} aria-hidden="true" />
          </Button>
        </div>

        <div className="min-h-[8rem] flex-1 overflow-y-auto rounded-lg border border-input-border bg-input">
          {loading ? (
            <div className="flex h-32 items-center justify-center gap-2 text-foreground-subtle">
              <Loader2Icon className="size-4 animate-spin" aria-hidden="true" />
              {intl.formatMessage({ id: "settings.modelProvider.fetchModels.loading" })}
            </div>
          ) : error ? (
            <div className="p-3 text-ui-base text-destructive break-words">{error}</div>
          ) : visible.length === 0 ? (
            <div className="p-3 text-ui-base text-foreground-subtle">
              {intl.formatMessage({ id: "settings.modelProvider.fetchModels.empty" })}
            </div>
          ) : (
            <ul className="divide-y divide-input-border">
              {visible.map((item) => {
                const already = existing.has(item.modelId);
                const checked = selected.has(item.modelId);
                return (
                  <li key={item.modelId}>
                    <label
                      className={cn(
                        "flex cursor-pointer items-center gap-3 px-3 py-2",
                        already && "cursor-not-allowed opacity-50",
                      )}
                    >
                      <input
                        type="checkbox"
                        className="size-4 shrink-0"
                        checked={checked || already}
                        disabled={already || saving}
                        onChange={() => toggle(item.modelId)}
                      />
                      <span className="min-w-0 flex-1 truncate text-ui-base" title={item.modelId}>
                        {item.modelId}
                      </span>
                      {already ? (
                        <span className="shrink-0 text-ui-xs text-foreground-subtle">
                          {intl.formatMessage({ id: "settings.modelProvider.fetchModels.already" })}
                        </span>
                      ) : item.ownedBy ? (
                        <span className="shrink-0 text-ui-xs text-foreground-subtle">
                          {item.ownedBy}
                        </span>
                      ) : null}
                    </label>
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div className="flex items-center justify-between gap-3">
          <span className="text-ui-base text-foreground-subtle">
            {intl.formatMessage(
              { id: "settings.modelProvider.fetchModels.selected" },
              { count: selected.size },
            )}
          </span>
          <div className="flex gap-2">
            <Button
              type="button"
              variant="ghost"
              size="lg"
              disabled={saving}
              onClick={() => onOpenChange(false)}
            >
              {intl.formatMessage({ id: "settings.modelProvider.fetchModels.cancel" })}
            </Button>
            <Button
              type="button"
              variant="default"
              size="lg"
              disabled={saving || selected.size === 0}
              onClick={() => void commit()}
            >
              {saving
                ? intl.formatMessage({ id: "settings.modelProvider.fetchModels.adding" })
                : intl.formatMessage({ id: "settings.modelProvider.fetchModels.add" })}
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
