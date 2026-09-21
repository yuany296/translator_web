import assert from "node:assert/strict";
import test from "node:test";

import {
  createTranslationRowExtractor, createSseEventReader, readOpenAiChunkText, decodeJsonString
} from "../extension/src/shared/translation-row-stream.js";
import { installTranslationProviderStream } from "../extension/src/background/modules/translation-provider-stream.js";

/** 把一段 SSE 文本切成任意大小的分片喂进去，模拟网络分片。 */
function feedInChunks(reader, text, size) {
  const payloads = [];
  for (let index = 0; index < text.length; index += size) {
    payloads.push(...reader.push(text.slice(index, index + size)));
  }
  return payloads;
}

function sseBody(rows) {
  return rows.map(row => `data: ${JSON.stringify({ choices: [{ delta: { content: row } }] })}\n\n`).join("")
    + "data: [DONE]\n\n";
}

function jsonStreamResponse(text) {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    body: new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      }
    })
  };
}

// ---- 增量行提取 ----

test("译文行只在完整闭合后返回，残缺尾行不猜", () => {
  const extractor = createTranslationRowExtractor();
  assert.deepEqual(extractor.push('{"translations":[{"id":"t0","translated_text":"안'), []);
  assert.deepEqual(extractor.push('{"translations":[{"id":"t0","translated_text":"你好"'), []);
  // 行对象自身闭合即可用（不必等外层 ] }），此后不再重复返回
  assert.deepEqual(extractor.push('{"translations":[{"id":"t0","translated_text":"你好"}'), [{ id: "t0", translated_text: "你好" }]);
  assert.deepEqual(extractor.push('{"translations":[{"id":"t0","translated_text":"你好"}]}'), []);
});

test("逐行返回且不重复；键序颠倒也认；转义正确还原", () => {
  const extractor = createTranslationRowExtractor();
  const first = extractor.push('{"translations":[{"id":"t0","translated_text":"第一行"},');
  assert.deepEqual(first, [{ id: "t0", translated_text: "第一行" }]);
  const second = extractor.push('{"translations":[{"id":"t0","translated_text":"第一行"},{"translated_text":"带\\"引号\\"的行","id":"t1"},');
  assert.deepEqual(second, [{ id: "t1", translated_text: '带"引号"的行' }]);
  assert.deepEqual(extractor.push('{"translations":[{"id":"t0","translated_text":"第一行"},{"translated_text":"带\\"引号\\"的行","id":"t1"},{"id":"t2","translated_text":"第三行"}]}'),
    [{ id: "t2", translated_text: "第三行" }]);
});

test("缺右花括号的残行不会被下一行开头误配", () => {
  const extractor = createTranslationRowExtractor();
  const rows = extractor.push('{"id":"t0","translated_text":"abc ,"id":"t1","translated_text":"x"}');
  assert.deepEqual(rows, [{ id: "t1", translated_text: "x" }], "t0 的残行不产生任何行");
});

test("decodeJsonString 还原转义并在非法输入时退回原样", () => {
  assert.equal(decodeJsonString("a\\nb"), "a\nb");
  assert.equal(decodeJsonString("bad\\"), "bad\\");
});

// ---- SSE 事件切分 ----

test("SSE 事件跨网络分片也能拼回完整负载", () => {
  const reader = createSseEventReader();
  const body = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n';
  const payloads = feedInChunks(reader, body, 7);
  assert.deepEqual(payloads, ['{"a":1}', '{"b":2}', "[DONE]"]);
});

test("readOpenAiChunkText 取 delta.content 并兼容 message.content", () => {
  assert.equal(readOpenAiChunkText({ choices: [{ delta: { content: "x" } }] }), "x");
  assert.equal(readOpenAiChunkText({ choices: [{ message: { content: "y" } }] }), "y");
  assert.equal(readOpenAiChunkText({ choices: [{ delta: {} }] }), "");
  assert.equal(readOpenAiChunkText(null), "");
});

// ---- 背景流式请求 ----

