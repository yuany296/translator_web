import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import novel from "../extension/src/shared/novel.js";
import { buildStreamGlossaryGuard } from "../extension/src/background/modules/translation-stream.js";

/**
 * 流式链路的术语强制。
 *
 * 用户反馈「术语有时候会不正确」，而且「全站生效的时候也会这样」—— 全站生效只决定
 * 哪些条目进提示词，管不住模型有没有照用。多数段落走的是流式链路
 * (`/translations/stream`)：它此前只把术语塞进提示词，事件一到就落库 + 渲染，模型
 * 自己发挥也照样显示；而小批链路 (TRANSLATE_NOVEL_CHUNK) 有
 * `validateTranslations` 校验 + 带纠正意见重试 + 「术语违规保留译文并出警告」回落。
 *
 * 现在流式链路复用同一套校验：漏用术语的段落不转发、不写进译文库缓存镜像，内容侧
 * 于是仍把它算作未翻译，随后由渐进小批链路按术语重译。
 */

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "dist", "test", "background.iife.js"), "utf8");
const listeners = { addListener() {} };
const context = vm.createContext({
  chrome: {
    runtime: { onInstalled: listeners, onStartup: listeners, onMessage: listeners },
    tabs: {},
    storage: { local: {} }
  },
  console,
  fetch,
  URL,
  Blob,
  AbortController,
  TextDecoder,
  TextEncoder,
  ReadableStream,
  atob,
  crypto: webcrypto,
  setTimeout,
  clearTimeout
});
vm.runInContext(`${source}\nglobalThis.__backgroundTest = MtBackgroundModule.backgroundRuntime;`, context, {
  filename: "background.iife.js"
});
const background = context.__backgroundTest;

const TERM_SOURCE = "레오나르도";
const TERM_TARGET = "莱昂纳多";

