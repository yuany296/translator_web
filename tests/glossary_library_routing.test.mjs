import assert from "node:assert/strict";
import { webcrypto } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const source = fs.readFileSync(path.join(root, "dist", "test", "background.iife.js"), "utf8");
const CHAPTER_URL = "https://page.kakao.com/content/69299983/viewer/69333586/";
const OVERVIEW_URL = "https://page.kakao.com/content/69299983/";
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
  atob,
  crypto: webcrypto,
  setTimeout,
  clearTimeout
});
vm.runInContext(`${source}\nglobalThis.__backgroundTest = MtBackgroundModule.backgroundRuntime;`, context, {
  filename: "background.iife.js"
});
const background = context.__backgroundTest;

function installStorage(initial = {}) {
  const stored = JSON.parse(JSON.stringify(initial));
  context.chrome.storage.local.get = (keys, callback) => {
    const list = Array.isArray(keys) ? keys : [keys];
    callback(Object.fromEntries(list.map(key => [key, stored[key]])));
  };
  context.chrome.storage.local.set = (value, callback) => {
    Object.assign(stored, JSON.parse(JSON.stringify(value)));
    callback();
  };
  return stored;
}

function novelGlossary() {
  return {
    version: 4,
    revision: 1,
    libraries: [
      { id: "default", name: "默认术语库", enabled: true, urls: [] },
      { id: "kakao-novel", name: "骸骨皇女", enabled: true, urls: ["https://page.kakao.com/content/69299983"] }
    ],
    entries: []
  };
}

function plain(value) {
  return JSON.parse(JSON.stringify(value));
}

function stubExtractor(candidates) {
  background.requestTermExtractorJson = async () => ({ ok: true, engine: "heuristic", candidates });
}

const blocks = [{ id: "b1", originalText: "성현이 말했다", translatedText: "成贤说道" }];

test("discovery routes candidates into the library bound to the page URL", async () => {
  const stored = installStorage({
    mt_glossary_v2: novelGlossary(),
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:8765" } }
  });
  stubExtractor([{ source: "성현", kind: "person", score: 0.9, evidenceIds: ["b1"] }]);

  const response = await background.handleDiscoverTerms({
    type: "DISCOVER_TERMS", pageUrl: CHAPTER_URL, pageTitle: "第 12 话", targetKey: "image-1", blocks
  });

  assert.equal(response.ok, true);
  assert.equal(response.libraryId, "kakao-novel");
  const chapter = stored.mt_glossary_pending_v1.chapters[0];
  assert.equal(chapter.libraryId, "kakao-novel");
  assert.equal(chapter.libraryManual, false);
  assert.equal(chapter.candidates[0].source, "성현");
});

test("a disabled library stops capturing terms and falls back to the default library", async () => {
  const glossary = novelGlossary();
  glossary.libraries[1].enabled = false;
  const stored = installStorage({
    mt_glossary_v2: glossary,
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:8765" } }
  });
  stubExtractor([{ source: "성현", kind: "person", score: 0.9, evidenceIds: ["b1"] }]);

  const response = await background.handleDiscoverTerms({
    type: "DISCOVER_TERMS", pageUrl: `${CHAPTER_URL}?case=disabled`, targetKey: "image-1", blocks
  });

  assert.equal(response.libraryId, "");
  assert.equal(stored.mt_glossary_pending_v1.chapters[0].libraryId, "");
});

test("confirming a candidate stores it in the chapter library", async () => {
  const stored = installStorage({
    mt_glossary_v2: novelGlossary(),
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:1" } },
    mt_glossary_pending_v1: {
      chapters: [{
        key: CHAPTER_URL, url: CHAPTER_URL, title: "第 12 话", libraryId: "kakao-novel",
        candidates: [{ source: "성현", kind: "person", score: 0.9 }]
      }]
    }
  });

  const confirmed = await background.handleConfirmTermCandidates({
    entries: [{ chapterKey: CHAPTER_URL, candidateSource: "성현", source: "성현", target: "成贤" }]
  });

  assert.equal(confirmed.ok, true, JSON.stringify(plain(confirmed)));
  assert.deepEqual(plain(confirmed.libraryIds), ["kakao-novel"]);
  assert.equal(confirmed.serverSynced, false);
  const entry = stored.mt_glossary_v2.entries[0];
  assert.equal(entry.libraryId, "kakao-novel");
  assert.equal(entry.target, "成贤");
  assert.equal(stored.mt_glossary_pending_v1.chapters.length, 0);
});

