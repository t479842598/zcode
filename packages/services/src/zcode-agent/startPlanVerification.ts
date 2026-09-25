import type { ZCodeProviderRuntimeHeadersRequestParams } from "@zcode/shared";
import type { CaptchaConfig } from "../coding-plan-subscription/captchaConfig.js";

export const START_PLAN_VERIFY_PARAM_HEADER = "X-Aliyun-Captcha-Verify-Param";
export const START_PLAN_VERIFY_REGION_HEADER = "X-Aliyun-Captcha-Verify-Region";

export function isStartPlanRequest(request: ZCodeProviderRuntimeHeadersRequestParams): boolean {
  return request.accountAccess?.mode === "start-plan";
}

export function isCurrentVerificationRequest(
  expected: Pick<ZCodeProviderRuntimeHeadersRequestParams, "requestId" | "sessionId" | "workspace">,
  received: Pick<ZCodeProviderRuntimeHeadersRequestParams, "requestId" | "sessionId" | "workspace">,
): boolean {
  return (
    expected.requestId === received.requestId &&
    expected.sessionId === received.sessionId &&
    expected.workspace.workspaceKey === received.workspace.workspaceKey &&
    expected.workspace.workspaceIdentity === received.workspace.workspaceIdentity &&
    expected.workspace.workspacePath === received.workspace.workspacePath &&
    expected.workspace.remoteSessionId === received.workspace.remoteSessionId
  );
}

/** 验证参数只可由此请求的交互回执产生，不能由 Renderer 覆盖账号JWT。 */
export function startPlanVerificationHeaders(
  config: CaptchaConfig | null,
  verification: { captchaVerifyParam: string; captchaRegion?: string },
): Record<string, string> {
  if (!config) throw new Error("Start Plan verification is unavailable");
  // 官方配置明确关闭时无需额外验证；缺失配置绝不能当作关闭。
  if (!config.enabled) return {};
  const param = verification.captchaVerifyParam.trim();
  if (!param || param.length > 8192) throw new Error("Start Plan verification failed");
  if (verification.captchaRegion && verification.captchaRegion !== config.region) {
    throw new Error("Start Plan verification region mismatch");
  }
  return {
    [START_PLAN_VERIFY_PARAM_HEADER]: param,
    [START_PLAN_VERIFY_REGION_HEADER]: config.region,
  };
}