function installMemoryStorage(initial = {}) {
  const stored = JSON.parse(JSON.stringify(initial));
  context.chrome.runtime.lastError = null;
  context.chrome.storage.local.get = (keys, callback) => {
    if (keys === null) {
      callback({ ...stored });
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

/** 术语库留空应用网址 = 全站生效（用户说的「全局生效」）。 */
function configuration() {
  return {
    mt_ocr_config_v1: {
      provider: "local_paddle", baidu: { apiKey: "", secretKey: "" },
      localPaddle: { baseUrl: "http://127.0.0.1:8765" }
    },
    mt_translation_config_v1: {
      provider: "openai_compatible", apiKey: "test-key",
      baseUrl: "https://api.deepseek.com", model: "deepseek-chat"
    },
    mt_glossary_v2: {
      version: 4,
      libraries: [{ id: "lib-1", name: "回归者", enabled: true, urls: [], applyUrls: [] }],
      entries: [{ id: "t1", source: TERM_SOURCE, target: TERM_TARGET, libraryId: "lib-1" }]
    }
  };
}

// ── ① 守卫本身：只拦「命中术语却没照用」 ──────────────────────────────────

test("命中术语且照用指定译名：不拦", () => {
  const guard = buildStreamGlossaryGuard({ novelCore: novel },
    [{ source: TERM_SOURCE, target: TERM_TARGET }], { sourceLanguage: "ko", targetLanguage: "zh-CN" });
  assert.deepEqual(guard("레오나르도가 말했다.", "莱昂纳多说道。"), []);
});

test("命中术语但模型自己发挥：报 glossary_violation 并点名术语", () => {
  const guard = buildStreamGlossaryGuard({ novelCore: novel },
    [{ source: TERM_SOURCE, target: TERM_TARGET }], { sourceLanguage: "ko", targetLanguage: "zh-CN" });
  const violations = guard("레오나르도가 말했다.", "列奥纳多说道。");
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, "glossary_violation");
  assert.deepEqual(violations[0].terms, [TERM_SOURCE]);
});

test("没命中术语的段落不受影响（不能因为有术语就拦全文）", () => {
  const guard = buildStreamGlossaryGuard({ novelCore: novel },
    [{ source: TERM_SOURCE, target: TERM_TARGET }], { sourceLanguage: "ko", targetLanguage: "zh-CN" });
  assert.deepEqual(guard("그는 조용히 고개를 끄덕였다.", "他默默点了点头。"), []);
});

test("没有术语条目时不装守卫（保持零开销）", () => {
  assert.equal(buildStreamGlossaryGuard({ novelCore: novel }, [], {}), null);
  assert.equal(buildStreamGlossaryGuard({ novelCore: novel }, null, {}), null);
});

// ── ② 流式链路：漏用术语的段落不渲染、不进缓存镜像 ────────────────────────

test("流式链路：漏用术语的事件不转发，合规段落与「说明了语境」的段落照常转发", async () => {
  installMemoryStorage(configuration());
  const posted = [];
  const saved = [];
  background.saveTranslationServiceSnapshots = async records => {
    saved.push(...records);
    return records;
  };
  // 顺序有意如此：被拒的那条放最后，测试桩在收到 glossary_rejected 时就能断定前面的都已转发。
  const rows = [
    { type: "paragraph", taskId: "t1", sequence: 1, paragraphKey: "pk1",
      translation: "莱昂纳多说道。", terms: { used: [TERM_SOURCE], skipped: [] },
      record: { recordId: "r1", recordRevision: 1, activeVersion: { versionId: "v1", translatedText: "莱昂纳多说道。" } } },
    // 模型判定这一句里不是那个人，并写明了理由 → 尊重判断，照常渲染
    { type: "paragraph", taskId: "t1", sequence: 2, paragraphKey: "pk3",
      translation: "那是一幅画。",
      terms: { used: [], skipped: [{ source: TERM_SOURCE, reason: "이 문장에서는 그림 이름" }] },
      record: { recordId: "r3", recordRevision: 1, activeVersion: { versionId: "v3", translatedText: "那是一幅画。" } } },
    { type: "paragraph", taskId: "t1", sequence: 3, paragraphKey: "pk2",
      translation: "列奥纳多打了一架。", terms: { used: [], skipped: [] },
      record: { recordId: "r2", recordRevision: 1, activeVersion: { versionId: "v2", translatedText: "列奥纳多打了一架。" } } }
  ];
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${rows.map(row => JSON.stringify(row)).join("\n")}\n`));
      controller.close();
    }
  });
  context.fetch = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/x-ndjson" },
    body
  });
  let onMessage = null;
  const finished = new Promise(resolve => {
    const port = {
      name: "mt-translation-stream-v1",
      onMessage: { addListener(listener) { onMessage = listener; } },
      onDisconnect: { addListener() {} },
      postMessage(event) {
        posted.push(event);
        if (event.type === "glossary_rejected") resolve();
      }
    };
    background.handleTranslationStreamPort(port);
  });
  onMessage({
    type: "start",
    request: {
      taskId: "t1", scopeKey: "kakao:69299983", sourceLanguage: "auto", targetLanguage: "zh-CN",
      items: [
        { paragraphKey: "pk1", recordKey: "rk1", originalText: "레오나르도가 말했다.", recordPayload: {} },
        { paragraphKey: "pk2", recordKey: "rk2", originalText: "레오나르도와 싸웠다.", recordPayload: {} },
        { paragraphKey: "pk3", recordKey: "rk3", originalText: "레오나르도 그림을 봤다.", recordPayload: {} }
      ]
    }
  });
  await finished;
  const paragraphs = posted.filter(event => event.type === "paragraph");
  assert.deepEqual(paragraphs.map(event => event.paragraphKey), ["pk1", "pk3"],
    "静默漏用的段落必须留在「未翻译」交给小批链路重译；写明语境的照常渲染");
  const rejected = posted.find(event => event.type === "glossary_rejected");
  assert.equal(rejected.paragraphKey, "pk2");
  // terms 是 vm 上下文里造的数组,跨 realm 比较要先摊平到本 realm。
  assert.deepEqual([...rejected.terms], [TERM_SOURCE]);
  assert.deepEqual(saved.map(record => record.recordId), ["r1", "r3"],
    "被拒的译文不能写进译文库缓存镜像，否则下次读缓存又把它放回来");
});
