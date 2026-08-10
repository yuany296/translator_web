import assert from "node:assert/strict";
import test from "node:test";

import { installTranslationService } from "../extension/src/background/modules/translation-service.js";

function createRuntime() {
  const runtime = {
    loadConfiguration: async () => ({
      ocr: { localPaddle: { baseUrl: "http://127.0.0.1:8765" } }
    }),
    sanitizeLocalOcrBaseUrl: value => value,
    getErrorMessage: error => String(error?.message || error)
  };
  installTranslationService(runtime);
  return runtime;
}

test("local service requests carry no authentication headers", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  };
  try {
    const runtime = createRuntime();
    const status = await runtime.getTranslationServiceStatus();
    assert.equal(status.ok, true);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].options.headers?.Authorization, undefined);
    assert.equal(requests[0].options.headers?.["X-Manga-Translator-Origin"], undefined);
    assert.equal(runtime.pairLocalService, undefined);
    assert.equal(runtime.ensureLocalServiceToken, undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an offline service request returns the friendly cache-only message", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  try {
    const runtime = createRuntime();
    const status = await runtime.getTranslationServiceStatus();
    assert.equal(status.ok, false);
    assert.match(status.error, /无法访问本地服务.*允许 Chrome 访问本机设备/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an aborted request maps to the offline message without surfacing AbortError", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new DOMException("aborted", "AbortError"); };
  try {
    const runtime = createRuntime();
    const status = await runtime.getTranslationServiceStatus();
    assert.equal(status.ok, false);
    assert.match(status.error, /无法访问本地服务/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a non-ok response surfaces the server detail without any token state", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ detail: "conflict" }), { status: 409 });
  try {
    const runtime = createRuntime();
    await assert.rejects(runtime.queryTranslationService(["r1"]), /conflict/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("health check on a cold background consumes a single request", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = (_url, options = {}) => new Promise((resolve, reject) => {
    fetchCount += 1;
    const timer = setTimeout(() => resolve(new Response(JSON.stringify({ ok: true }), {
      status: 200, headers: { "content-type": "application/json" }
    })), 600);
    options.signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(new DOMException("aborted", "AbortError"));
    }, { once: true });
  });
  try {
    const runtime = createRuntime();
    const status = await runtime.getTranslationServiceStatus();
    assert.equal(status.ok, true);
    assert.equal(fetchCount, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
