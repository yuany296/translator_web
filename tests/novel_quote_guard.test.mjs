import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import novel from "../extension/src/shared/novel.js";

/**
 * 对话引号被丢掉：两条翻译链路都必须兜住。
 *
 * 用户实测 `“난 무조건 탈색부터 한다.”` -> `我不管，肯定要先漂发。`（引号没了）。
 * 流式链路（`/translations/stream`，多数段落走这条）此前提示词里没有引号规则，
 * 也没有任何确定性修复；小批链路（`TRANSLATE_NOVEL_CHUNK`）有提示词规则与
 * `restoreDialogueQuotes`，但校验发生在修复之前，所以"丢了引号"根本没被判过。
 *
 * 现在的口径：
 *  ① 校验前先做确定性修复 —— 原文整段被引号包住的，直接补回，不占用重试；
 *  ② 修不回来的（引号与叙述混排）报 dialogue_quote_missing，走逐段重试；
 *  ③ 重试仍拿不回引号时保留译文 + dialogue_quote_warning，绝不因为格式丢整段译文；
 *  ④ 流式链路的每条事件在转发前修复，并同步改写要落库的快照。
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

function configuration() {
  return {
    mt_ocr_config_v1: {
      provider: "local_paddle", baidu: { apiKey: "", secretKey: "" },
      localPaddle: { baseUrl: "http://127.0.0.1:8765" }
    },
    mt_translation_config_v1: {
      provider: "openai_compatible", apiKey: "test-key",
      baseUrl: "https://api.deepseek.com", model: "deepseek-chat"
    }
  };
}

// ── ① 校验层：先修复再校验 ───────────────────────────────────────────────

test("整段被引号包住的原文：校验前就该补回引号，不报错也不重试", () => {
  const items = [{ id: "p1", original_text: "“난 무조건 탈색부터 한다.”" }];
  const checked = novel.validateTranslations(items, [
    { id: "p1", translated_text: "我不管，肯定要先漂发。" }
  ]);
  assert.equal(checked.errors.length, 0, "能确定性修复的不该占用重试");
  assert.deepEqual(checked.accepted, [
    { id: "p1", translated_text: "“我不管，肯定要先漂发。”" }
  ]);
  assert.deepEqual(checked.quoteFallbacks, []);
});

test("引号与叙述混排：报 dialogue_quote_missing 并给出可保留的回落译文", () => {
  const items = [{ id: "p1", original_text: "“어쩌고” 그가 말했다." }];
  const checked = novel.validateTranslations(items, [
    { id: "p1", translated_text: "他这么说。" }
  ]);
  assert.equal(checked.accepted.length, 0);
  assert.equal(checked.errors[0].code, "dialogue_quote_missing");
  assert.deepEqual(checked.quoteFallbacks, [{ id: "p1", translated_text: "他这么说。" }],
    "重试仍失败时要靠它把译文留住");
});

test("原文没引号 / 译文自己带引号：都不报", () => {
  const plain = novel.validateTranslations(
    [{ id: "p1", original_text: "난 무조건 탈색부터 한다." }],
    [{ id: "p1", translated_text: "我不管，肯定要先漂发。" }]
  );
  assert.equal(plain.errors.length, 0);
  const styled = novel.validateTranslations(
    [{ id: "p1", original_text: "「안녕」" }],
    [{ id: "p1", translated_text: "“你好”" }]
  );
  assert.equal(styled.errors.length, 0, "换一种引号风格不算丢");
});

test("引号警告的汇总文案与术语警告共用一句话，各自说清原因", () => {
  const glossary = novel.summarizeTranslationWarnings([{ id: "a", code: "glossary_warning" }]);
  assert.equal(glossary.text, "已保留全部译文，其中 1 段未完全采用术语表指定译名。");
  const quotes = novel.summarizeTranslationWarnings([{ id: "b", code: "dialogue_quote_warning" }]);
  assert.equal(quotes.text, "已保留全部译文，其中 1 段原文的对话引号没能保住。");
});

// ── ② 小批链路：丢引号 → 兜回；兜不回 → 保留译文 + 警告 ──────────────────

test("小批链路：整段引号被丢掉时译文自己带回来（用户实测那条）", async () => {
  installMemoryStorage(configuration());
  background.setBackgroundTestHooks({
    requestNovelChunk() {
      return { translations: [{ id: "p1", translated_text: "我不管，肯定要先漂发。" }] };
    }
  });
  const response = await background.handleTranslateNovelChunk({
    scopeKey: "kakao:quote",
    chapterId: "c1",
    items: [{ id: "p1", original_text: "“난 무조건 탈색부터 한다.”" }]
  });
  assert.equal(response.ok, true);
  assert.equal(response.errors.length, 0);
  assert.equal(response.translations[0].translated_text, "“我不管，肯定要先漂发。”");
});

test("小批链路：混排引号重试仍失败时保留译文并出 dialogue_quote_warning", async () => {
  installMemoryStorage(configuration());
  let calls = 0;
  background.setBackgroundTestHooks({
    requestNovelChunk() {
      calls += 1;
      return { translations: [{ id: "p1", translated_text: "他这么说。" }] };
    }
  });
  const response = await background.handleTranslateNovelChunk({
    scopeKey: "kakao:quote",
    chapterId: "c2",
    items: [{ id: "p1", original_text: "“어쩌고” 그가 말했다." }]
  });
  assert.equal(calls, 2, "先整体请求一次，再逐段重试一次");
  assert.equal(response.errors.length, 0, "格式问题不该把段落变成未翻译");
  assert.equal(response.partial, false);
  assert.equal(response.translations[0].translated_text, "他这么说。", "译文必须保留");
  assert.equal(response.warnings[0].code, "dialogue_quote_warning");
});

// ── ③ 流式链路：事件与要落库的快照都要修好 ──────────────────────────────

test("流式链路：转发前补回引号，并且改掉要落库的快照译文", async () => {
  installMemoryStorage(configuration());
  const posted = [];
  const saved = [];
  background.saveTranslationServiceSnapshots = async records => {
    saved.push(...records);
    return records;
  };
  const payload = {
    type: "paragraph", taskId: "t1", sequence: 1, paragraphKey: "pk1",
    translation: "我不管，肯定要先漂发。",
    record: {
      recordId: "r1", recordRevision: 1,
      activeVersion: { versionId: "v1", translatedText: "我不管，肯定要先漂发。" }
    }
  };
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(`${JSON.stringify(payload)}\n`));
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
        if (event.type === "paragraph") resolve();
      }
    };
    background.handleTranslationStreamPort(port);
  });
  onMessage({
    type: "start",
    request: {
      taskId: "t1", scopeKey: "kakao:quote", sourceLanguage: "auto", targetLanguage: "zh-CN",
      items: [{
        paragraphKey: "pk1", recordKey: "rk1",
        originalText: "“난 무조건 탈색부터 한다.”", recordPayload: {}
      }]
    }
  });
  await finished;
  const event = posted.find(item => item.type === "paragraph");
  assert.equal(event.translation, "“我不管，肯定要先漂发。”", "渲染用的译文要有引号");
  assert.equal(event.record.activeVersion.translatedText, "“我不管，肯定要先漂发。”",
    "落进正式译文库的快照也要有引号，否则重读还是没引号");
  assert.equal(saved.length, 1);
  assert.equal(saved[0].activeVersion.translatedText, "“我不管，肯定要先漂发。”");
});
