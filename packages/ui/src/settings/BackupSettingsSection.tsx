import { useCallback, useEffect, useState } from "react";
import { Switch } from "@/components/ui/switch.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select.js";
import { toast } from "@/components/ui/toast.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { SettingsGroupCard, SettingsRow } from "@/settings/SettingsPageParts.js";
import { useSettings } from "@/hooks/useSettingService.js";
import { useServices } from "@/hooks/useServices.js";
import { formatBytes } from "@/resource-manager/resourceUsageView.js";
import type { SelfBackupResult, SelfBackupSettings } from "@zcode/services";

const CREDENTIAL_KEY_SECRET = "selfbackup:oss:accessKeySecret";
const CREDENTIAL_KEY_PASSPHRASE = "selfbackup:encryption:passphrase";

interface BackupSettingsSectionProps {
  workspacePath?: string;
  workspaceIdentity?: string;
}

/**
 * 自助备份设置（自托管）：用户自己的阿里云 OSS 凭证 + 自持加密密码。
 * 结构化配置存 AppSettings.selfBackup；Secret/密码存 credentialService（加密存储）。
 * 未接入 backupService 的环境（web stub）降级为只读提示。
 */
export function BackupSettingsSection({
  workspacePath,
  workspaceIdentity,
}: BackupSettingsSectionProps) {
  const { intl } = useZCodeIntl();
  const { settings, update } = useSettings();
  const { credentialService, backupService } = useServices();

  const selfBackup: SelfBackupSettings = settings?.selfBackup ?? {};

  const [secretConfigured, setSecretConfigured] = useState(false);
  const [passphraseConfigured, setPassphraseConfigured] = useState(false);
  // 秘密字段只写不读：输入框保持本地态，不回显已存储值
  const [secretInput, setSecretInput] = useState("");
  const [passphraseInput, setPassphraseInput] = useState("");

  useEffect(() => {
    let cancelled = false;
    void Promise.all([
      credentialService.load(CREDENTIAL_KEY_SECRET),
      credentialService.load(CREDENTIAL_KEY_PASSPHRASE),
    ])
      .then(([secret, passphrase]) => {
        if (cancelled) return;
        setSecretConfigured(Boolean(secret));
        setPassphraseConfigured(Boolean(passphrase));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [credentialService]);

  const patchSelfBackup = useCallback(
    async (patch: Partial<SelfBackupSettings>) => {
      const next: SelfBackupSettings = { ...selfBackup, ...patch };
      await update({ selfBackup: next });
      // interval/enabled 变更后让 host 侧重排定时器；当前活动工作区作为定时目标
      await backupService?.reloadSchedule?.({
        workspacePath,
        workspaceIdentity,
      });
    },
    [selfBackup, update, backupService, workspacePath, workspaceIdentity],
  );

  const handleSecretChange = useCallback(
    (value: string) => {
      setSecretInput(value);
      if (!value) {
        // 输入被清空视为撤销配置
        void credentialService.delete(CREDENTIAL_KEY_SECRET).then(() => setSecretConfigured(false));
        return;
      }
      void credentialService
        .save(CREDENTIAL_KEY_SECRET, value)
        .then(() => setSecretConfigured(true));
    },
    [credentialService],
  );

  const handlePassphraseChange = useCallback(
    (value: string) => {
      setPassphraseInput(value);
      if (!value) {
        void credentialService
          .delete(CREDENTIAL_KEY_PASSPHRASE)
          .then(() => setPassphraseConfigured(false));
        return;
      }
      void credentialService
        .save(CREDENTIAL_KEY_PASSPHRASE, value)
        .then(() => setPassphraseConfigured(Boolean(value)));
    },
    [credentialService],
  );

  if (!backupService) {
    return (
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.backup.unsupported" })}
      </p>
    );
  }

  const oss = selfBackup.oss ?? {};
  const encryptionMode = selfBackup.encryption?.mode ?? "aes-256-ctr";
  const intervalSeconds = selfBackup.schedule?.intervalSeconds ?? 0;
  const includeGitDir = selfBackup.filter?.includeGitDir ?? true;
  const includeGitLfs = selfBackup.filter?.includeGitLfs ?? true;
  const enabled = selfBackup.enabled === true;

  return (
    <div className="space-y-6">
      <p className="text-ui-base text-foreground-subtle">
        {intl.formatMessage({ id: "settings.backup.description" })}
      </p>

      <SettingsGroupCard>
        <SettingsRow
          label={intl.formatMessage({ id: "settings.backup.enabled" })}
          description={intl.formatMessage({ id: "settings.backup.enabledDescription" })}
          control={
            <Switch
              checked={enabled}
              onCheckedChange={(checked) => void patchSelfBackup({ enabled: checked })}
            />
          }
        />
      </SettingsGroupCard>

      <div>
        <h3 className="mb-3 text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.backup.ossTitle" })}
        </h3>
        <SettingsGroupCard>
          <SettingsRow
            label="AccessKeyId"
            controlLayout="wide"
            control={
              <Input
                size="lg"
                value={oss.accessKeyId ?? ""}
                onChange={(e) =>
                  void patchSelfBackup({ oss: { ...oss, accessKeyId: e.target.value } })
                }
                placeholder="LTAI5t..."
                className="w-full"
              />
            }
          />
          <SettingsRow
            label="AccessKeySecret"
            description={
              secretConfigured
                ? intl.formatMessage({ id: "settings.backup.secretConfigured" })
                : undefined
            }
            controlLayout="wide"
            control={
              <Input
                size="lg"
                type="password"
                value={secretInput}
                onChange={(e) => handleSecretChange(e.target.value)}
                placeholder={
                  secretConfigured
                    ? intl.formatMessage({ id: "settings.backup.secretPlaceholderConfigured" })
                    : "AccessKeySecret"
                }
                autoComplete="new-password"
                className="w-full"
              />
            }
          />
          <SettingsRow
            label="Bucket"
            controlLayout="wide"
            control={
              <Input
                size="lg"
                value={oss.bucket ?? ""}
                onChange={(e) => void patchSelfBackup({ oss: { ...oss, bucket: e.target.value } })}
                placeholder="my-backup-bucket"
                className="w-full"
              />
            }
          />
          <SettingsRow
            label="Endpoint"
            description={intl.formatMessage({ id: "settings.backup.endpointDescription" })}
            controlLayout="wide"
            control={
              <Input
                size="lg"
                value={oss.endpoint ?? ""}
                onChange={(e) =>
                  void patchSelfBackup({ oss: { ...oss, endpoint: e.target.value } })
                }
                placeholder="https://oss-cn-hangzhou.aliyuncs.com"
                className="w-full"
              />
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "settings.backup.prefix" })}
            controlLayout="wide"
            control={
              <Input
                size="lg"
                value={oss.prefix ?? ""}
                onChange={(e) => void patchSelfBackup({ oss: { ...oss, prefix: e.target.value } })}
                placeholder="backups/my-project/"
                className="w-full"
              />
            }
          />
        </SettingsGroupCard>
      </div>

      <div>
        <h3 className="mb-3 text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.backup.encryptionTitle" })}
        </h3>
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.backup.encryptionMode" })}
            control={
              <Select
                value={encryptionMode}
                onValueChange={(value) =>
                  void patchSelfBackup({ encryption: { mode: value as "aes-256-ctr" | "none" } })
                }
              >
                <SelectTrigger size="lg" className="w-56">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="aes-256-ctr">
                    {intl.formatMessage({ id: "settings.backup.encryptionModeAes" })}
                  </SelectItem>
                  <SelectItem value="none">
                    {intl.formatMessage({ id: "settings.backup.encryptionModeNone" })}
                  </SelectItem>
                </SelectContent>
              </Select>
            }
          />
          {encryptionMode === "aes-256-ctr" ? (
            <SettingsRow
              label={intl.formatMessage({ id: "settings.backup.passphrase" })}
              description={intl.formatMessage({ id: "settings.backup.passphraseDescription" })}
              controlLayout="wide"
              control={
                <Input
                  size="lg"
                  type="password"
                  value={passphraseInput}
                  onChange={(e) => handlePassphraseChange(e.target.value)}
                  placeholder={
                    passphraseConfigured
                      ? intl.formatMessage({ id: "settings.backup.secretPlaceholderConfigured" })
                      : intl.formatMessage({ id: "settings.backup.passphrase" })
                  }
                  autoComplete="new-password"
                  className="w-full"
                />
              }
            />
          ) : null}
        </SettingsGroupCard>
      </div>

      <div>
        <h3 className="mb-3 text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.backup.filterTitle" })}
        </h3>
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.backup.includeGitDir" })}
            description={intl.formatMessage({ id: "settings.backup.includeGitDirDescription" })}
            control={
              <Switch
                checked={includeGitDir}
                onCheckedChange={(checked) =>
                  void patchSelfBackup({ filter: { ...selfBackup.filter, includeGitDir: checked } })
                }
              />
            }
          />
          <SettingsRow
            label={intl.formatMessage({ id: "settings.backup.includeGitLfs" })}
            description={intl.formatMessage({ id: "settings.backup.includeGitLfsDescription" })}
            control={
              <Switch
                checked={includeGitLfs}
                disabled={!includeGitDir}
                onCheckedChange={(checked) =>
                  void patchSelfBackup({ filter: { ...selfBackup.filter, includeGitLfs: checked } })
                }
              />
            }
          />
        </SettingsGroupCard>
      </div>

      <div>
        <h3 className="mb-3 text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.backup.intervalTitle" })}
        </h3>
        <SettingsGroupCard>
          <SettingsRow
            label={intl.formatMessage({ id: "settings.backup.interval" })}
            description={intl.formatMessage({ id: "settings.backup.intervalDescription" })}
            controlLayout="wide"
            control={
              <Input
                size="lg"
                type="number"
                min={0}
                value={String(intervalSeconds)}
                onChange={(e) => {
                  const parsed = Number.parseInt(e.target.value, 10);
                  const next = Number.isFinite(parsed) && parsed >= 0 ? parsed : 0;
                  void patchSelfBackup({
                    schedule: { ...selfBackup.schedule, intervalSeconds: next },
                  });
                }}
                placeholder={intl.formatMessage({ id: "settings.backup.intervalPlaceholder" })}
                className="w-full"
              />
            }
          />
        </SettingsGroupCard>
      </div>

      <div>
        <h3 className="mb-3 text-ui-base font-semibold text-foreground">
          {intl.formatMessage({ id: "settings.backup.manualTitle" })}
        </h3>
        <ManualBackupRow workspacePath={workspacePath} workspaceIdentity={workspaceIdentity} />
      </div>
    </div>
  );
}