function makeRuntime() {
  const runtime = {
    TRANSLATION_REQUEST_TIMEOUT_MS: 30_000,
    getErrorMessage: error => String(error && error.message || error),
    toProviderError: (payload, status, statusText) => new Error(payload?.error?.message || `${status} ${statusText}`),
    shouldRetryWithoutJsonResponseFormat: reason => /response_format/u.test(String(reason)),
    extractOpenAIMessageText: payload => String(payload?.choices?.[0]?.message?.content || ""),
    parseModelJson: text => JSON.parse(text),
    isAbortError: error => !!(error && error.name === "AbortError")
  };
  installTranslationProviderStream(runtime);
  return runtime;
}

test("流式请求：边收边抛行，最后返回整批结果", async () => {
  const runtime = makeRuntime();
  const streamed = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => jsonStreamResponse(sseBody([
    '{"translations":[{"id":"canonical-request-0","translated_text":"甲"},',
    '{"id":"canonical-request-1","translated_text":"乙"}]}'
  ]));
  try {
    const rows = await runtime.streamCanonicalTranslationBatch({
      endpoint: "https://example.com/v1/chat/completions", apiKey: "k",
      body: { model: "m", response_format: { type: "json_object" } },
      onRow: partial => streamed.push(...partial)
    });
    assert.deepEqual(streamed, [
      { id: "canonical-request-0", translated_text: "甲" },
      { id: "canonical-request-1", translated_text: "乙" }
    ], "每一行都在整批结束前就交给渲染层");
    assert.deepEqual(rows.map(row => row.id), ["canonical-request-0", "canonical-request-1"]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("服务端忽略 stream 返回普通 JSON 时，就地解析而不是再发一次请求", async () => {
  const runtime = makeRuntime();
  let calls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => {
    calls += 1;
    return jsonStreamResponse(JSON.stringify({
      choices: [{ message: { content: '{"translations":[{"id":"t0","translated_text":"甲"}]}' } }]
    }));
  };
  try {
    const rows = await runtime.streamCanonicalTranslationBatch({
      endpoint: "https://example.com", apiKey: "k", body: { model: "m" }
    });
    assert.equal(calls, 1);
    assert.deepEqual(rows, [{ id: "t0", translated_text: "甲" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("response_format 兼容性 4xx 返回 null，交给非流式回退", async () => {
  const runtime = makeRuntime();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 400, statusText: "Bad Request",
    json: async () => ({ error: { message: "response_format is not supported" } })
  });
  try {
    const rows = await runtime.streamCanonicalTranslationBatch({
      endpoint: "https://example.com", apiKey: "k",
      body: { model: "m", response_format: { type: "json_object" } }
    });
    assert.equal(rows, null);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("中途断流但已拿到部分行时返回已拿到的行（缺项交给逐项补翻）", async () => {
  const runtime = makeRuntime();
  const originalFetch = globalThis.fetch;
  let sent = false;
  globalThis.fetch = async () => ({
    ok: true, status: 200, statusText: "OK",
    body: new ReadableStream({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content: '{"translations":[{"id":"t0","translated_text":"甲"},' } }] })}\n\n`
          ));
          return;
        }
        // 第一块被读走之后才断：部分译文必须还能用
        controller.error(new Error("network reset"));
      }
    })
  });
  try {
    const rows = await runtime.streamCanonicalTranslationBatch({
      endpoint: "https://example.com", apiKey: "k", body: { model: "m" }
    });
    assert.deepEqual(rows, [{ id: "t0", translated_text: "甲" }]);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("真正的失败（无部分结果）仍然抛错，让失败原因可见", async () => {
  const runtime = makeRuntime();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: false, status: 401, statusText: "Unauthorized",
    json: async () => ({ error: { message: "invalid api key" } })
  });
  try {
    await assert.rejects(
      runtime.streamCanonicalTranslationBatch({ endpoint: "https://example.com", apiKey: "bad", body: { model: "m" } }),
      /invalid api key/u
    );
  } finally {
    globalThis.fetch = originalFetch;
  }
});