test("a manually assigned chapter library wins over the URL match on confirm", async () => {
  const stored = installStorage({
    mt_glossary_v2: novelGlossary(),
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:1" } },
    mt_glossary_pending_v1: {
      chapters: [{
        key: CHAPTER_URL, url: CHAPTER_URL, title: "第 12 话", libraryId: "kakao-novel",
        candidates: [{ source: "성현", kind: "person", score: 0.9 }]
      }]
    }
  });

  const reassigned = await background.handleSetPendingChapterLibrary({
    chapterKey: CHAPTER_URL, libraryId: "default"
  });
  assert.equal(reassigned.ok, true);
  assert.equal(reassigned.pending.chapters[0].libraryManual, true);
  assert.equal(reassigned.pending.chapters[0].libraryId, "default");

  const confirmed = await background.handleConfirmTermCandidates({
    entries: [{ chapterKey: CHAPTER_URL, candidateSource: "성현", source: "성현", target: "成贤" }]
  });
  assert.equal(confirmed.ok, true);
  assert.deepEqual(plain(confirmed.libraryIds), ["default"]);
  assert.equal(stored.mt_glossary_v2.entries[0].libraryId, "default");
});

test("an explicit chapter library is not overwritten by a later URL match", async () => {
  const manualUrl = `${CHAPTER_URL}?case=manual`;
  const stored = installStorage({
    mt_glossary_v2: novelGlossary(),
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:8765" } },
    mt_glossary_pending_v1: {
      chapters: [{
        key: manualUrl, url: manualUrl, title: "第 12 话",
        libraryId: "default", libraryManual: true, candidates: []
      }]
    }
  });
  stubExtractor([{ source: "성현", kind: "person", score: 0.9, evidenceIds: ["b-manual"] }]);

  await background.handleDiscoverTerms({
    type: "DISCOVER_TERMS",
    pageUrl: manualUrl,
    targetKey: "image-2",
    blocks: [{ id: "b-manual", originalText: "성현이 말했다", translatedText: "成贤说道" }]
  });

  const chapter = stored.mt_glossary_pending_v1.chapters[0];
  assert.equal(chapter.libraryId, "default");
  assert.equal(chapter.libraryManual, true);
  assert.equal(chapter.candidates.length, 1);
});

test("term discovery state exposes library definitions to the panel", async () => {
  installStorage({ mt_glossary_v2: novelGlossary() });

  const state = await background.handleGetTermDiscoveryState({});

  assert.deepEqual(plain(state.libraries).map(library => library.id), ["default", "kakao-novel"]);
  assert.deepEqual(plain(state.libraries)[1].urls, ["https://page.kakao.com/content/69299983"]);
  assert.equal(state.libraries[1].name, "骸骨皇女");
  assert.equal(OVERVIEW_URL.startsWith(state.libraries[1].urls[0]), true);
});

// 「管理当前章节译文」侧栏加术语：这一章通常从未跑过候选提取，
// pending 里没有它，只能靠请求里带的页面地址认归属库。
const UNBOUND_URL = "https://page.kakao.com/content/11111111/viewer/22222222/";

test("adding a term from the chapter manager lands in the library bound to the page URL", async () => {
  const stored = installStorage({
    mt_glossary_v2: novelGlossary(),
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:1" } }
  });

  const confirmed = await background.handleConfirmTermCandidates({
    entries: [{ source: "이율", target: "伊律", pageUrl: CHAPTER_URL, chapterKey: CHAPTER_URL }]
  });

  assert.equal(confirmed.ok, true, JSON.stringify(plain(confirmed)));
  assert.deepEqual(plain(confirmed.libraryIds), ["kakao-novel"]);
  assert.deepEqual(plain(confirmed.libraryNames), ["骸骨皇女"]);
  const entry = stored.mt_glossary_v2.entries[0];
  assert.equal(entry.libraryId, "kakao-novel");
  assert.equal(entry.target, "伊律");
});