/** 手动备份入口：独立成行，自包含运行态与结果提示 */
function ManualBackupRow({ workspacePath, workspaceIdentity }: BackupSettingsSectionProps) {
  const { intl } = useZCodeIntl();
  const { backupService } = useServices();
  const [running, setRunning] = useState(false);

  const handleRunBackup = useCallback(async () => {
    if (!backupService) {
      toast(intl.formatMessage({ id: "settings.backup.unsupported" }));
      return;
    }
    if (!workspacePath) {
      toast(intl.formatMessage({ id: "settings.backup.runDisabledNoWorkspace" }));
      return;
    }
    const status = await backupService.getStatus();
    if (!status.configured) {
      toast(intl.formatMessage({ id: "settings.backup.notConfigured" }));
      return;
    }
    setRunning(true);
    try {
      const result: SelfBackupResult = await backupService.backupNow({
        workspacePath,
        workspaceIdentity,
      });
      toast(
        intl.formatMessage(
          { id: "settings.backup.runSuccess" },
          {
            count: result.fileCount,
            size: formatBytes(result.archiveSizeBytes),
            key: result.ossObjectKey ?? "",
          },
        ),
      );
    } catch (error) {
      toast(
        `${intl.formatMessage({ id: "settings.backup.runFailed" })}: ${error instanceof Error ? error.message : String(error)}`,
        { variant: "warning" },
      );
    } finally {
      setRunning(false);
    }
  }, [backupService, workspacePath, workspaceIdentity, intl]);

  return (
    <SettingsGroupCard>
      <SettingsRow
        label={intl.formatMessage({ id: "settings.backup.manualDescription" })}
        control={
          <Button
            variant="outline"
            size="lg"
            disabled={running || !workspacePath}
            onClick={() => void handleRunBackup()}
          >
            {running
              ? intl.formatMessage({ id: "settings.backup.running" })
              : !workspacePath
                ? intl.formatMessage({ id: "settings.backup.runDisabledNoWorkspace" })
                : intl.formatMessage({ id: "settings.backup.run" })}
          </Button>
        }
      />
    </SettingsGroupCard>
  );
}
