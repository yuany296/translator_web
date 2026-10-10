import assert from "node:assert/strict";
import test from "node:test";
import { installTranslationProviderStream } from "../extension/src/background/modules/translation-provider-stream.js";
import { installTranslationDiagnostics } from "../extension/src/background/modules/translation-diagnostics.js";
import { createTranslationRowExtractor } from "../extension/src/shared/translation-row-stream.js";

function makeRuntime() {
  const runtime = {
    TRANSLATION_REQUEST_TIMEOUT_MS: 5000,
    DEFAULT_TRANSLATION_BASE_URL: "https://api.example.test/v1",
    DEFAULT_TRANSLATION_MODEL: "model-a",
    isAbortError: error => Boolean(error && error.name === "AbortError"),
    getErrorMessage: error => String(error && error.message || error),
    toProviderError: (payload, status, statusText) => new Error(`${status} ${statusText}`),
    shouldRetryWithoutJsonResponseFormat: () => false,
    shouldRetryWithoutThinkingFields: () => false,
    parseModelJson: text => JSON.parse(text),
    extractOpenAIMessageText: content => (typeof content === "string" ? content : "")
  };
  installTranslationDiagnostics(runtime);
  installTranslationProviderStream(runtime);
  return runtime;
}

function streamResponse(chunks) {
  let index = 0;
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: {
      getReader: () => ({
        read: async () => (index < chunks.length
          ? { done: false, value: encoder.encode(chunks[index++]) }
          : { done: true, value: undefined })
      })
    }
  };
}

function sse(payload) {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

function delta(content, finishReason = null) {
  return sse({ choices: [{ delta: { content }, finish_reason: finishReason }] });
}

test("完整流式响应会留档：原文、行数、finish_reason", async () => {
  const runtime = makeRuntime();
  const body = '{"translations":[{"id":"canonical-request-0","translated_text":"听说游乐设施指南里包含这个主题公园的相关内容。"}]}';
  globalThis.fetch = async () => streamResponse([
    delta(body.slice(0, 30)),
    delta(body.slice(30)),
    delta("", "stop"),
    "data: [DONE]\n\n"
  ]);

  const rows = await runtime.streamCanonicalTranslationBatch({
    endpoint: "https://api.example.test/v1/chat/completions",
    apiKey: "k",
    body: { model: "model-a" }
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].translated_text, "听说游乐设施指南里包含这个主题公园的相关内容。");
  const [snapshot] = runtime.listTranslationSnapshots();
  assert.equal(snapshot.kind, "stream");
  assert.equal(snapshot.streamed, true);
  assert.equal(snapshot.finishReason, "stop");
  assert.equal(snapshot.returnedRows, 1);
  assert.equal(snapshot.parsedOk, true);
  assert.equal(snapshot.outcome, "parsed");
  assert.equal(snapshot.model, "model-a");
  assert.equal(snapshot.endpointHost, "api.example.test");
  assert.match(snapshot.text, /听说游乐设施指南/u);
  assert.ok(snapshot.durationMs >= 0);
});

test("流式响应被截断到 finish_reason=length 时快照能看出来", async () => {
  const runtime = makeRuntime();
  globalThis.fetch = async () => streamResponse([
    delta('{"translations":[{"id":"canonical-request-0","translated_text":"游乐设施'),
    delta("", "length"),
    "data: [DONE]\n\n"
  ]);

  const rows = await runtime.streamCanonicalTranslationBatch({
    endpoint: "https://api.example.test/v1/chat/completions",
    body: { model: "model-a" }
  });

  // 未闭合的那一行不允许被当成完整行吐出来（事故的直接成因）
  assert.deepEqual(rows, []);
  const [snapshot] = runtime.listTranslationSnapshots();
  assert.equal(snapshot.finishReason, "length");
  assert.equal(snapshot.outcome, "empty-parse");
  assert.equal(snapshot.partialRows, 0);
});

test("未闭合残行不会被提取，只有闭合成对的行才会产出", () => {
  const extractor = createTranslationRowExtractor();
  const open = '{"translations":[{"id":"canonical-request-0","translated_text":"游乐设施';
  assert.deepEqual(extractor.push(open), []);
  assert.deepEqual(extractor.push(`${open}"}`), [{ id: "canonical-request-0", translated_text: "游乐设施" }]);
});

test("A/B 对照：流式比整批短的行会被记为可疑", async () => {
  const runtime = makeRuntime();
  runtime.loadSettings = async () => ({ apiKey: "k", baseUrl: "https://api.example.test/v1", model: "model-a" });
  runtime.requestOpenAICompatibleCanonicalTranslationBatch = async ({ items, onRow }) => {
    const full = items.map(item => ({ id: item.id, translated_text: "听说游乐设施指南里包含这个主题公园的相关内容。" }));
    if (typeof onRow === "function") {
      onRow(full);
      // 模拟截尾：流式分支只回前四个字
      return full.map(row => ({ ...row, translated_text: row.translated_text.slice(0, 4) }));
    }
    return full;
  };

  const report = await runtime.compareStreamAgainstBatch({ repeat: 2, items: ["어트랙션 안내에는 이 테마파크 관련 내용이 담겨 있다고 하더군요."] });

  assert.equal(report.verdict, "insufficient-evidence");
  assert.equal(report.rounds, 2);
  assert.equal(report.shrankRows, 2);
  assert.equal(report.identicalRounds, 0);
  assert.equal(report.missingRows, 0);
  assert.match(report.samples[0].differences[0].streamed, /^听说游乐/u);
});

test("A/B 对照：逐行一致且样本足量时才判定流式可用", async () => {
  const runtime = makeRuntime();
  runtime.loadSettings = async () => ({ apiKey: "k", baseUrl: "https://api.example.test/v1", model: "model-a" });
  runtime.requestOpenAICompatibleCanonicalTranslationBatch = async ({ items, onRow }) => {
    const rows = items.map(item => ({ id: item.id, translated_text: `译文-${item.id}` }));
    if (typeof onRow === "function") onRow(rows);
    return rows;
  };

  const report = await runtime.compareStreamAgainstBatch({ repeat: 20, items: ["하나", "둘"] });

  assert.equal(report.verdict, "streaming-usable");
  assert.equal(report.identicalRounds, 20);
  assert.equal(report.shrankRows, 0);
  assert.equal(report.missingRows, 0);
});

test("快照环形缓冲只保留最近 20 条", () => {
  const runtime = makeRuntime();
  for (let index = 0; index < 25; index += 1) runtime.recordTranslationSnapshot({ at: index, kind: "batch" });

  const list = runtime.listTranslationSnapshots();

  assert.equal(list.length, 20);
  assert.equal(list[0].at, 5);
  runtime.resetTranslationSnapshots();
  assert.equal(runtime.listTranslationSnapshots().length, 0);
});
