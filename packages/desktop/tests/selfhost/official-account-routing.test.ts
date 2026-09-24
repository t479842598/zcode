import assert from "node:assert/strict";
import { test } from "node:test";
import { readFile } from "node:fs/promises";
import { DEFAULT_ZCODE_ENDPOINT_ORIGIN, BIGMODEL_PROVIDER_ID } from "@zcode/shared";
import { createBigModelProviderRuntimeConfig } from "../../../services/src/oauth/providers/bigmodelProviderConfig.js";
import { createZaiProviderRuntimeConfig } from "../../../services/src/oauth/providers/zaiProviderConfig.js";
import { buildZaiStartPlanBalanceUrl } from "../../../services/src/model-provider/zaiStartPlanBilling.js";
import { OAuthCredentialRepo } from "../../../services/src/oauth/repo/oauthCredentialRepo.js";
import { createCredentialCipherProvider } from "../../../services/src/credential/providers/credentialCipherProvider.js";
import { resolveOfficialCodingPlanGatewayUrl } from "../../../../apps/zcode-cli/packages/adapters/src/model/official-coding-plan-gateway.js";

const env = { ZCODE_BASE_URL: "https://relay.example.test", ZCODE_ENDPOINT_ORIGIN: "https://relay.example.test" };

test("OAuth token exchange and callback stay official even with a selfhost origin", () => {
  for (const config of [createBigModelProviderRuntimeConfig(env), createZaiProviderRuntimeConfig(env)]) {
    assert.equal(new URL(config.tokenUrl).origin, DEFAULT_ZCODE_ENDPOINT_ORIGIN);
    assert.equal(new URL(config.redirectUri).origin, DEFAULT_ZCODE_ENDPOINT_ORIGIN);
  }
});

test("official model gateway does not route account credentials to the relay", () => {
  const route = resolveOfficialCodingPlanGatewayUrl("https://api.z.ai/api/anthropic/v1/messages", env);
  assert.equal(new URL(route.url).origin, DEFAULT_ZCODE_ENDPOINT_ORIGIN);
  assert.equal(resolveOfficialCodingPlanGatewayUrl("https://byok.example.test/v1/messages", env).url, "https://byok.example.test/v1/messages");
  assert.equal(new URL(buildZaiStartPlanBalanceUrl()).origin, DEFAULT_ZCODE_ENDPOINT_ORIGIN);
});

test("restored login registers state, starts polling and opens authorization page", async () => {
  const source = await readFile(new URL("../../../ui/src/hooks/useOAuth.ts", import.meta.url), "utf8");
  assert.match(source, /platform\.registerOAuthState\(\{ state, provider: startedProvider \}\)/);
  assert.match(source, /platform\.openExternal\(authorizeUrl\)/);
  assert.doesNotMatch(source, /已禁用 OAuth 浏览器跳转/);
});

test("existing credential keys and enc:v1 format remain compatible without reading real tokens", async () => {
  const cipher = createCredentialCipherProvider({ env: { ZCODE_CREDENTIAL_SECRET: "fixture-only" } });
  const store = new Map<string, string>();
  store.set("oauth:active_provider", cipher.encrypt(BIGMODEL_PROVIDER_ID));
  store.set(`oauth:${BIGMODEL_PROVIDER_ID}:access_token`, cipher.encrypt("fixture-access"));
  store.set("zcodejwttoken", cipher.encrypt("fixture-jwt"));
  const service = {
    async load(key: string) { const value = store.get(key); return value ? cipher.decrypt(value) : null; },
    async save(key: string, value: string) { store.set(key, cipher.encrypt(value)); },
    async delete(key: string) { store.delete(key); },
  };
  const repo = new OAuthCredentialRepo(service);
  assert.equal(await repo.getActiveProvider(), BIGMODEL_PROVIDER_ID);
  assert.deepEqual(await repo.loadTokenSet(BIGMODEL_PROVIDER_ID), { accessToken: "fixture-access", zcodeJwtToken: "fixture-jwt" });
  await repo.saveTokenSet(BIGMODEL_PROVIDER_ID, { accessToken: "fixture-next", zcodeJwtToken: "fixture-next-jwt" });
  assert.equal(store.size, 3);
  assert.ok([...store.values()].every((value) => value.startsWith("enc:v1:")));
});

test("official account routes cannot switch the selfhost update manifest to official releases", async () => {
  const { resolveSelfhostUpdateOrigin } = await import("../../src/main/selfhostUpdateOrigin.js");
  assert.notEqual(resolveSelfhostUpdateOrigin(), DEFAULT_ZCODE_ENDPOINT_ORIGIN);
  assert.notEqual(resolveSelfhostUpdateOrigin({ overrideOrigin: DEFAULT_ZCODE_ENDPOINT_ORIGIN }), DEFAULT_ZCODE_ENDPOINT_ORIGIN);
  assert.equal(resolveSelfhostUpdateOrigin({ env: { ZCODE_SELFHOST_UPDATE_ORIGIN: "https://updates.example.test" } }), "https://updates.example.test");
  const hostEnv = await readFile(new URL("../../src/main/desktopRuntimeEnv.ts", import.meta.url), "utf8");
  assert.match(hostEnv, /ZCODE_BASE_URL: DEFAULT_ZCODE_ENDPOINT_ORIGIN/);
  assert.match(hostEnv, /ZCODE_DISABLE_OFFICIAL_CODING_PLAN_GATEWAY: "0"/);
});

test("OAuth init and polling use official URLs with an isolated fake account service", async () => {
  const { createOAuthService } = await import("../../../services/src/oauth/oauthService.js");
  const requests: string[] = [];
  const apiClient = {
    async request(input: string | URL) {
      const url = String(input);
      requests.push(url);
      if (url.endsWith("/init")) return Response.json({ code: 0, data: {
        flow_id: "fixture-flow",
        authorize_url: "https://bigmodel.cn/login?state=fixture-state",
        expires_at: Math.floor(Date.now() / 1000) + 60,
        poll_interval_sec: 2,
      } });
      return Response.json({ code: 0, data: { status: "pending" } });
    },
  };
  let credentialWrites = 0;
  const oauth = createOAuthService({
    async load() { return null; },
    async save() { credentialWrites++; },
    async delete() { credentialWrites++; },
  }, { apiClient, env });
  try {
    const flow = await oauth.startOAuthWithPolling(BIGMODEL_PROVIDER_ID);
    assert.equal(flow.state, "fixture-state");
    assert.equal(new URL(new URL(flow.authorizeUrl).searchParams.get("redirect")!).origin, DEFAULT_ZCODE_ENDPOINT_ORIGIN);
    await oauth.pollPendingOAuth();
    assert.equal(requests.length, 2);
    assert.ok(requests.every((url) => new URL(url).origin === DEFAULT_ZCODE_ENDPOINT_ORIGIN));
    assert.equal(credentialWrites, 0);
  } finally {
    await oauth.cancelPending(BIGMODEL_PROVIDER_ID);
  }
});