test("a page with no bound library still falls back to the default library", async () => {
  const stored = installStorage({
    mt_glossary_v2: novelGlossary(),
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:1" } }
  });

  const confirmed = await background.handleConfirmTermCandidates({
    entries: [{ source: "이율", target: "伊律", pageUrl: UNBOUND_URL, chapterKey: UNBOUND_URL }]
  });

  assert.equal(confirmed.ok, true);
  assert.deepEqual(plain(confirmed.libraryIds), ["default"]);
  assert.equal(stored.mt_glossary_v2.entries[0].libraryId, "default");
});

test("an entry that names its own library beats the page URL match", async () => {
  const stored = installStorage({
    mt_glossary_v2: novelGlossary(),
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:1" } }
  });

  const confirmed = await background.handleConfirmTermCandidates({
    entries: [{ source: "이율", target: "伊律", pageUrl: CHAPTER_URL, libraryId: "default" }]
  });

  assert.equal(confirmed.ok, true);
  assert.deepEqual(plain(confirmed.libraryIds), ["default"]);
  assert.equal(stored.mt_glossary_v2.entries[0].libraryId, "default");
});

test("a disabled library bound to the page URL does not capture the term", async () => {
  const glossary = novelGlossary();
  glossary.libraries[1].enabled = false;
  const stored = installStorage({
    mt_glossary_v2: glossary,
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:1" } }
  });

  const confirmed = await background.handleConfirmTermCandidates({
    entries: [{ source: "이율", target: "伊律", pageUrl: CHAPTER_URL }]
  });

  assert.equal(confirmed.ok, true);
  assert.deepEqual(plain(confirmed.libraryIds), ["default"]);
  assert.equal(stored.mt_glossary_v2.entries[0].libraryId, "default");
});

test("a chapter that already has a library keeps it over the page URL match", async () => {
  const stored = installStorage({
    mt_glossary_v2: novelGlossary(),
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:1" } },
    mt_glossary_pending_v1: {
      chapters: [{
        key: CHAPTER_URL, url: CHAPTER_URL, title: "第 12 话", libraryId: "default",
        libraryManual: true, candidates: []
      }]
    }
  });

  const confirmed = await background.handleConfirmTermCandidates({
    entries: [{ source: "이율", target: "伊律", pageUrl: CHAPTER_URL, chapterKey: CHAPTER_URL }]
  });

  assert.equal(confirmed.ok, true);
  assert.deepEqual(plain(confirmed.libraryIds), ["default"]);
  assert.equal(stored.mt_glossary_v2.entries[0].libraryId, "default");
});

// 术语库页按 id 删行：再次确认同一条术语时必须沿用它原来的 id，
// 否则本地 id 与服务端各走一套，删除会打到服务端不存在的行上，刷新后术语又回来了。
test("re-confirming an existing term keeps its entry id", async () => {
  const glossary = novelGlossary();
  glossary.entries = [{
    id: "term-keep-me", source: "성현", target: "成贤",
    sourceLanguage: "ko", targetLanguage: "zh-CN", enabled: true,
    scope: "global", scopeKey: "", scopeLabel: "", libraryId: "kakao-novel"
  }];
  const stored = installStorage({
    mt_glossary_v2: glossary,
    // 原文语言已无「自动识别」：词条按 ko 语言对匹配，存档必须显式给 ko（旧缺省曾依赖 auto 的文本判定）。
    mt_translation_config_v1: { sourceLanguage: "ko", targetLanguage: "zh-CN" },
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:1" } },
    mt_glossary_pending_v1: {
      chapters: [{
        key: CHAPTER_URL, url: CHAPTER_URL, title: "第 12 话", libraryId: "kakao-novel",
        candidates: [{ source: "성현", kind: "person", score: 0.9 }]
      }]
    }
  });

  const confirmed = await background.handleConfirmTermCandidates({
    entries: [{ chapterKey: CHAPTER_URL, candidateSource: "성현", source: "성현", target: "成贤" }]
  });

  assert.equal(confirmed.ok, true, JSON.stringify(plain(confirmed)));
  assert.deepEqual(plain(confirmed.libraryIds), ["kakao-novel"]);
  assert.equal(stored.mt_glossary_v2.entries.length, 1);
  assert.equal(stored.mt_glossary_v2.entries[0].id, "term-keep-me");
});

