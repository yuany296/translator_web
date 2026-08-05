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
test("ignoring candidate batches by chapter scope clears only that chapter", async () => {
  const stored = {
    mt_glossary_pending_v1: {
      chapters: [{
        key: "https://example.test/chapter/batch-a",
        url: "https://example.test/chapter/batch-a",
        candidates: [{
          source: "소설 제목", kind: "title", score: 0.9
        }, {
          source: "인물 이름", kind: "person", score: 0.94
        }]
      }, {
        key: "https://example.test/chapter/batch-b",
        url: "https://example.test/chapter/batch-b",
        candidates: [{
          source: "저자 이름", kind: "person", score: 0.94
        }]
      }]
    }
  };
  context.chrome.storage.local.get = (keys, callback) => {
    callback(Object.fromEntries(keys.map(key => [key, stored[key]])));
  };
  context.chrome.storage.local.set = (value, callback) => {
    Object.assign(stored, JSON.parse(JSON.stringify(value)));
    callback();
  };
  const response = await context.__backgroundTest.handleIgnoreTermCandidates({
    entries: [
      { chapterKey: "https://example.test/chapter/batch-a", source: "소설 제목" },
      { chapterKey: "https://example.test/chapter/batch-a", source: "인물 이름" },
      { chapterKey: "https://example.test/chapter/batch-b", source: "저자 이름" }
    ],
    scope: "chapter"
  });
  assert.equal(response.ok, true);
  assert.equal(response.removed, 3);
  assert.equal(stored.mt_glossary_ignored_v1.sources.length, 0);
  const chapters = stored.mt_glossary_pending_v1.chapters;
  const batchA = chapters.find(chapter => chapter.key === "https://example.test/chapter/batch-a");
  const batchB = chapters.find(chapter => chapter.key === "https://example.test/chapter/batch-b");
  assert.equal(batchA.candidates.length, 0);
  assert.deepEqual(batchA.ignoredSourceKeys.sort(), ["인물 이름", "소설 제목"].sort());
  assert.equal(batchB.candidates.length, 0);
  assert.deepEqual(batchB.ignoredSourceKeys, ["저자 이름"]);
});

test("ignoring all pending candidates globally records ignored sources", async () => {
  const stored = {
    mt_glossary_pending_v1: {
      chapters: [{
        key: "https://example.test/chapter/global-a",
        url: "https://example.test/chapter/global-a",
        candidates: [{
          source: "BOOK TITLE", kind: "latin_title", score: 0.9
        }]
      }, {
        key: "https://example.test/chapter/global-b",
        url: "https://example.test/chapter/global-b",
        candidates: [{
          source: "AUTHOR NAME", kind: "latin_name", score: 0.82
        }]
      }]
    }
  };
  context.chrome.storage.local.get = (keys, callback) => {
    callback(Object.fromEntries(keys.map(key => [key, stored[key]])));
  };
  context.chrome.storage.local.set = (value, callback) => {
    Object.assign(stored, JSON.parse(JSON.stringify(value)));
    callback();
  };
  const response = await context.__backgroundTest.handleIgnoreTermCandidates({
    entries: [
      { chapterKey: "https://example.test/chapter/global-a", source: "BOOK TITLE" },
      { chapterKey: "https://example.test/chapter/global-b", source: "AUTHOR NAME" },
      { chapterKey: "https://example.test/chapter/global-a", source: "" }
    ],
    scope: "global"
  });
  assert.equal(response.ok, true);
  assert.equal(response.removed, 2);
  assert.equal(stored.mt_glossary_pending_v1.chapters.every(chapter => chapter.candidates.length === 0), true);
  assert.deepEqual(stored.mt_glossary_ignored_v1.sources.map(item => item.source).sort(), ["AUTHOR NAME", "BOOK TITLE"].sort());
});
test("novel term discovery auto-ignores the series title even when the extractor is offline", async () => {
  const stored = {
    mt_glossary_pending_v1: {
      chapters: [{
        key: "https://example.test/viewer/7",
        url: "https://example.test/viewer/7",
        candidates: [{ source: "달의 끝에서", kind: "title", score: 0.9 }]
      }]
    },
    mt_glossary_ignored_v1: { sources: [] },
    mt_local_ocr_base_url: "http://127.0.0.1:8765",
    mt_local_service_auth_v1: { token: "test-local-service-token" }
  };
  context.chrome.storage.local.get = (keys, callback) => {
    callback(Object.fromEntries(keys.map(key => [key, stored[key]])));
  };
  context.chrome.storage.local.set = (value, callback) => {
    Object.assign(stored, JSON.parse(JSON.stringify(value)));
    callback();
  };
  context.fetch = async () => {
    throw new Error("connection refused");
  };
  context.__backgroundTest.markTermExtractorOnline();
  const request = {
    pageUrl: "https://example.test/viewer/7",
    pageTitle: "달의 끝에서 12화",
    targetKey: "novel-kakao:1:7",
    blocks: [{ id: "p1", originalText: "달의 끝에서", translatedText: "月之尽头" }],
    autoIgnoreSources: ["달의 끝에서"]
  };
  const first = await context.__backgroundTest.handleDiscoverTerms(request);
  assert.equal(first.ok, true);
  assert.equal(first.reason, "offline");
  assert.equal(stored.mt_glossary_ignored_v1.sources.length, 1);
  assert.equal(stored.mt_glossary_ignored_v1.sources[0].source, "달의 끝에서");
  assert.equal(stored.mt_glossary_pending_v1.chapters[0].candidates.length, 0);
  // 冷却期间再次触发：忽略已持久化，不重复写入
  await context.__backgroundTest.handleDiscoverTerms(request);
  assert.equal(stored.mt_glossary_ignored_v1.sources.length, 1);
});
test("extracting a term from context rejects missing input and surfaces provider errors", async () => {
  const missing = await context.__backgroundTest.handleExtractTermFromContext({
    sourceText: "",
    selectedText: "秀妍"
  });
  assert.equal(missing.ok, false);
  assert.match(missing.error, /缺少原文段落或选中文字/);
  const noKey = await context.__backgroundTest.handleExtractTermFromContext({
    sourceText: "수연이는 웃었다.",
    selectedText: "秀妍"
  });
  assert.equal(noKey.ok, false);
  assert.match(noKey.error, /API Key/);
});

test("extracting a term from context returns the model term with source presence check", async () => {
  context.__backgroundTest.setBackgroundTestHooks({
    extractTermFromContext({ sourceText, selectedText, targetLanguage }) {
      assert.equal(selectedText, "秀妍");
      assert.equal(targetLanguage, "zh-CN");
      if (sourceText.includes("불일치")) {
        return { ok: true, term: "수연", foundInSource: false };
      }
      return { ok: true, term: "수연", foundInSource: true };
    }
  });
  try {
    const matched = await context.__backgroundTest.handleExtractTermFromContext({
      sourceText: "수연이가 웃었다.",
      translatedText: "秀妍笑了。",
      selectedText: "秀妍",
      targetLanguage: "zh-CN"
    });
    assert.equal(matched.ok, true);
    assert.equal(matched.term, "수연");
    assert.equal(matched.foundInSource, true);
    const unmatched = await context.__backgroundTest.handleExtractTermFromContext({
      sourceText: "불일치 문장.",
      translatedText: "不一致的句子。",
      selectedText: "秀妍",
      targetLanguage: "zh-CN"
    });
    assert.equal(unmatched.foundInSource, false);
  } finally {
    context.__backgroundTest.setBackgroundTestHooks(null);
  }
});

