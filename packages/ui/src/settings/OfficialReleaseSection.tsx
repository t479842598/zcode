import { useCallback, useEffect, useState } from "react";
import { compareSemverVersions, ZCODE_VERSION } from "@zcode/shared";
import type { ISystemService } from "@zcode/services";
import { Button } from "@/components/ui/button.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { usePlatform } from "@/hooks/usePlatform.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";

type ReleaseInfo = NonNullable<
  Awaited<ReturnType<NonNullable<ISystemService["getOfficialReleaseInfo"]>>>
>;

export function OfficialReleaseSection({ systemService }: { systemService: ISystemService }) {
  const { intl, locale } = useZCodeIntl();
  const platform = usePlatform();
  const [release, setRelease] = useState<ReleaseInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const refresh = useCallback(async () => {
    if (!systemService.getOfficialReleaseInfo) return;
    setLoading(true);
    setError(false);
    try {
      setRelease(await systemService.getOfficialReleaseInfo(locale));
    } catch {
      setError(true);
    } finally {
      setLoading(false);
    }
  }, [locale, systemService]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  const comparison = release ? compareSemverVersions(release.version, ZCODE_VERSION) : null;
  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.officialRelease.title" })}
        description={intl.formatMessage({ id: "settings.officialRelease.description" })}
        control={
          <Button
            variant="outline"
            size="sm"
            disabled={loading || !systemService.getOfficialReleaseInfo}
            onClick={() => void refresh()}
          >
            {intl.formatMessage({ id: "settings.officialRelease.refresh" })}
          </Button>
        }
        detail={
          <div className="space-y-2 text-ui-base text-foreground-subtle">
            <p>
              {intl.formatMessage(
                { id: "settings.officialRelease.localVersion" },
                { version: ZCODE_VERSION },
              )}
            </p>
            {release ? (
              <>
                <p>
                  {intl.formatMessage(
                    { id: "settings.officialRelease.officialVersion" },
                    { version: release.version },
                  )}
                </p>
                <p>
                  {intl.formatMessage(
                    { id: "settings.officialRelease.releaseDate" },
                    { date: release.releaseDate || "—" },
                  )}
                </p>
                <p>
                  {intl.formatMessage(
                    { id: "settings.officialRelease.checkedAt" },
                    { time: new Date(release.checkedAt).toLocaleString(locale) },
                  )}
                </p>
                <p>
                  {intl.formatMessage({
                    id:
                      comparison === null
                        ? "settings.officialRelease.unknown"
                        : comparison > 0
                          ? "settings.officialRelease.newer"
                          : comparison === 0
                            ? "settings.officialRelease.same"
                            : "settings.officialRelease.older",
                  })}
                </p>
                <pre className="whitespace-pre-wrap break-words font-sans">
                  {release.releaseNotes ||
                    intl.formatMessage({ id: "settings.officialRelease.noNotes" })}
                </pre>
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => platform.openExternal(release.sourceUrl)}
                >
                  {intl.formatMessage({ id: "settings.officialRelease.source" })}
                </Button>
              </>
            ) : null}
            {loading ? (
              <p>{intl.formatMessage({ id: "settings.officialRelease.loading" })}</p>
            ) : null}
            {error ? (
              <p role="alert">{intl.formatMessage({ id: "settings.officialRelease.error" })}</p>
            ) : null}
          </div>
        }
      />
    </SettingsGroupCard>
  );
}
