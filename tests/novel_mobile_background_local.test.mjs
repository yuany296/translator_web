import assert from "node:assert/strict";
import test from "node:test";
import { applyBackgroundLocal } from "../extension/src/novel-mobile/background-local.js";
import termDiscoveryCore from "../extension/src/shared/term-discovery.js";

// 手机版后台覆盖层的行为测试：用假 runtime 直接驱动覆盖后的函数，
// 不依赖任何构建产物，也不碰 chrome.*。
function makeRuntime(overrides = {}) {
  const calls = { saved: [], queued: [], merged: [], offline: [], stored: [] };
  let storedRecord = null;
  const status = { state: "unknown", engine: "", error: "" };
  const runtime = {
    getTranslationCacheRecord: async () => storedRecord,
    saveTranslationCacheRecords: async records => {
      calls.saved.push(...records);
      return { ok: true, saved: records.length };
    },
    queuePendingTranslationOperation: async () => {
      calls.queued.push("queued");
      throw new Error("手机版不允许把译文写进 pendingOperations 队列");
    },
    loadConfiguration: async () => ({}),
    termLlmConfig: () => ({ baseUrl: "https://api.example.com/v1", model: "m", apiKey: "k" }),
    markTermExtractorOnline: engine => Object.assign(status, { state: "online", engine, error: "" }),
    markTermExtractorOffline: (error, engine, now, cooldownMs) => {
      calls.offline.push({ error: String(error && error.message || error), engine, now, cooldownMs });
      Object.assign(status, { state: "offline", error: String(error && error.message || error) });
    },
    getTermExtractorStatusSnapshot: () => ({ ...status }),
    prepareDiscovery: async () => ({
      pageUrl: "u",
      blocks: [{ id: "b1" }, { id: "b2" }],
      llmMode: true,
      requestBody: { blocks: [{ id: "b1" }, { id: "b2" }] }
    }),
    mergeDiscovery: async (prepared, payload, options = {}) => {
      calls.merged.push({ prepared, payload, options });
      return { ok: true, added: 1 };
    },
    storageSet: async value => calls.stored.push(value),
    storageGet: async () => ({}),
    sendOpenAICompatibleTranslationRequest: async () => ({ content: "[]" }),
    buildOpenAICompatibleEndpoint: base => `${base}/chat/completions`,
    extractOpenAIMessageText: value => String(value || ""),
    parseModelJson: () => null,
    getErrorMessage: error => String(error && error.message || error || ""),
    TERM_EXTRACTOR_COOLDOWN_MS: 300000,
    TERM_EXTRACTOR_TIMEOUT_COOLDOWN_MS: 60000,
    ...overrides
  };
  applyBackgroundLocal(runtime);
  return {
    runtime,
    calls,
    setStoredRecord: record => { storedRecord = record; },
    status: () => ({ ...status })
  };
}

function operation(overrides = {}) {
  return {
    type: "commit_translation",
    recordKey: "record-1",
    payload: {
      mode: "novel",
      scopeKey: "kakao:1",
      segmentKey: "p1",
      workId: "1",
      chapterId: "c1",
      rawSourceText: "원문 1",
      normalizedSourceText: "원문1",
      rawSourceHash: "raw1",
      normalizedSourceHash: "norm1",
      configuredSourceLanguage: "auto",
      resolvedSourceLanguage: "ko",
      targetLanguage: "zh-CN",
      translatedText: "第一段译文",
      source: "api",
      configFingerprint: "fp-1",
      ...overrides
    }
  };
}

test("本地提交直接写 IndexedDB，绝不进 pendingOperations 队列", async () => {
  const harness = makeRuntime();
  const result = await harness.runtime.commitOrQueueTranslationOperation(operation());
  assert.equal(result.ok, true);
  assert.equal(result.pending, false);
  assert.equal(result.record.activeVersion.translatedText, "第一段译文");
  assert.equal(harness.calls.queued.length, 0, "手机版没有队列可刷，入队等于永久丢失");
  assert.equal(harness.calls.saved.length, 1);
  const record = harness.calls.saved[0];
  assert.equal(record.id, "record-1");
  assert.equal(record.mode, "novel");
  assert.equal(record.translatedText, "第一段译文");
  assert.equal(record.sourceText, "원문 1");
  assert.equal(record.paragraphKey, "p1", "缓存命中判定要和桌面版记录结构一致");
  assert.equal(record.translationConfigFingerprint, "fp-1");
  assert.deepEqual(record.versions.map(version => version.translatedText), ["第一段译文"]);
});

