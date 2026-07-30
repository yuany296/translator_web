import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "dist", "test", "background.iife.js"), "utf8");
const listeners = {
  addListener() {}
};
const context = vm.createContext({
  chrome: {
    runtime: {
      onInstalled: listeners,
      onStartup: listeners,
      onMessage: listeners
    },
    tabs: {},
    storage: {
      local: {}
    }
  },
  console,
  fetch,
  URL,
  Blob,
  AbortController,
  atob,
  crypto: webcrypto,
  setTimeout,
  clearTimeout
});
vm.runInContext(`${source}\nglobalThis.__backgroundTest = MtBackgroundModule.backgroundRuntime;`, context, {
  filename: "background.iife.js"
});
function installMemoryStorage(initial = {}) {
  const stored = JSON.parse(JSON.stringify(initial));
  context.chrome.runtime.lastError = null;
  context.chrome.storage.local.get = (keys, callback) => {
    if (keys === null) {
      callback({
        ...stored
      });
      return;
    }
    const list = Array.isArray(keys) ? keys : [keys];
    callback(Object.fromEntries(list.map(key => [key, stored[key]])));
  };
  context.chrome.storage.local.set = (value, callback) => {
    Object.assign(stored, JSON.parse(JSON.stringify(value)));
    callback();
  };
  context.chrome.storage.local.remove = (keys, callback) => {
    (Array.isArray(keys) ? keys : [keys]).forEach(key => delete stored[key]);
    callback();
  };
  return stored;
}
function separatedConfiguration({
  ocrProvider = "local_paddle",
  baiduApiKey = "",
  baiduSecretKey = "",
  localOcrBaseUrl = "http://127.0.0.1:8765",
  translationApiKey = "",
  translationBaseUrl = "https://api.deepseek.com",
  translationModel = "deepseek-chat"
} = {}) {
  return {
    mt_ocr_config_v1: {
      provider: ocrProvider,
      baidu: {
        apiKey: baiduApiKey,
        secretKey: baiduSecretKey
      },
      localPaddle: {
        baseUrl: localOcrBaseUrl
      }
    },
    mt_translation_config_v1: {
      provider: "openai_compatible",
      apiKey: translationApiKey,
      baseUrl: translationBaseUrl,
      model: translationModel
    }
  };
}
test("warm OCR cache refreshes only required cleaned artifacts and preserves cached observations", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage(separatedConfiguration());
  const callsByPage = new Map();
  background.setBackgroundTestHooks({
    requestProviderNeutralOcr: async ({
      request
    }) => {
      const pageId = request.pageIds[0];
      const call = (callsByPage.get(pageId) || 0) + 1;
      callsByPage.set(pageId, call);
      const needsCleaned = pageId === "page-none";
      return {
        provider: "local_paddle",
        sourceType: "page",
        pageIds: [pageId],
        imageRevisionByPage: request.imageRevisionByPage,
        observations: [{
          id: call === 1 ? `${pageId}-stable` : `${pageId}-changed-by-refresh`,
          visual: {
            bgType: needsCleaned ? "none" : "solid"
          }
        }],
        filteredObservations: [],
        edgeSignals: {},
        cleanedImage: `data:image/png;base64,${call === 1 ? "QUJDRA==" : "RUZHSA=="}`,
        cleanedImageToken: `artifact-${pageId}-${call}`
      };
    }
  });
  const solidRequest = {
    dataUrl: "data:image/png;base64,U09MSUQ=",
    sourceType: "page",
    pageIds: ["page-solid"],
    imageRevision: "ignored",
    requireCleanedImage: true
  };
  await background.handleOcrDataUrl(solidRequest);
  const solidWarm = await background.handleOcrDataUrl(solidRequest);
  assert.equal(solidWarm.cached, true);
  assert.equal(callsByPage.get("page-solid"), 1);
  const forcedSolidArtifact = await background.handleOcrDataUrl({
    ...solidRequest,
    forceCleanedImageArtifact: true
  });
  assert.equal(callsByPage.get("page-solid"), 2);
  assert.equal(forcedSolidArtifact.result.observations[0].id, "page-solid-stable");
  assert.match(forcedSolidArtifact.result.cleanedImage, /^data:image\/png;base64,/);
  assert.equal(forcedSolidArtifact.result.cleanedImageToken, "artifact-page-solid-2");
  const noneRequest = {
    dataUrl: "data:image/png;base64,Tk9ORQ==",
    sourceType: "page",
    pageIds: ["page-none"],
    imageRevision: "ignored",
    requireCleanedImage: true
  };
  const noneCold = await background.handleOcrDataUrl(noneRequest);
  const noneWarm = await background.handleOcrDataUrl(noneRequest);
  background.setBackgroundTestHooks(null);
  assert.equal(noneCold.result.observations[0].id, "page-none-stable");
  assert.equal(callsByPage.get("page-none"), 2);
  assert.equal(noneWarm.cached, false);
  assert.equal(noneWarm.result.observations[0].id, "page-none-stable");
  assert.match(noneWarm.result.cleanedImage, /^data:image\/png;base64,/);
});
test("canonical text translation reports omitted IDs as partial errors without original-text fallback", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage(separatedConfiguration({
    translationApiKey: "translation-key",
    translationModel: "model-a",
    translationBaseUrl: "https://api.example.test"
  }));
  background.setBackgroundTestHooks({
    requestCanonicalTranslationBatch: async ({
      items
    }) => [{
      id: items[0].id,
      translated_text: "第一句"
    }]
  });
  const response = await background.handleTranslateTextBlocks({
    sourceLanguage: "ko",
    targetLanguage: "zh-CN",
    items: [{
      id: "canonical-a",
      revision: 2,
      original_text: "첫 문장"
    }, {
      id: "canonical-b",
      revision: 7,
      original_text: "둘째 문장"
    }]
  });
  background.setBackgroundTestHooks(null);
  assert.equal(response.ok, true);
  assert.equal(response.partial, true);
  assert.equal(response.translations.length, 1);
  assert.equal(response.translations[0].id, "canonical-a");
  assert.equal(response.translations[0].revision, 2);
  assert.equal(response.errors[0].id, "canonical-b");
  assert.equal(response.errors[0].revision, 7);
  assert.equal(response.translations.some(item => item.translated_text === "둘째 문장"), false);
});
test("canonical text translation rejects array-position identities", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage(separatedConfiguration({
    translationApiKey: "translation-key"
  }));
  const response = await background.handleTranslateTextBlocks({
    sourceLanguage: "ko",
    targetLanguage: "zh-CN",
    items: [{
      revision: 1,
      original_text: "안녕"
    }]
  });
  assert.equal(response.ok, false);
  assert.match(response.error, /stable canonical id/i);
});
test("canonical text translation keeps same-ID revisions distinct within one request", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage(separatedConfiguration({
    translationApiKey: "translation-key",
    translationModel: "model-revisions",
    translationBaseUrl: "https://api.example.test"
  }));
  background.setBackgroundTestHooks({
    requestCanonicalTranslationBatch: async ({
      items
    }) => items.map((item, index) => ({
      id: item.id,
      translated_text: index === 0 ? "第一版" : "第二版"
    }))
  });
  const response = await background.handleTranslateTextBlocks({
    sourceLanguage: "ko",
    targetLanguage: "zh-CN",
    items: [{
      id: "canonical-same",
      revision: 1,
      original_text: "첫 버전"
    }, {
      id: "canonical-same",
      revision: 2,
      original_text: "둘째 버전"
    }]
  });
  background.setBackgroundTestHooks(null);
  assert.equal(response.ok, true);
  assert.equal(response.partial, false);
  assert.equal(response.translations[0].revision, 1);
  assert.equal(response.translations[0].translated_text, "第一版");
  assert.equal(response.translations[1].revision, 2);
  assert.equal(response.translations[1].translated_text, "第二版");
});
test("concurrent canonical fingerprints share one external request and warm cache performs zero calls", async () => {
  const background = context.__backgroundTest;
  const stored = installMemoryStorage(separatedConfiguration({
    translationApiKey: "translation-key",
    translationModel: "model-a",
    translationBaseUrl: "https://api.example.test"
  }));
  let externalCalls = 0;
  background.setBackgroundTestHooks({
    requestCanonicalTranslationBatch: async ({
      items
    }) => {
      externalCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return items.map(item => ({
        id: item.id,
        translated_text: "共享译文"
      }));
    }
  });
  const makeRequest = (id, revision) => background.handleTranslateTextBlocks({
    sourceLanguage: "ko",
    targetLanguage: "zh-CN",
    items: [{
      id,
      revision,
      original_text: "같은 문장!"
    }]
  });
  const [first, second] = await Promise.all([makeRequest("canonical-a", 1), makeRequest("canonical-b", 4)]);
  const warm = await makeRequest("canonical-c", 9);
  background.setBackgroundTestHooks(null);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(first.translations[0].revision, 1);
  assert.equal(second.translations[0].revision, 4);
  assert.equal(first.translations[0].translationFingerprint, second.translations[0].translationFingerprint);
  assert.equal(warm.translations[0].cached, true);
  assert.equal(externalCalls, 1);
  assert.ok(Object.keys(stored).some(key => key.startsWith("mt_cache_v22:translation:")));
});
test("OpenAI-compatible text translation aborts a stalled fetch within its request deadline", async () => {
  const originalFetch = context.fetch;
  context.fetch = () => new Promise(() => {});
  try {
    const outcome = await Promise.race([context.__backgroundTest.sendOpenAICompatibleTranslationRequest("https://api.example.test/chat/completions", "translation-key", {
      model: "model-a",
      messages: []
    }, 20).then(() => "resolved", error => `rejected:${error && error.message}`), new Promise(resolve => setTimeout(() => resolve("still-pending"), 120))]);
    assert.match(outcome, /^rejected:.*timed out/i);
  } finally {
    context.fetch = originalFetch;
  }
});
test("OpenAI-compatible text translation timeout includes stalled JSON body reads", async () => {
  const originalFetch = context.fetch;
  let requestSignal = null;
  context.fetch = async (_url, init) => {
    requestSignal = init.signal;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("body read aborted");
          error.name = "AbortError";
          reject(error);
        }, {
          once: true
        });
      })
    };
  };
  try {
    const outcome = await Promise.race([context.__backgroundTest.sendOpenAICompatibleTranslationRequest("https://api.example.test/chat/completions", "translation-key", {
      model: "model-a",
      messages: []
    }, 20).then(() => "resolved", error => `rejected:${error && error.message}`), new Promise(resolve => setTimeout(() => resolve("still-pending"), 120))]);
    assert.match(outcome, /^rejected:.*timed out/i);
    assert.equal(requestSignal && requestSignal.aborted, true);
  } finally {
    context.fetch = originalFetch;
  }
});
test("low-confidence Vision OCR aborts a stalled fetch within its request deadline", async () => {
  const originalFetch = context.fetch;
  context.fetch = () => new Promise(() => {});
  try {
    const outcome = await Promise.race([context.__backgroundTest.sendOpenAICompatibleOnce({
      endpoint: "https://vision.example.test/chat/completions",
      model: "vision-model",
      apiKey: "vision-key",
      dataUrl: "data:image/png;base64,AQID",
      prompt: "read text",
      useJsonResponseFormat: true,
      requestTimeoutMs: 20
    }).then(() => "resolved", error => `rejected:${error && error.message}`), new Promise(resolve => setTimeout(() => resolve("still-pending"), 120))]);
    assert.match(outcome, /^rejected:.*timed out/i);
  } finally {
    context.fetch = originalFetch;
  }
});
test("low-confidence Vision OCR timeout includes stalled JSON body reads", async () => {
  const originalFetch = context.fetch;
  let requestSignal = null;
  context.fetch = async (_url, init) => {
    requestSignal = init.signal;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("body read aborted");
          error.name = "AbortError";
          reject(error);
        }, {
          once: true
        });
      })
    };
  };
  try {
    const outcome = await Promise.race([context.__backgroundTest.sendOpenAICompatibleOnce({
      endpoint: "https://vision.example.test/chat/completions",
      model: "vision-model",
      apiKey: "vision-key",
      dataUrl: "data:image/png;base64,AQID",
      prompt: "read text",
      useJsonResponseFormat: true,
      requestTimeoutMs: 20
    }).then(() => "resolved", error => `rejected:${error && error.message}`), new Promise(resolve => setTimeout(() => resolve("still-pending"), 120))]);
    assert.match(outcome, /^rejected:.*timed out/i);
    assert.equal(requestSignal && requestSignal.aborted, true);
  } finally {
    context.fetch = originalFetch;
  }
});
test("local OCR forwards the cleaned-image artifact flag to the service", async () => {
  const originalFetch = context.fetch;
  const requestBodies = [];
  context.fetch = async (_url, init) => {
    const body = JSON.parse(init.body);
    requestBodies.push(body);
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: async () => ({
        items: [],
        imageWidth: 1,
        imageHeight: 1,
        ocrGeometryVersion: body.ocr_geometry_version,
        ...(body.cleaned_mask_token ? {
          cleanedMaskToken: body.cleaned_mask_token
        } : {})
      })
    };
  };
  const baseRequest = {
    dataUrl: "data:image/png;base64,AQID",
    baseUrl: "http://127.0.0.1:8765",
    lang: "korean",
    mode: "fast",
    params: {},
    debug: false,
    debugId: "artifact-wire-test"
  };
  try {
    await context.__backgroundTest.requestLocalPaddleOcr(baseRequest);
    await context.__backgroundTest.requestLocalPaddleOcr({
      ...baseRequest,
      returnCleanedImage: true
    });
    await context.__backgroundTest.requestLocalPaddleOcr({
      ...baseRequest,
      returnCleanedImage: true,
      cleanedMasks: [{
        coordinateSpace: "percent",
        box: {
          x: 20,
          y: 90,
          w: 50,
          h: 10
        }
      }]
    });
  } finally {
    context.fetch = originalFetch;
  }
  assert.equal(requestBodies.length, 3);
  assert.equal(requestBodies[0].ocr_geometry_version, "detect-crop-recognize-appearance-layout-v2");
  assert.equal(requestBodies[0].return_cleaned_image, false);
  assert.equal(requestBodies[0].cleaned_mask_token, "");
  assert.equal(requestBodies[1].return_cleaned_image, true);
  assert.deepEqual(requestBodies[1].cleaned_masks, []);
  assert.match(requestBodies[1].cleaned_mask_token, /^[a-f0-9]{32}$/);
  assert.equal(requestBodies[2].return_cleaned_image, true);
  assert.deepEqual(requestBodies[2].cleaned_masks, [{
    coordinateSpace: "percent",
    box: {
      x: 20,
      y: 90,
      w: 50,
      h: 10
    }
  }]);
  assert.match(requestBodies[2].cleaned_mask_token, /^[a-f0-9]{32}$/);
  assert.notEqual(requestBodies[1].cleaned_mask_token, requestBodies[2].cleaned_mask_token);
});
test("local OCR rejects an outdated geometry service before accepting plain OCR", async () => {
  const originalFetch = context.fetch;
  context.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      items: [],
      imageWidth: 1,
      imageHeight: 1
    })
  });
  try {
    await assert.rejects(context.__backgroundTest.requestLocalPaddleOcr({
      dataUrl: "data:image/png;base64,AQID",
      baseUrl: "http://127.0.0.1:8765",
      lang: "korean",
      mode: "fast",
      params: {},
      debug: false,
      debugId: "outdated-geometry-service-test"
    }), /OCR.*版本.*重启.*local-ocr-service/);
  } finally {
    context.fetch = originalFetch;
  }
});
test("local OCR rejects a cleaned artifact when an old service does not acknowledge artifact support", async () => {
  const originalFetch = context.fetch;
  context.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({
      items: [],
      imageWidth: 1,
      imageHeight: 1,
      cleanedImage: "data:image/png;base64,AQID"
    })
  });
  try {
    await assert.rejects(context.__backgroundTest.requestLocalPaddleOcr({
      dataUrl: "data:image/png;base64,AQID",
      baseUrl: "http://127.0.0.1:8765",
      lang: "korean",
      mode: "fast",
      params: {},
      debug: false,
      debugId: "old-service-artifact-test",
      returnCleanedImage: true
    }), /local-ocr-service/);
  } finally {
    context.fetch = originalFetch;
  }
});
test("local OCR body timeout rejects instead of returning an empty authoritative payload", async () => {
  const originalFetch = context.fetch;
  let requestSignal = null;
  context.fetch = async (_url, init) => {
    requestSignal = init.signal;
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      json: () => new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          const error = new Error("body read aborted");
          error.name = "AbortError";
          reject(error);
        }, {
          once: true
        });
      })
    };
  };
  try {
    const outcome = await Promise.race([context.__backgroundTest.requestLocalPaddleOcr({
      dataUrl: "data:image/png;base64,AQID",
      baseUrl: "http://127.0.0.1:8765",
      lang: "korean",
      mode: "fast",
      params: {},
      debug: true,
      debugId: "stalled-local-body",
      requestTimeoutMs: 20
    }).then(value => `resolved:${JSON.stringify(value)}`, error => `rejected:${error && error.message}`), new Promise(resolve => setTimeout(() => resolve("still-pending"), 120))]);
    assert.match(outcome, /^rejected:.*OCR.*超时/i);
    assert.equal(requestSignal && requestSignal.aborted, true);
  } finally {
    context.fetch = originalFetch;
  }
});
test("local OCR rejects an invalid successful JSON body instead of treating it as no text", async () => {
  const originalFetch = context.fetch;
  context.fetch = async () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => {
      throw new SyntaxError("invalid JSON");
    }
  });
  try {
    await assert.rejects(() => context.__backgroundTest.requestLocalPaddleOcr({
      dataUrl: "data:image/png;base64,AQID",
      baseUrl: "http://127.0.0.1:8765",
      lang: "korean",
      mode: "fast",
      params: {},
      debug: false,
      debugId: "invalid-local-json",
      requestTimeoutMs: 100
    }), /无效 JSON/);
  } finally {
    context.fetch = originalFetch;
  }
});
test("local OCR debug preserves raw detector boxes even when final OCR items are empty", async () => {
  const debug = {
    rawItems: [],
    filteredItems: [],
    mergedItems: [],
    filterReasons: []
  };
  const items = await context.__backgroundTest.buildLocalPaddleBubbleItems({
    items: [],
    rawItems: [{
      text: "희미한글",
      score: 0.2,
      box: {
        left: 10,
        top: 20,
        width: 80,
        height: 24
      },
      lang: "korean",
      variant: "perspective_fast_raw"
    }],
    imageWidth: 160,
    imageHeight: 80
  }, {
    width: 160,
    height: 80
  }, "", false, null, context.__backgroundTest.getDefaultOcrTuning(), debug);
  assert.deepEqual(Array.from(items), []);
  assert.equal(debug.rawItems.length, 1);
  assert.equal(debug.rawItems[0].text, "희미한글");
  assert.deepEqual(JSON.parse(JSON.stringify(debug.rawItems[0].rawBox)), {
    left: 10,
    top: 20,
    width: 80,
    height: 24
  });
});
test("identical OCR fingerprints share one provider request and then use the warm v28 cache", async () => {
  const background = context.__backgroundTest;
  installMemoryStorage(separatedConfiguration());
  let providerCalls = 0;
  background.setBackgroundTestHooks({
    requestProviderNeutralOcr: async ({
      request,
      settings
    }) => {
      providerCalls += 1;
      await new Promise(resolve => setTimeout(resolve, 10));
      return {
        provider: settings.provider,
        sourceType: request.sourceType,
        pageIds: request.pageIds,
        imageRevisionByPage: request.imageRevisionByPage,
        observations: [],
        filteredObservations: [],
        edgeSignals: {
          hasAny: false
        }
      };
    }
  });
  const request = {
    dataUrl: "data:image/png;base64,T0NSLUlORkxJR0hU",
    sourceType: "page",
    pageIds: ["page-inflight"],
    imageRevision: "revision-inflight"
  };
  const [first, second] = await Promise.all([background.handleOcrDataUrl(request), background.handleOcrDataUrl(request)]);
  const warm = await background.handleOcrDataUrl(request);
  background.setBackgroundTestHooks(null);
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.equal(warm.cached, true);
  assert.equal(providerCalls, 1);
});