// 术语没收集到时，界面必须说得出是哪一步：成功几条 / 跳过原因 / 失败原因。
// （提取器的健康探测会把状态翻回「在线」，所以失败原因要单独记账，不能被盖掉。）
test("每次自动提取的结果都会记账", async () => {
  const first = installStorage({
    mt_glossary_v2: novelGlossary(),
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:8765" } },
    mt_glossary_pending_v1: { chapters: [] }
  });
  stubExtractor([{ source: "성현", kind: "person", score: 0.9, evidenceIds: ["b1"] }]);
  background.markTermExtractorOnline();
  const request = {
    type: "DISCOVER_TERMS",
    pageUrl: "https://page.kakao.com/content/69299983/viewer/ledger-case/",
    pageTitle: "第 12 话",
    targetKey: "image-ledger",
    blocks
  };
  await background.handleDiscoverTerms(request);
  assert.equal(first.mt_term_discovery_last_v1.outcome, "added");
  assert.equal(first.mt_term_discovery_last_v1.added, 1);
  assert.equal(first.mt_term_discovery_last_v1.returned, 1);

  // 同样的段落再提取一次：会说「已经提取过」，而不是假装什么都没发生
  await background.handleDiscoverTerms(request);
  assert.equal(first.mt_term_discovery_last_v1.outcome, "skipped");
  assert.equal(first.mt_term_discovery_last_v1.reason, "already_processed");

  // 提取器本身报错：原因要落盘（页面上显示「在线」也不该盖掉它）
  const second = installStorage({
    mt_glossary_v2: novelGlossary(),
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:8765" } },
    mt_glossary_pending_v1: { chapters: [] }
  });
  background.markTermExtractorOnline();
  background.requestTermExtractorJson = async () => {
    throw new Error("401 Unauthorized");
  };
  const failed = await background.handleDiscoverTerms({
    type: "DISCOVER_TERMS",
    pageUrl: "https://page.kakao.com/content/69299983/viewer/ledger-fail/",
    targetKey: "image-ledger-fail",
    blocks
  });
  assert.equal(failed.reason, "offline");
  assert.equal(second.mt_term_discovery_last_v1.outcome, "failed");
  assert.match(String(second.mt_term_discovery_last_v1.error), /401 Unauthorized/);
});

// 提取预算按分段数放大：服务端每 3000 字符一次 LLM 调用、串行跑。
// 固定 600 秒时，大章节「还在正常跑」就被判超时、结果整份丢掉 + 冷却 5 分钟。
test("提取超时预算随章节长度放大，且有上下限", () => {
  const short = background.termExtractionTimeoutMs([
    { originalText: "성현이 말했다", translatedText: "成贤说道" }
  ]);
  assert.equal(short, background.TERM_EXTRACTOR_MIN_LLM_TIMEOUT_MS, "短章节不该等满 10 分钟");

  const medium = background.termExtractionTimeoutMs([
    { originalText: "가".repeat(9000), translatedText: "啊".repeat(9000) }
  ]);
  assert.equal(medium, 6 * background.TERM_EXTRACTOR_CHUNK_BUDGET_MS, "18000 字 = 6 段");

  const huge = background.termExtractionTimeoutMs([
    { originalText: "가".repeat(120000), translatedText: "啊".repeat(120000) }
  ]);
  assert.equal(huge, background.TERM_EXTRACTOR_MAX_TIMEOUT_MS, "再长也有上限");
});

