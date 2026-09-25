import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseCaptchaConfig } from "../src/coding-plan-subscription/captchaConfig.js";

test("正常验证配置只接受完整字段", () => {
  assert.equal(parseCaptchaConfig(null), null);
  assert.equal(parseCaptchaConfig({ enabled: true, sceneId: "s", prefix: "p" }), null);
  assert.deepEqual(parseCaptchaConfig({ enabled: false }), { enabled: false });
  assert.equal(
    parseCaptchaConfig({ enabled: true, sceneId: "s", prefix: "p", region: "r" })?.sceneId,
    "s",
  );
});

test("服务读取官方client/configs内的验证码参数，不读取账号凭据", async () => {
  const { BigModelCodingPlanSubscriptionProvider } =
    await import("../src/coding-plan-subscription/bigmodelCodingPlanSubscriptionProvider.js");
  let calls = 0;
  let credentials = 0;
  const provider = new BigModelCodingPlanSubscriptionProvider({
    apiClient: {
      async request(input: string | URL) {
        calls++;
        assert.match(String(input), /\/api\/v1\/client\/configs/);
        return Response.json({
          code: 0,
          data: {
            configs: {
              captcha: { enabled: true, sceneId: "scene", prefix: "prefix", region: "cn" },
            },
          },
        });
      },
    },
    credentialService: {
      async load() {
        credentials++;
        return null;
      },
    },
  } as never);
  assert.equal((await provider.getCaptchaConfig())?.enabled, true);
  assert.equal((await provider.getCaptchaConfig())?.region, "cn");
  assert.equal(calls, 2, "verification config cannot use the one-hour product cache");
  assert.equal(credentials, 0);
});
