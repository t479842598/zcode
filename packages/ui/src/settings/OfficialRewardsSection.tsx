import { useCallback, useMemo, useRef, useState } from "react";
import { ExternalLinkIcon, RefreshCwIcon, XIcon } from "lucide-react";
import { buildZCodeRewardsUrl, ZCODE_VERSION } from "@zcode/shared";
import type { ICredentialService, IOAuthService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { EmbeddedWebsiteHeader } from "@/components/EmbeddedWebsiteHeader.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { useZCodeStoreWithDefault } from "@/store/StoreProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

const REWARD_CREDENTIAL_KEYS = [
  "oauth:zai:access_token",
  "oauth:bigmodel:access_token",
  "zcodejwttoken",
] as const;

type RewardLocale = "zh-CN" | "en-US";
type RewardTheme = "zai-light" | "zai-dark";

function createRewardsContextScript(input: {
  locale: RewardLocale;
  theme: RewardTheme;
  credentials: Record<string, string>;
  provider: "zai" | "bigmodel" | null;
  userId: string | null;
}): string {
  const providerCredentialKey =
    input.provider === "bigmodel" ? "oauth:bigmodel:access_token" : "oauth:zai:access_token";
  const authReady = Boolean(
    input.userId &&
    (input.credentials[providerCredentialKey] || input.credentials["zcodejwttoken"]),
  );
  return `(() => {
  const credentials = ${JSON.stringify(input.credentials)};
  for (const key of ${JSON.stringify(REWARD_CREDENTIAL_KEYS)}) localStorage.removeItem(key);
  for (const [key, value] of Object.entries(credentials)) localStorage.setItem(key, value);
  localStorage.setItem("zcode-theme", ${JSON.stringify(input.theme)});
  window.dispatchEvent(new CustomEvent("zcode-rewards-context", { detail: ${JSON.stringify({
    theme: input.theme,
    locale: input.locale,
    auth: {
      status: authReady ? "ready" : "anonymous",
      provider: authReady ? input.provider : null,
      revision: Date.now(),
    },
  })} }));
})()`;
}

function createRewardsCredentialClearScript(): string {
  return `(() => {
  for (const key of ${JSON.stringify(REWARD_CREDENTIAL_KEYS)}) localStorage.removeItem(key);
})()`;
}

export function OfficialRewardsSection({
  credentialService,
  oauthService,
}: {
  credentialService: Pick<ICredentialService, "load">;
  oauthService: Pick<IOAuthService, "getActiveProvider">;
}) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const theme = useZCodeStoreWithDefault((state) => state.theme, "zai-dark") as RewardTheme;
  const userId = useZCodeStoreWithDefault((state) => state.user?.id ?? null, null);
  const [open, setOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const webviewRef = useRef<ElectronWebviewTag | null>(null);
  const webviewUrl = useMemo(
    () => buildZCodeRewardsUrl({ locale: locale === "zh-CN" ? "zh-CN" : "en-US", theme }),
    [locale, theme],
  );

  const injectContext = useCallback(
    async (webview: ElectronWebviewTag | null) => {
      if (!webview) return;
      setLoading(true);
      try {
        const activeProvider = userId ? await oauthService.getActiveProvider() : null;
        const provider =
          activeProvider === "bigmodel" ? "bigmodel" : activeProvider === "zai" ? "zai" : null;
        const [accessToken, zcodeJwtToken] = provider
          ? await Promise.all([
              credentialService.load(`oauth:${provider}:access_token`),
              credentialService.load("zcodejwttoken"),
            ])
          : [null, null];
        const credentials = Object.fromEntries(
          [
            [`oauth:${provider}:access_token`, accessToken?.trim() ?? ""],
            ["zcodejwttoken", zcodeJwtToken?.trim() ?? ""],
          ].filter(([, value]) => value),
        );
        await webview.executeJavaScript(
          createRewardsContextScript({
            locale: locale === "zh-CN" ? "zh-CN" : "en-US",
            theme,
            credentials,
            provider,
            userId,
          }),
          true,
        );
      } finally {
        setLoading(false);
      }
    },
    [credentialService, locale, oauthService, theme, userId],
  );

  const close = useCallback(() => {
    const webview = webviewRef.current;
    if (webview)
      void webview.executeJavaScript(createRewardsCredentialClearScript(), true).catch(() => {});
    setOpen(false);
  }, []);

  if (!open) {
    return (
      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.officialRewards.title" })}
          description={intl.formatMessage({ id: "settings.officialRewards.description" })}
          control={
            <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
              {intl.formatMessage({ id: "settings.officialRewards.open" })}
            </Button>
          }
          detail={
            <p className="text-ui-base text-foreground-subtle">
              {intl.formatMessage(
                { id: "settings.officialRewards.version" },
                { version: ZCODE_VERSION },
              )}
            </p>
          }
        />
      </SettingsGroupCard>
    );
  }

  return (
    <section className="fixed inset-0 z-50 flex flex-col overflow-hidden bg-background pt-12 text-foreground">
      <EmbeddedWebsiteHeader
        title={intl.formatMessage({ id: "settings.officialRewards.title" })}
        loading={loading}
        canGoBack={false}
        canGoForward={false}
        onBack={() => {}}
        onForward={() => {}}
        onReload={() => webviewRef.current?.reload()}
        onClose={close}
      />
      <main className="mx-auto flex min-h-0 w-full max-w-5xl flex-1 flex-col px-6 pb-8 pt-2 max-sm:px-4">
        <div className="mb-3 flex items-center justify-between gap-2 text-ui-base text-foreground-subtle">
          <span>{intl.formatMessage({ id: "settings.officialRewards.description" })}</span>
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => webviewRef.current?.reload()}
              aria-label={intl.formatMessage({ id: "settings.officialRewards.reload" })}
            >
              <RefreshCwIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={() => platform.openExternal(webviewUrl)}
              aria-label={intl.formatMessage({ id: "settings.officialRewards.external" })}
            >
              <ExternalLinkIcon />
            </Button>
            <Button
              variant="ghost"
              size="icon-sm"
              onClick={close}
              aria-label={intl.formatMessage({ id: "settings.officialRewards.close" })}
            >
              <XIcon />
            </Button>
          </div>
        </div>
        <webview
          ref={(element) => {
            webviewRef.current = element;
            if (element) {
              element.addEventListener("dom-ready", () => void injectContext(element));
            }
          }}
          src={webviewUrl}
          allowpopups={true}
          className="min-h-0 flex-1 overflow-hidden rounded-xl border border-border bg-card"
        />
      </main>
    </section>
  );
}