// 本地模型那条路（NER）是 CPU 推理：8 秒必然超时（冷启动就要 10 秒以上），
// 而预算只该随字数放大 —— 它没有上游排队这回事。
test("本地模型的超时预算按字数算，且不被 8 秒那档掐死", () => {
  const short = background.termLocalExtractionTimeoutMs([
    { originalText: "성현이 말했다", translatedText: "成贤说道" }
  ]);
  assert.equal(short, background.TERM_EXTRACTOR_LOCAL_TIMEOUT_MS, "短章节给足冷启动时间");
  assert.ok(short > background.TERM_EXTRACTOR_TIMEOUT_MS, "必须比原来那 8 秒宽");

  const long = background.termLocalExtractionTimeoutMs([
    { originalText: "가".repeat(60000), translatedText: "啊".repeat(60000) }
  ]);
  assert.ok(long > short, "12 万字要放大预算");
  assert.equal(long, Math.ceil(120000 / background.TERM_EXTRACTOR_LOCAL_CHARS_PER_SECOND) * 1000);

  assert.equal(background.termDiscoveryTimeoutMs([], true), background.TERM_EXTRACTOR_MIN_LLM_TIMEOUT_MS);
  assert.equal(background.termDiscoveryTimeoutMs([], false), background.TERM_EXTRACTOR_LOCAL_TIMEOUT_MS);
});

test("提取超时只罚一分钟冷却，并单独记账", async () => {
  const stored = installStorage({
    mt_glossary_v2: novelGlossary(),
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:8765" } },
    mt_glossary_pending_v1: { chapters: [] }
  });
  background.markTermExtractorOnline();
  background.requestTermExtractorJson = async () => {
    const timeout = new Error("术语提取请求超时");
    timeout.timeout = true;
    throw timeout;
  };
  const response = await background.handleDiscoverTerms({
    type: "DISCOVER_TERMS",
    pageUrl: "https://page.kakao.com/content/69299983/viewer/timeout-case/",
    targetKey: "image-timeout",
    blocks
  });
  // 内容脚本只认 offline/cooldown/throttled 才会自动重试
  assert.equal(response.reason, "offline");
  assert.equal(stored.mt_term_discovery_last_v1.outcome, "failed");
  assert.equal(stored.mt_term_discovery_last_v1.reason, "timeout");
  assert.match(String(stored.mt_term_discovery_last_v1.error), /超时/);
  const remaining = background.getTermExtractorStatusSnapshot().cooldownUntil - Date.now();
  assert.ok(remaining > 0, "超时后要短暂退避一下");
  assert.ok(remaining <= background.TERM_EXTRACTOR_TIMEOUT_COOLDOWN_MS + 1000,
    "超时只罚一分钟，不能罚满 5 分钟，否则后面几章的收集一起被罚掉");
});

test("提取还在跑就先记账：页面能显示「正在提取」而不是一片空白", async () => {
  const stored = installStorage({
    mt_glossary_v2: novelGlossary(),
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:8765" } },
    mt_glossary_pending_v1: { chapters: [] }
  });
  background.markTermExtractorOnline();
  let release = () => {};
  const gate = new Promise(resolve => { release = resolve; });
  background.requestTermExtractorJson = () => gate;
  const running = background.handleDiscoverTerms({
    type: "DISCOVER_TERMS",
    pageUrl: "https://page.kakao.com/content/69299983/viewer/running-case/",
    targetKey: "image-running",
    blocks
  });
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(stored.mt_term_discovery_last_v1.outcome, "running");
  assert.ok(stored.mt_term_discovery_last_v1.startedAt > 0);
  assert.ok(stored.mt_term_discovery_last_v1.budgetMs > 0, "页面上要能说清本次预算");

  release({ ok: true, engine: "heuristic", candidates: [{ source: "성현", kind: "person", score: 0.9, evidenceIds: ["b1"] }] });
  const done = await running;
  assert.equal(done.added, 1);
  assert.equal(stored.mt_term_discovery_last_v1.outcome, "added");
  assert.equal(stored.mt_term_discovery_last_v1.added, 1);
});

