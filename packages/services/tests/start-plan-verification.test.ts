import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  isStartPlanRequest,
  startPlanVerificationHeaders,
} from "../src/zcode-agent/startPlanVerification.js";

const config = { enabled: true, region: "cn", prefix: "p", sceneId: "s" };

test("仅 Start Plan 使用交互验证", () => {
  assert.equal(
    isStartPlanRequest({
      accountAccess: {
        type: "zhipu-account",
        accountType: "zai",
        mode: "start-plan",
        entitled: true,
      },
    } as never),
    true,
  );
  assert.equal(
    isStartPlanRequest({
      accountAccess: {
        type: "zhipu-account",
        accountType: "zai",
        mode: "individual-coding-plan",
        entitled: true,
      },
    } as never),
    false,
  );
});

test("验证回执只生成两项白名单头，失败时拒绝", () => {
  assert.deepEqual(
    startPlanVerificationHeaders(config, { captchaVerifyParam: "proof", captchaRegion: "cn" }),
    {
      "X-Aliyun-Captcha-Verify-Param": "proof",
      "X-Aliyun-Captcha-Verify-Region": "cn",
    },
  );
  assert.throws(
    () => startPlanVerificationHeaders(null, { captchaVerifyParam: "proof" }),
    /unavailable/,
  );
  assert.deepEqual(
    startPlanVerificationHeaders({ enabled: false }, { captchaVerifyParam: "" }),
    {},
  );
  assert.throws(() => startPlanVerificationHeaders(config, { captchaVerifyParam: " " }), /failed/);
  assert.throws(
    () =>
      startPlanVerificationHeaders(config, { captchaVerifyParam: "proof", captchaRegion: "else" }),
    /region/,
  );
});

test("回执必须属于同一个workspace identity/session/request", async () => {
  const { isCurrentVerificationRequest } =
    await import("../src/zcode-agent/startPlanVerification.js");
  const original = {
    requestId: "r1",
    sessionId: "s1",
    workspace: { workspaceKey: "id", workspacePath: "/path", workspaceIdentity: "id" },
  };
  assert.equal(isCurrentVerificationRequest(original, original), true);
  assert.equal(isCurrentVerificationRequest(original, { ...original, requestId: "r2" }), false);
  assert.equal(isCurrentVerificationRequest(original, { ...original, sessionId: "s2" }), false);
  assert.equal(
    isCurrentVerificationRequest(original, {
      ...original,
      workspace: { ...original.workspace, workspaceIdentity: "other" },
    }),
    false,
  );
});

test("手机replayable连接不能监听或响应桌面安全验证", async () => {
  const { createZCodeAgentConnectionScope } =
    await import("../src/zcode-agent/zcodeAgentConnectionScope.js");
  const scope = createZCodeAgentConnectionScope({} as never, {
    connectionId: "relay-test",
    clientMode: "web-remote-replayable",
    role: "terminal-client",
  });
  try {
    let seen = false;
    const subscription = scope.service.onDynamicStartPlanVerificationRequest()(() => {
      seen = true;
    });
    assert.equal(seen, false);
    subscription.dispose();
    await assert.rejects(scope.service.respondStartPlanVerification({} as never), /desktopOnly/);
  } finally {
    await scope.dispose();
  }
});

test("同一identity但不同remoteSessionId或path不能接收回执", async () => {
  const { isCurrentVerificationRequest } =
    await import("../src/zcode-agent/startPlanVerification.js");
  const request = {
    requestId: "r",
    sessionId: "s",
    workspace: {
      workspacePath: "/repo",
      workspaceKey: "identity",
      workspaceIdentity: "identity",
      remoteSessionId: "one",
    },
  };
  assert.equal(
    isCurrentVerificationRequest(request, {
      ...request,
      workspace: { ...request.workspace, remoteSessionId: "two" },
    }),
    false,
  );
  assert.equal(
    isCurrentVerificationRequest(request, {
      ...request,
      workspace: { ...request.workspace, workspacePath: "/other" },
    }),
    false,
  );
});

test("桌面continuous可接收事件和提交当前回执", async () => {
  const { createZCodeAgentConnectionScope } =
    await import("../src/zcode-agent/zcodeAgentConnectionScope.js");
  let calls = 0;
  const base = {
    onDynamicStartPlanVerificationRequest: () => (listener: (value: number) => void) => {
      listener(1);
      return { dispose() {} };
    },
    onDynamicStartPlanVerificationCancelled: () => () => ({ dispose() {} }),
    async respondStartPlanVerification() {
      calls++;
    },
  };
  const scope = createZCodeAgentConnectionScope(base as never, {
    connectionId: "desktop-test",
    clientMode: "desktop-continuous",
    role: "terminal-client",
  });
  try {
    let delivered = 0;
    scope.service
      .onDynamicStartPlanVerificationRequest()(() => {
        delivered++;
      })
      .dispose();
    await scope.service.respondStartPlanVerification({} as never);
    assert.equal(delivered, 1);
    assert.equal(calls, 1);
  } finally {
    await scope.dispose();
  }
});

test("共享协议接受正常验证重试原因，但不会接受任意字符串", async () => {
  const { zcodeProviderRuntimeHeadersRequestParamsSchema } = await import("@zcode/shared");
  const request = {
    requestId: "r",
    sessionId: "s",
    workspace: { workspacePath: "/repo", workspaceKey: "/repo" },
    modelSelection: { providerId: "p", modelId: "m" },
    providerId: "p",
    reason: "captcha-retry",
  };
  assert.equal(zcodeProviderRuntimeHeadersRequestParamsSchema.safeParse(request).success, true);
  assert.equal(
    zcodeProviderRuntimeHeadersRequestParamsSchema.safeParse({ ...request, reason: "arbitrary" })
      .success,
    false,
  );
});
