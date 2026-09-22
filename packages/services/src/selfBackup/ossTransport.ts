/**
 * OSS 传输层：目标解析（虚拟主机 / 路径风格）、流式 PUT、列出与删除。
 *
 * 从 selfBackupService 拆出：传输细节与备份编排关注点不同，
 * 单独成文件便于按 OSS 语义演进（分片、断点续传等）。
 */

import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import {
  type ResolvedBackupConfig,
  buildOssAuthorization,
  extractRegionFromEndpoint,
  getDateStrings,
  sha256Hex,
} from "./engine.js";

export interface OssTarget {
  host: string;
  keyPath: string;
  url: string;
}

/**
 * 解析 OSS 请求目标。默认虚拟主机风格 `<bucket>.<endpoint-host>`；
 * 端点主机是 IP（自建 MinIO / OSS 兼容存储）时浏览器/undici 无法解析子域，
 * 退回路径风格 `<endpoint>/<bucket>/<key>`，签名 host 与路径随之调整。
 */
export function resolveOssTarget(config: ResolvedBackupConfig, objectKey: string): OssTarget {
  const endpointUrl = new URL(config.oss.endpoint.replace(/\/+$/, ""));
  const isIpHost = /^\d{1,3}(\.\d{1,3}){3}$/.test(endpointUrl.hostname);
  const host = isIpHost ? endpointUrl.host : `${config.oss.bucket}.${endpointUrl.host}`;
  const keyPath = isIpHost ? `${config.oss.bucket}/${objectKey}` : objectKey;
  return { host, keyPath, url: `${endpointUrl.protocol}//${host}/${keyPath}` };
}

export interface OssTransportOptions {
  fetchImpl?: typeof fetch;
}

export async function uploadObject(
  config: ResolvedBackupConfig,
  opts: { localPath: string; objectKey: string; contentType: string },
  transport: OssTransportOptions = {},
): Promise<void> {
  const { host, keyPath, url } = resolveOssTarget(config, opts.objectKey);
  const region = extractRegionFromEndpoint(config.oss.endpoint);
  const { dateStamp, dateTime } = getDateStrings();
  const fileStat = await stat(opts.localPath);

  const headers = buildOssAuthorization({
    method: "PUT",
    host,
    objectKey: keyPath,
    region,
    accessKeyId: config.oss.accessKeyId,
    accessKeySecret: config.oss.accessKeySecret,
    dateStamp,
    dateTime,
    contentSha256: "UNSIGNED-PAYLOAD",
    contentType: opts.contentType,
  });
  headers["content-length"] = String(fileStat.size);

  const body = createReadStream(opts.localPath);
  const response = await (transport.fetchImpl ?? fetch)(url, {
    method: "PUT",
    headers,
    body: body as unknown as Parameters<typeof fetch>[1] extends RequestInit | undefined
      ? RequestInit["body"]
      : never,
    duplex: "half",
    redirect: "error",
  } as RequestInit);
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    throw new Error(
      `OSS 上传失败: ${response.status} ${response.statusText}${text ? `\n${text.slice(0, 500)}` : ""}`,
    );
  }
}

/** 删除某前缀下的全部对象（快照轮转清理） */
export async function deleteObjectsByPrefix(
  config: ResolvedBackupConfig,
  objectPrefix: string,
  transport: OssTransportOptions = {},
): Promise<void> {
  const region = extractRegionFromEndpoint(config.oss.endpoint);
  const { dateStamp, dateTime } = getDateStrings();
  const fetchImpl = transport.fetchImpl ?? fetch;

  const queryParams = new URLSearchParams({
    "list-type": "2",
    prefix: objectPrefix,
    "max-keys": "1000",
  });
  const listTarget = resolveOssTarget(config, "");
  const listHeaders = buildOssAuthorization({
    method: "GET",
    host: listTarget.host,
    objectKey: listTarget.keyPath.replace(/\/$/, ""),
    region,
    accessKeyId: config.oss.accessKeyId,
    accessKeySecret: config.oss.accessKeySecret,
    dateStamp,
    dateTime,
    contentSha256: sha256Hex(""),
    contentType: "",
  });
  const listResponse = await fetchImpl(`${listTarget.url.replace(/\/$/, "")}/?${queryParams}`, {
    headers: listHeaders,
  });
  if (!listResponse.ok) throw new Error(`OSS 列出对象失败: ${listResponse.status}`);
  const xml = await listResponse.text();
  const keys: string[] = [];
  for (const match of xml.matchAll(/<Key>(.*?)<\/Key>/g)) {
    if (match[1]) keys.push(match[1]);
  }

  for (const key of keys) {
    const target = resolveOssTarget(config, key);
    const headers = buildOssAuthorization({
      method: "DELETE",
      host: target.host,
      objectKey: target.keyPath,
      region,
      accessKeyId: config.oss.accessKeyId,
      accessKeySecret: config.oss.accessKeySecret,
      dateStamp,
      dateTime,
      contentSha256: sha256Hex(""),
      contentType: "",
    });
    const response = await fetchImpl(target.url, { method: "DELETE", headers });
    if (!response.ok && response.status !== 404) {
      throw new Error(`OSS 删除失败: ${response.status} ${key}`);
    }
  }
}