// 事故回归：整章术语提取挂在 LLM 上游（超时上限 10 分钟）时，用户点「确认加入」/
// 「本话忽略」曾经一起卡死——它们和提取请求排在后台同一条串行队列里，
// 页面端又没有超时，看起来就是「按钮点不动」，重载扩展才恢复。
test("a stalled term extraction no longer blocks confirming a candidate", async () => {
  const stored = installStorage({
    mt_glossary_v2: novelGlossary(),
    // 端口 1：确认流程里的服务端同步会立刻失败，别打到真实的本地服务。
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:1" } },
    mt_glossary_pending_v1: {
      chapters: [{
        key: CHAPTER_URL, url: CHAPTER_URL, title: "第 12 话", libraryId: "kakao-novel",
        candidates: [{ source: "성현", kind: "person", score: 0.9 }]
      }]
    }
  });
  background.markTermExtractorOnline();
  const originalExtractor = background.requestTermExtractorJson;
  let releaseExtraction = () => {};
  const stalledExtraction = new Promise(resolve => { releaseExtraction = resolve; });
  background.requestTermExtractorJson = () => stalledExtraction;
  const stalled = background.handleDiscoverTerms({
    type: "DISCOVER_TERMS",
    pageUrl: "https://page.kakao.com/content/69299983/viewer/blocked-case/",
    targetKey: "image-blocked",
    blocks: [{ id: "b-blocked", originalText: "성현이 말했다", translatedText: "成贤说道" }]
  });

  const confirmed = await Promise.race([
    background.handleConfirmTermCandidates({
      entries: [{ chapterKey: CHAPTER_URL, candidateSource: "성현", source: "성현", target: "成贤" }]
    }),
    new Promise(resolve => setTimeout(() => resolve("blocked"), 500))
  ]);

  assert.notEqual(confirmed, "blocked", "确认不该排在整章术语提取后面");
  assert.equal(confirmed.ok, true, JSON.stringify(plain(confirmed)));
  assert.equal(stored.mt_glossary_v2.entries[0].target, "成贤");

  // 放行提取：结果晚到也不能把用户刚确认的术语重新塞回待确认。
  releaseExtraction({
    ok: true, engine: "heuristic",
    candidates: [{ source: "성현", kind: "person", score: 0.9, evidenceIds: ["b-blocked"] }]
  });
  await stalled;
  await new Promise(resolve => setTimeout(resolve, 20));
  background.requestTermExtractorJson = originalExtractor;
  assert.equal(stored.mt_glossary_pending_v1.chapters.every(chapter => chapter.candidates.length === 0), true);
  assert.equal(stored.mt_glossary_v2.entries.length, 1, "术语没有因为提取回写而重复");
});

// 手动「提取本章术语」：点下去必须真的再跑一次，不能被 30 秒节流/「已处理」挡住。
test("force 的手动提取绕过节流与已处理过滤", async () => {
  const stored = installStorage({
    mt_glossary_v2: novelGlossary(),
    mt_ocr_config_v1: { localPaddle: { baseUrl: "http://127.0.0.1:8765" } },
    mt_glossary_pending_v1: { chapters: [] }
  });
  let calls = 0;
  background.requestTermExtractorJson = async () => {
    calls += 1;
    return { ok: true, engine: "ner", candidates: [{ source: "성현", kind: "person", score: 0.9, evidenceIds: ["b1"] }] };
  };
  background.markTermExtractorOnline("ner");
  const request = {
    type: "DISCOVER_TERMS",
    pageUrl: "https://page.kakao.com/content/69299983/viewer/manual/",
    pageTitle: "第 3 话",
    targetKey: "manual-force",
    blocks
  };
  await background.handleDiscoverTerms(request);
  assert.equal(calls, 1);

  const throttled = await background.handleDiscoverTerms(request);
  assert.equal(throttled.skipped, true, "自动那条路再点一次会被挡");

  const forced = await background.handleDiscoverTerms({ ...request, force: true });
  assert.equal(calls, 2, "手动提取要真的发出去");
  assert.equal(forced.ok, true);
  assert.equal(forced.skipped, undefined);
  assert.equal(stored.mt_term_discovery_last_v1.outcome, "added");
});