test("已有记录时保留旧版本、最新版为活动版本，且最多留 5 版", async () => {
  const previous = Array.from({ length: 6 }, (_, index) => ({
    id: `v${index}`, translatedText: `旧译 ${index}`, source: "api", createdAt: index + 1
  }));
  const harness = makeRuntime();
  harness.setStoredRecord({ id: "record-1", mode: "novel", createdAt: 1, versions: previous });
  const result = await harness.runtime.commitOrQueueTranslationOperation(operation());
  assert.equal(result.ok, true);
  const versions = harness.calls.saved[0].versions;
  assert.equal(versions.length, 5);
  assert.equal(versions[0].translatedText, "第一段译文");
  assert.deepEqual(versions.slice(1).map(version => version.translatedText), ["旧译 0", "旧译 1", "旧译 2", "旧译 3"]);
});

test("缺 recordKey 或空译文时不写库，也不入队", async () => {
  const harness = makeRuntime();
  const noKey = await harness.runtime.commitOrQueueTranslationOperation({ payload: { translatedText: "x" } });
  assert.equal(noKey.ok, false);
  const empty = await harness.runtime.commitOrQueueTranslationOperation(operation({ translatedText: "   " }));
  assert.equal(empty.ok, false);
  assert.equal(harness.calls.saved.length, 0);
  assert.equal(harness.calls.queued.length, 0);
});

test("本地服务状态、流式端口、章节管理面板都直接报「本地/不支持」", async () => {
  const harness = makeRuntime();
  const { runtime } = harness;
  const status = await runtime.getTranslationServiceStatus();
  assert.equal(status.ok, true);
  assert.equal(status.status, "local");
  assert.equal((await runtime.syncTranslationService()).records.length, 0);
  assert.deepEqual(await runtime.flushPendingTranslationOperations(), { submitted: 0, remaining: 0, conflicts: [] });
  assert.equal((await runtime.migrateLegacyTranslations()).skipped, true);
  assert.equal(runtime.handleTranslationStreamPort({}), false);
  const panel = await runtime.openNovelManageUi({}, "");
  assert.equal(panel.ok, false);
  assert.deepEqual((await runtime.queryTranslationService(["a"])).records, []);
  assert.deepEqual((await runtime.submitTranslationOperations([{}])).results, []);
  assert.equal((await runtime.getTranslationVersions("x")).ok, false);
});

test("未配置提取用 AI 服务时：整章提取直接跳过且不进重试循环", async () => {
  let prepared = 0;
  const harness = makeRuntime({
    termLlmConfig: () => ({ baseUrl: "", model: "", apiKey: "" }),
    prepareDiscovery: async () => {
      prepared += 1;
      return { skip: "cooldown" };
    }
  });
  const result = await harness.runtime.runTermDiscovery({ pageUrl: "u" });
  assert.equal(result.ok, true);
  assert.equal(result.skipped, true);
  // content 侧只对 offline/cooldown/throttled 重试：这里必须报 disabled，否则会 40×30s 空转
  assert.equal(result.reason, "disabled");
  assert.equal(prepared, 0, "没配服务就不该走到 prepareDiscovery（那里可能报 cooldown 触发重试）");
});

test("配置了提取服务时：走本地直连 LLM，并复用 prepare/merge 两段", async () => {
  const harness = makeRuntime();
  const asked = [];
  harness.runtime.requestChapterTermExtraction = async requestBody => {
    asked.push(requestBody);
    return { ok: true, engine: "llm", candidates: [{ source: "김성현", kind: "person", score: 0.94 }] };
  };
  const result = await harness.runtime.runTermDiscovery({ pageUrl: "u", blocks: [] });
  assert.equal(result.ok, true);
  assert.equal(result.added, 1);
  assert.equal(asked.length, 1);
  assert.equal(harness.calls.merged.length, 1);
  assert.equal(harness.calls.merged[0].payload.candidates[0].source, "김성현");
  assert.equal(harness.status().state, "online");
  assert.equal(harness.status().engine, "llm");
});

test("提取请求失败时报 offline（content 会按既有策略重试）", async () => {
  const harness = makeRuntime();
  harness.runtime.requestChapterTermExtraction = async () => ({ ok: false, error: "LLM 术语提取失败" });
  const result = await harness.runtime.runTermDiscovery({ pageUrl: "u" });
  assert.equal(result.skipped, true);
  assert.equal(result.reason, "offline");
  assert.equal(harness.calls.merged.length, 0);
  assert.equal(harness.status().state, "offline");
});

test("超时失败只罚 60 秒冷却，其它失败才 5 分钟", async () => {
  const timedOut = makeRuntime();
  timedOut.runtime.requestChapterTermExtraction = async () => ({ ok: false, error: "超时", timedOut: true });
  await timedOut.runtime.runTermDiscovery({ pageUrl: "u" });
  assert.equal(timedOut.calls.offline[0].cooldownMs, 60000, "这次太慢不该冻结 5 分钟");

  const broken = makeRuntime();
  broken.runtime.requestChapterTermExtraction = async () => ({ ok: false, error: "HTTP 500" });
  await broken.runtime.runTermDiscovery({ pageUrl: "u" });
  assert.equal(broken.calls.offline[0].cooldownMs, undefined, "用默认的 5 分钟冷却");
});

