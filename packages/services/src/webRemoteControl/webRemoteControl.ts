import type { Event } from "@zcode/rpc";
import { ServiceChannels } from "@zcode/shared";
import { createServiceDescriptor } from "../descriptors.js";

/**
 * 移动端远程控制（自建中继）服务。
 *
 * 对应官方客户端的「移动端远程控制」入口：桌面端在我们自建的中继上注册为 device，
 * 手机打开 `/remote/v4?sid=…&hash=…` 后成为 terminal，即可远程操控本机工作区。
 *
 * 本服务只负责暴露状态给 UI（是否开启、等待/已连接、扫码链接），
 * 中继连接本身由 host 侧 relayDeviceBootstrap 持有。
 */
export type WebRemoteControlStatus =
  /** 未启用（环境变量关闭或身份持久化失败） */
  | "disabled"
  /** 正在连接中继 / 等待拿到 device_sid */
  | "connecting"
  /** 已就绪，等手机端接入 */
  | "waiting"
  /** 手机端已接入 */
  | "connected";

export interface WebRemoteControlState {
  status: WebRemoteControlStatus;
  /** 手机端扫码或点击用的连接链接；不可用时缺省 */
  connectUrl?: string;
  /** 中继分配的 device_sid；不可用时缺省 */
  deviceSid?: string;
}

export interface IWebRemoteControlService {
  /** 读取当前状态（UI 首次渲染 + 手动刷新） */
  getState(): Promise<WebRemoteControlState>;
  /** 状态变更推送（onDynamic* 模式，RPC 自动路由） */
  onDynamicDidChangeState(): Event<WebRemoteControlState>;
}

export const IWebRemoteControlService = createServiceDescriptor<IWebRemoteControlService>(
  ServiceChannels.WebRemoteControl,
);
