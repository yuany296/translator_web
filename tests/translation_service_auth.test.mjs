import assert from "node:assert/strict";
import test from "node:test";

import { installTranslationService, LOCAL_SERVICE_AUTH_KEY, LOCAL_SERVICE_ORIGIN_HEADER } from
  "../extension/src/background/modules/translation-service.js";

const EXTENSION_ORIGIN = "chrome-extension://hihgkmkbdndlnbpleclokbijancgmiil";

function createRuntime(initial = {}) {
  const stored = structuredClone(initial);
  const runtime = {
    loadConfiguration: async () => ({
      ocr: { localPaddle: { baseUrl: "http://127.0.0.1:8765" } }
    }),
    sanitizeLocalOcrBaseUrl: value => value,
    storageGet: async keys => Object.fromEntries(keys.map(key => [key, stored[key]])),
    storageSet: async values => Object.assign(stored, structuredClone(values)),
    storageRemove: async keys => keys.forEach(key => delete stored[key]),
    getErrorMessage: error => String(error?.message || error)
  };
  installTranslationService(runtime);
  return { runtime, stored };
}

test("manual pairing sends the terminal code and persists the generated token", async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url: String(url), options });
    return new Response(JSON.stringify({
      ok: true, verified: true, origin: EXTENSION_ORIGIN
    }), {
      status: 200, headers: { "content-type": "application/json" }
    });
  };
  try {
    const { runtime, stored } = createRuntime();
    assert.throws(() => runtime.pairLocalService(""), /请输入本地服务终端显示的配对码/);
    assert.deepEqual(await runtime.pairLocalService("012345"), { ok: true, verified: true });
    const body = JSON.parse(requests[0].options.body);
    assert.equal(body.pairingCode, "012345");
    assert.match(body.token, /^[0-9a-f]{64}$/);
    assert.equal(stored[LOCAL_SERVICE_AUTH_KEY].token, body.token);
    assert.equal(stored[LOCAL_SERVICE_AUTH_KEY].origin, EXTENSION_ORIGIN);
    assert.equal(requests.length, 1);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("pairing is rejected when the server does not confirm the saved token", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response(JSON.stringify({ ok: true }), { status: 200 });
  try {
    const { runtime, stored } = createRuntime();
    await assert.rejects(runtime.pairLocalService("012345"), /HTTP 200/);
    assert.equal(stored[LOCAL_SERVICE_AUTH_KEY], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a later 401 clears the stale token and returns a Chinese recovery message", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Response(JSON.stringify({ ok: true, verified: true }), { status: 200 });
    }
    return new Response(JSON.stringify({ detail: "local service authentication required" }), {
      status: 401
    });
  };
  try {
    const { runtime, stored } = createRuntime();
    await runtime.pairLocalService("012345");
    const status = await runtime.getTranslationServiceStatus();
    assert.equal(status.ok, false);
    assert.match(status.error, /认证已失效/);
    assert.equal(stored[LOCAL_SERVICE_AUTH_KEY], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a late 401 from an old request cannot clear a newly paired token", async () => {
  const originalFetch = globalThis.fetch;
  let resolveStaleRequest;
  globalThis.fetch = async (_url, options) => {
    if (options.method === "POST") {
      return new Response(JSON.stringify({ ok: true, verified: true }), { status: 200 });
    }
    return new Promise(resolve => { resolveStaleRequest = resolve; });
  };
  try {
    const { runtime, stored } = createRuntime();
    await runtime.pairLocalService("first-code");
    const firstToken = stored[LOCAL_SERVICE_AUTH_KEY].token;
    const staleStatus = runtime.getTranslationServiceStatus();
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(typeof resolveStaleRequest, "function");

    await runtime.pairLocalService("second-code");
    const secondToken = stored[LOCAL_SERVICE_AUTH_KEY].token;
    assert.notEqual(secondToken, firstToken);
    resolveStaleRequest(new Response("unauthorized", { status: 401 }));

    assert.equal((await staleStatus).ok, false);
    assert.equal(stored[LOCAL_SERVICE_AUTH_KEY].token, secondToken);
    assert.equal(await runtime.ensureLocalServiceToken(), secondToken);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("missing or invalid stored credentials never trigger silent auto-pairing", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response("unauthorized", { status: 401 });
  };
  try {
    const { runtime } = createRuntime();
    await assert.rejects(runtime.ensureLocalServiceToken(), /尚未配对/);
    assert.equal(fetchCount, 0);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an invalid persisted token is cleared after a background restart", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return new Response("unauthorized", { status: 401 });
  };
  try {
    const token = "c".repeat(64);
    const { runtime, stored } = createRuntime({ [LOCAL_SERVICE_AUTH_KEY]: { token } });
    await assert.rejects(runtime.ensureLocalServiceToken(), /认证已失效/);
    assert.equal(fetchCount, 1);
    assert.equal(stored[LOCAL_SERVICE_AUTH_KEY], undefined);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an offline service keeps the persisted token for the next restart", async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError("fetch failed"); };
  try {
    const token = "d".repeat(64);
    const credentials = { token, origin: EXTENSION_ORIGIN };
    const { runtime, stored } = createRuntime({ [LOCAL_SERVICE_AUTH_KEY]: credentials });
    await assert.rejects(runtime.ensureLocalServiceToken(), /无法访问本地服务/);
    assert.deepEqual(stored[LOCAL_SERVICE_AUTH_KEY], credentials);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("an offline request after pairing returns the friendly cache-only message", async () => {
  const originalFetch = globalThis.fetch;
  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    if (fetchCount === 1) {
      return new Response(JSON.stringify({
        ok: true, verified: true, origin: EXTENSION_ORIGIN
      }), { status: 200 });
    }
    throw new TypeError("fetch failed");
  };
  try {
    const { runtime, stored } = createRuntime();
    await runtime.pairLocalService("pair-code");
    const status = await runtime.getTranslationServiceStatus();
    assert.equal(status.ok, false);
    assert.match(status.error, /无法访问本地服务.*允许 Chrome 访问本机设备/);
    assert.ok(stored[LOCAL_SERVICE_AUTH_KEY]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("a persisted token is reused after service restart", async () => {
  const originalFetch = globalThis.fetch;
  const token = "a".repeat(64);
  let authorization = "";
  let extensionOrigin = "";
  globalThis.fetch = async (_url, options) => {
    authorization = options.headers.Authorization;
    extensionOrigin = options.headers[LOCAL_SERVICE_ORIGIN_HEADER];
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const { runtime } = createRuntime({
      [LOCAL_SERVICE_AUTH_KEY]: { token, origin: EXTENSION_ORIGIN }
    });
    assert.equal(await runtime.ensureLocalServiceToken(), token);
    assert.equal(authorization, `Bearer ${token}`);
    assert.equal(extensionOrigin, EXTENSION_ORIGIN);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("cold background validation does not consume the whole health-check timeout", async () => {
  const originalFetch = globalThis.fetch;
  const token = "b".repeat(64);
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
    const { runtime } = createRuntime({
      [LOCAL_SERVICE_AUTH_KEY]: { token, origin: EXTENSION_ORIGIN }
    });
    const status = await runtime.getTranslationServiceStatus();
    assert.equal(status.ok, true);
    assert.equal(fetchCount, 2);
  } finally {
    globalThis.fetch = originalFetch;
  }
});