test("分段失败（partial）：只有成功分段覆盖的块算已处理，并要求 content 重试", async () => {
  const harness = makeRuntime();
  harness.runtime.requestChapterTermExtraction = async () => ({
    ok: true,
    engine: "llm",
    candidates: [{ source: "김성현", kind: "person", score: 0.94 }],
    dropped: { unknownKind: 1 },
    partial: { totalChunks: 2, failedChunks: 1, timedOutChunks: 1, coveredBlockIds: ["b2"] }
  });
  const result = await harness.runtime.runTermDiscovery({ pageUrl: "u" });
  assert.equal(result.ok, true);
  assert.equal(result.reason, "partial", "content 侧对 partial 会自动补跑");
  assert.equal(result.failedChunks, 1);
  assert.deepEqual(harness.calls.merged[0].options.processedBlockIds, ["b2"],
    "失败分段覆盖的块不能标记已处理，否则那些术语永远不会再被提取");
  const last = harness.calls.stored.at(-1).mt_term_discovery_last_v1;
  assert.equal(last.outcome, "partial");
  assert.equal(last.failedChunks, 1);
});

test("每次提取都写「最近一次提取」：成功/跳过/取消都要有原因", async () => {
  const success = makeRuntime();
  success.runtime.requestChapterTermExtraction = async () => ({
    ok: true, engine: "llm", candidates: [{ source: "김성현", kind: "person", score: 0.94 }],
    dropped: { unknownKind: 2 }, partial: { totalChunks: 1, failedChunks: 0, coveredBlockIds: ["b1", "b2"] }
  });
  await success.runtime.runTermDiscovery({ pageUrl: "u" });
  const stored = success.calls.stored.at(-1).mt_term_discovery_last_v1;
  assert.equal(stored.outcome, "added");
  assert.equal(stored.reason, "added");
  assert.equal(stored.returned, 1);

  const skipped = makeRuntime({ prepareDiscovery: async () => ({ skip: "throttled" }) });
  await skipped.runtime.runTermDiscovery({ pageUrl: "u" });
  assert.equal(skipped.calls.stored.at(-1).mt_term_discovery_last_v1.reason, "throttled");

  const disabled = makeRuntime({ termLlmConfig: () => ({ baseUrl: "" }) });
  await disabled.runtime.runTermDiscovery({ pageUrl: "u" });
  assert.equal(disabled.calls.stored.at(-1).mt_term_discovery_last_v1.reason, "disabled");
});

test("提取在途时队列满：新请求按 throttled 交回内容脚本，不并发压模型", async () => {
  const harness = makeRuntime();
  const pendingResolvers = [];
  let released = false;
  harness.runtime.requestChapterTermExtraction = () => new Promise(resolve => {
    const finish = () => resolve({ ok: true, engine: "llm", candidates: [] });
    if (released) finish();
    else pendingResolvers.push(finish);
  });
  const first = harness.runtime.runTermDiscovery({ pageUrl: "u" });   // 在途
  const second = harness.runtime.runTermDiscovery({ pageUrl: "u" });  // 排队
  await new Promise(resolve => setImmediate(resolve));
  const third = await harness.runtime.runTermDiscovery({ pageUrl: "u" });
  assert.equal(third.reason, "throttled", "队列满时交给内容脚本 30 秒后再来");
  assert.equal(third.skipped, true);
  assert.equal(pendingResolvers.length, 1, "同一时刻只有一个分段请求在跑");
  released = true;
  pendingResolvers.forEach(finish => finish());
  const results = await Promise.all([first, second]);
  assert.deepEqual(results.map(result => result.added), [1, 1], "在途与排队的那两趟照常完成");
});

test("probeTermExtractor 按「有没有配提取服务」给出在线/离线", async () => {
  const configured = makeRuntime();
  assert.equal((await configured.runtime.probeTermExtractor()).state, "online");
  assert.equal(configured.status().engine, "llm");
  const missing = makeRuntime({ termLlmConfig: () => ({ baseUrl: "" }) });
  assert.equal((await missing.runtime.probeTermExtractor()).state, "offline");
});

test("processedBlockIds 只标记给定的块（其余段落留着重跑）", () => {
  const { mergeDiscoveryResult } = termDiscoveryCore;
  const blocks = [{ id: "b1", originalText: "정다준이 말했다." }, { id: "b2", originalText: "하이파이브가 나왔다." }];
  const result = mergeDiscoveryResult({
    store: null,
    ignored: null,
    glossary: { version: 4, libraries: [], entries: [] },
    pageUrl: "https://example.com/c/1",
    pageTitle: "1화",
    targetKey: "novel-1:c1",
    blocks,
    processedBlockIds: ["b2"],
    extractedCandidates: [{ source: "하이파이브", kind: "group", score: 0.9 }]
  });
  assert.deepEqual(result.chapters[0].processedEvidenceIds, ["b2"],
    "只有跑出结果的分段覆盖的块才算已处理（b1 会留给下一次补跑）");
});
