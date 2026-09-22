/**
 * 自助备份类型与服务描述符
 *
 * 移植自 kuoniya/ZCode-Rev（Apache-2.0）的 repo-snapshot 自助备份改造：
 * 用户自己提供阿里云 OSS 凭证、自己持有加密密码，数据备份到用户自己的
 * Bucket，全程不经过任何官方服务器。
 */

import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

export interface SelfBackupOssConfig {
  accessKeyId?: string;
  bucket?: string;
  endpoint?: string;
  prefix?: string;
}

export interface SelfBackupEncryptionConfig {
  mode?: "aes-256-ctr" | "none";
}

export interface SelfBackupScheduleConfig {
  /** 定时间隔秒；0/缺省 = 仅手动触发 */
  intervalSeconds?: number;
  /** 快照数量上限，超出清理最旧的 */
  maxSnapshots?: number;
}

export interface SelfBackupFilterConfig {
  includeGitDir?: boolean;
  includeGitLfs?: boolean;
}

/** AppSettings.selfBackup 的结构（秘密字段不在此，走 credentialService） */
export interface SelfBackupSettings {
  enabled?: boolean;
  oss?: SelfBackupOssConfig;
  encryption?: SelfBackupEncryptionConfig;
  schedule?: SelfBackupScheduleConfig;
  filter?: SelfBackupFilterConfig;
}

export interface SelfBackupStatus {
  configured: boolean;
  enabled: boolean;
  /** intervalSeconds > 0 表示已配置定时 */
  intervalSeconds: number;
}

export interface SelfBackupResult {
  snapshotId: string;
  kind: "baseline" | "increment";
  fileCount: number;
  totalBytes: number;
  archiveSizeBytes: number;
  encrypted: boolean;
  ossObjectKey?: string;
  durationMs: number;
}

export interface IBackupService {
  /** 当前配置状态（UI 判断按钮可用性） */
  getStatus(): Promise<SelfBackupStatus>;
  /** 对指定工作区立即执行一次备份；配置不完整时抛带中文信息的 Error */
  backupNow(input: {
    workspacePath: string;
    workspaceIdentity?: string;
  }): Promise<SelfBackupResult>;
  /**
   * 设置保存后重排 interval 定时器。
   * 传 workspacePath 则以其为定时目标（把当前活动工作区变成“最近一次备份”）；
   * 不传则仅按当前配置重排（interval<=0 清除定时器）。
   */
  reloadSchedule(input?: { workspacePath?: string; workspaceIdentity?: string }): Promise<void>;
}

export const IBackupService = createServiceDescriptor<IBackupService>(ServiceChannels.SelfBackup);
