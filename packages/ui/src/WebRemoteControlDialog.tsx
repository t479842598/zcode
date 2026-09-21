import { useEffect, useState } from "react";
import type { WebRemoteControlState } from "@zcode/services";
import { Check, Copy, RefreshCw, Smartphone } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog.js";
import { Button } from "@/components/ui/button.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

const STATUS_DOT_CLASS: Record<WebRemoteControlState["status"], string> = {
  disabled: "bg-muted-foreground",
  connecting: "bg-warning animate-pulse",
  waiting: "bg-warning animate-pulse",
  connected: "bg-success",
};

/**
 * 「移动端远程控制」弹窗：展示状态、扫码二维码与可复制的连接链接。
 *
 * 状态来自 host 侧自建中继桥（relayDeviceBootstrap → IWebRemoteControlService）。
 * 手机端打开链接后成为 terminal，即可远程操控本机工作区。
 */
export function WebRemoteControlDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const { intl } = useZCodeIntl();
  const services = useServices();
  const service = services.webRemoteControlService;
  const [state, setState] = useState<WebRemoteControlState | null>(null);
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  // 打开时拉取一次状态，并订阅 host 侧推送
  useEffect(() => {
    if (!open || !service) return;
    let cancelled = false;
    void service.getState().then((next) => {
      if (!cancelled) setState(next);
    });
    const subscription = service.onDynamicDidChangeState()((next) => {
      if (!cancelled) setState(next);
    });
    return () => {
      cancelled = true;
      subscription.dispose();
    };
  }, [open, service]);

  // 二维码按需生成，避免把 qrcode 拉进主 bundle
  useEffect(() => {
    const url = state?.connectUrl;
    if (!open || !url) {
      setQrDataUrl(null);
      return;
    }
    let cancelled = false;
    void import("qrcode")
      .then((module) => module.toDataURL(url, { margin: 1, width: 240 }))
      .then((dataUrl) => {
        if (!cancelled) setQrDataUrl(dataUrl);
      })
      .catch(() => {
        if (!cancelled) setQrDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, state?.connectUrl]);

  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(false), 1_500);
    return () => clearTimeout(timer);
  }, [copied]);

  const status = state?.status ?? "disabled";
  const connectUrl = state?.connectUrl;
  const statusLabel = intl.formatMessage({ id: `webRemoteControl.status.${status}` });
  const statusDetail = intl.formatMessage({ id: `webRemoteControl.statusDetail.${status}` });

  const copyLink = async () => {
    if (!connectUrl) return;
    try {
      await navigator.clipboard.writeText(connectUrl);
      setCopied(true);
    } catch {
      /* 剪贴板不可用时链接仍可手动选中复制 */
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="overflow-hidden sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Smartphone className="size-4" />
            {intl.formatMessage({ id: "webRemoteControl.title" })}
          </DialogTitle>
          <DialogDescription>
            {intl.formatMessage({ id: "webRemoteControl.description" })}
          </DialogDescription>
        </DialogHeader>

        <div className="flex items-center gap-2 rounded-lg border border-border bg-surface px-3 py-2">
          <span className={`size-2 shrink-0 rounded-full ${STATUS_DOT_CLASS[status]}`} />
          <div className="min-w-0">
            <p className="text-ui-xs font-medium">{statusLabel}</p>
            <p className="text-ui-xs text-foreground-subtle">{statusDetail}</p>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            className="ml-auto shrink-0"
            aria-label={intl.formatMessage({ id: "webRemoteControl.refresh" })}
            onClick={() => {
              void service?.getState().then(setState);
            }}
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>

        {qrDataUrl ? (
          <div className="flex justify-center">
            <img
              alt={intl.formatMessage({ id: "webRemoteControl.qrAlt" })}
              className="size-60 rounded-lg bg-white p-2"
              src={qrDataUrl}
            />
          </div>
        ) : (
          <p className="px-4 py-8 text-center text-ui-xs text-foreground-subtle">{statusLabel}</p>
        )}

        {connectUrl ? (
          // grid 子项默认 min-width:auto，而 code 里的 url 是一个不可断行的长串，
          // 不显式 min-w-0 会把 grid track 撑破，连带二维码一起被推出弹窗。
          <div className="flex min-w-0 items-center gap-2">
            <code
              className="min-w-0 flex-1 truncate rounded-md border border-border bg-surface px-2 py-1.5 text-ui-xs text-foreground-subtle"
              title={connectUrl}
            >
              {connectUrl}
            </code>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="shrink-0"
              onClick={() => void copyLink()}
            >
              {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
              {intl.formatMessage({
                id: copied ? "webRemoteControl.copied" : "webRemoteControl.copyLink",
              })}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
