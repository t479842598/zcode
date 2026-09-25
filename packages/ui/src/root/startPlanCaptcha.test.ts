import { strict as assert } from "node:assert";
import { test } from "node:test";
import { verifyStartPlanCaptcha } from "./startPlanCaptcha.js";

function fakeDom(
  init: (input: {
    success(value: string): void;
    fail(reason: unknown): void;
    getInstance(instance: { startTracelessVerification?: () => void }): void;
  }) => void,
) {
  const nodes: Array<{ remove(): void; onclick?: (() => void) | null }> = [];
  const make = () => {
    const element = {
      id: "",
      className: "",
      type: "",
      textContent: "",
      async: false,
      src: "",
      onclick: null as (() => void) | null,
      append() {},
      remove() {
        nodes.splice(nodes.indexOf(element), 1);
      },
    };
    nodes.push(element);
    return element;
  };
  const document = { createElement: make, body: { appendChild() {} }, head: { appendChild() {} } };
  const window = { initAliyunCaptcha: init, AliyunCaptchaConfig: undefined };
  return { document, window, nodes };
}

const config = { enabled: true as const, region: "cn", prefix: "p", sceneId: "s" };

test("正常验证为当前请求生成一次回执并清理UI", async () => {
  const saved = { window: globalThis.window, document: globalThis.document };
  const dom = fakeDom(({ success, getInstance }) => {
    getInstance({ startTracelessVerification: () => success(" current-proof ") });
  });
  Object.assign(globalThis, { window: dom.window, document: dom.document });
  try {
    assert.equal(
      await verifyStartPlanCaptcha(config, new AbortController().signal, "zh-CN"),
      "current-proof",
    );
    assert.equal(dom.nodes.length, 3); // 清理容器，模拟子元素由 DOM 自动摘除
    assert.equal(dom.window.AliyunCaptchaConfig, undefined);
  } finally {
    Object.assign(globalThis, saved);
  }
});

test("验证取消不能生成回执", async () => {
  const saved = { window: globalThis.window, document: globalThis.document };
  const dom = fakeDom(() => {});
  Object.assign(globalThis, { window: dom.window, document: dom.document });
  const controller = new AbortController();
  try {
    const promise = verifyStartPlanCaptcha(config, controller.signal, "en-US");
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    await assert.rejects(promise, /cancelled/);
  } finally {
    Object.assign(globalThis, saved);
  }
});

test("同一时刻只能有一轮SDK验证，旧成功不能响应新请求", async () => {
  const saved = { window: globalThis.window, document: globalThis.document };
  const successCallbacks: Array<(value: string) => void> = [];
  const dom = fakeDom(({ success }) => {
    successCallbacks.push(success);
  });
  Object.assign(globalThis, { window: dom.window, document: dom.document });
  try {
    const firstController = new AbortController();
    const first = verifyStartPlanCaptcha(config, firstController.signal, "zh-CN");
    await new Promise((resolve) => setImmediate(resolve));
    const secondController = new AbortController();
    const second = verifyStartPlanCaptcha(config, secondController.signal, "zh-CN");
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(successCallbacks.length, 1);
    firstController.abort();
    await assert.rejects(first, /cancelled/);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(successCallbacks.length, 2);
    successCallbacks[0]!("stale-proof");
    successCallbacks[1]!("new-proof");
    assert.equal(await second, "new-proof");
  } finally {
    Object.assign(globalThis, saved);
  }
});
