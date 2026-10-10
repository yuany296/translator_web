import assert from "node:assert/strict";
import test from "node:test";
import { installTermExtractLlm } from "../extension/src/novel-mobile/term-extract-llm.js";
import { createMemoryProgressStore } from "../extension/src/novel-mobile/term-extract-progress.js";
import { installTranslationUtils } from "../extension/src/background/modules/translation-utils.js";

// 术语提取移植测试：对齐 local-ocr-service/term_extractor.py 的 LLM 分支。
// 只桩住「网络那一步」，解析 / 校验 / 合并 / 证据块全部走真实实现。
// 分段进度用一个每个 runtime 独享的存储桩：既隔离测试，又能验证断点续跑。
function makeRuntime(replies, options = {}) {
  const requests = [];
  // 「可选字段被拒就剥掉重发」必须是产品代码：先把真实的回落助手装上，
  // 再用下面的桩覆盖网络那一步（Object.assign 在 install 之后，桩说了算）。
  const runtime = {};
  installTranslationUtils(runtime);
  Object.assign(runtime, {
    buildOpenAICompatibleEndpoint: base => `${String(base).replace(/\/+$/u, "")}/chat/completions`,
    sendOpenAICompatibleTranslationRequest: async (endpoint, apiKey, body) => {
      requests.push({ endpoint, apiKey, body });
      const reply = replies.shift();
      if (reply instanceof Error) throw reply;
      return { content: reply };
    },
    extractOpenAIMessageText: content => String(content || ""),
    parseModelJson: content => {
      try {
        return JSON.parse(content);
      } catch {
        return null;
      }
    },
    getErrorMessage: error => String(error && error.message || error || ""),
    termExtractProgressStore: options.progressStore || createMemoryProgressStore()
  });
  installTermExtractLlm(runtime);
  return { runtime, requests };
}

function requestBody(blocks, upstream = { baseUrl: "https://api.example.com/v1", model: "m", apiKey: "k" }) {
  return {
    mode: "balanced",
    blocks,
    user_terms: ["这个字段只有桌面启发式分支在用"],
    upstream,
    target_language: "zh-CN"
  };
}

function userPrompt(request) {
  return request.body.messages.find(message => message.role === "user").content;
}

function chunkOf(request) {
  const marker = "源文本：\n";
  const content = userPrompt(request);
  return content.slice(content.indexOf(marker) + marker.length);
}

test("请求体与 Python 对齐：系统提示、端点、参考译文行", async () => {
  const { runtime, requests } = makeRuntime(['[{"source":"김성현이","kind":"person","suggestedTarget":"金成贤"}]']);
  const result = await runtime.requestChapterTermExtraction(requestBody([
    { id: "b1", text: "김성현이 말했다.", translatedText: "金成贤说道。" }
  ]));
  assert.equal(result.ok, true);
  assert.equal(result.engine, "llm");
  assert.equal(requests.length, 1);
  const request = requests[0];
  assert.equal(request.endpoint, "https://api.example.com/v1/chat/completions");
  assert.equal(request.body.model, "m");
  assert.equal(request.body.temperature, 0);
  assert.equal(request.body.stream, false);
  assert.equal(request.body.messages[0].content, "You are a web-novel terminology extractor. Return strict JSON only.");
  const prompt = userPrompt(request);
  assert.ok(prompt.includes("김성현이 말했다.\n译文：金成贤说道。"));
  assert.ok(prompt.includes("只输出 JSON 数组本身"));
  assert.equal(prompt.includes("这个字段只有桌面启发式分支在用"), false, "user_terms 不参与 LLM 路径");
});

test("模型为空：本机地址才退到 Ollama 默认名，云端地址直接报错说清原因", async () => {
  // 以前不填 model 会拿 "qwen2.5:7b" 去打云端接口 → 提取静默失败，而翻译照常。
  const remote = makeRuntime(["[]"]);
  const remoteResult = await remote.runtime.requestChapterTermExtraction(requestBody(
    [{ id: "b1", text: "김성현이 말했다." }], { baseUrl: "https://api.example.com/v1", model: "", apiKey: "k" }
  ));
  assert.equal(remoteResult.ok, false);
  assert.match(remoteResult.error, /未配置术语提取模型/u);
  assert.equal(remote.requests.length, 0, "别拿一个不存在的模型名去打云端");

  const local = makeRuntime(["[]"]);
  await local.runtime.requestChapterTermExtraction(requestBody(
    [{ id: "b1", text: "김성현이 말했다." }], { baseUrl: "http://127.0.0.1:11434/v1", model: "", apiKey: "" }
  ));
  assert.equal(local.requests[0].body.model, "qwen2.5:7b", "本机 Ollama 才用默认名");
});

test("校验：越界 kind、只出现在译文里的词、字段填反、重复项的处理", async () => {
  const reply = JSON.stringify([
    { source: "김성현이", kind: "person", note: "主角", suggestedTarget: "金成贤" },
    { source: "莉娜", kind: "person" },
    { source: "말했다", kind: "verb" },
    { source: "金成贤", kind: "location", suggestedTarget: "김성현" },
    { source: "김성현이", kind: "person" }
  ]);
  const { runtime } = makeRuntime([reply]);
  const result = await runtime.requestChapterTermExtraction(requestBody([
    { id: "b1", text: "김성현이 말했다.", translatedText: "金成贤说道。莉娜也在。" }
  ]));
  assert.equal(result.ok, true);
  assert.deepEqual(result.candidates.map(candidate => candidate.source), ["김성현이", "김성현"]);
  assert.deepEqual(result.candidates.map(candidate => candidate.kind), ["person", "location"]);
  assert.deepEqual(result.candidates[0].evidenceIds, ["b1"]);
  assert.equal(result.candidates[0].score, 0.94);
  assert.equal(result.candidates[0].suggestedTarget, "金成贤");
  // 填反的那条被交换回来：source 用原文、suggestedTarget 用译文
  assert.equal(result.candidates[1].suggestedTarget, "金成贤");
  assert.equal(result.candidates[1].score, 0.88);
});

test("模型套 Markdown 代码块或夹杂解释文字都能解析", async () => {
  const fenced = makeRuntime(["```json\n[{\"source\":\"김성현이\",\"kind\":\"person\"}]\n```"]);
  const fencedResult = await fenced.runtime.requestChapterTermExtraction(requestBody([
    { id: "b1", text: "김성현이 말했다." }
  ]));
  assert.deepEqual(fencedResult.candidates.map(candidate => candidate.source), ["김성현이"]);

  const chatty = makeRuntime(["好的，结果如下：[{\"source\":\"김성현이\",\"kind\":\"person\"}] 希望有帮助"]);
  const chattyResult = await chatty.runtime.requestChapterTermExtraction(requestBody([
    { id: "b1", text: "김성현이 말했다." }
  ]));
  assert.deepEqual(chattyResult.candidates.map(candidate => candidate.source), ["김성현이"]);
});

test("证据块只认原文：译文里出现不算", async () => {
  const reply = JSON.stringify([{ source: "김성현", kind: "person" }]);
  const { runtime } = makeRuntime([reply]);
  const result = await runtime.requestChapterTermExtraction(requestBody([
    { id: "b1", text: "김성현이 말했다." },
    { id: "b2", text: "다른 문단입니다.", translatedText: "김성현" }
  ]));
  assert.deepEqual(result.candidates[0].evidenceIds, ["b1"]);
});

test("长文本按 3000 字 / 200 字重叠分块", async () => {
  const { runtime, requests } = makeRuntime(["[]", "[]"]);
  const result = await runtime.requestChapterTermExtraction(requestBody([
    { id: "b1", text: "가".repeat(2000) },
    { id: "b2", text: "나".repeat(2000) }
  ]));
  assert.equal(result.ok, true);
  assert.equal(requests.length, 2);
  const first = chunkOf(requests[0]);
  const second = chunkOf(requests[1]);
  assert.equal(first.length, 3000);
  assert.equal(second.startsWith(first.slice(2800)), true, "第二块要与第一块重叠 200 字");
});

test("单块失败不拖垮整章；每块都失败才报错", async () => {
  // 术语落在第一块里，但校验基准是整章原文：第二块返回它也算数（与 Python 一致）。
  const longBlocks = [
    { id: "b1", text: `김성현이${"가".repeat(1994)}` },
    { id: "b2", text: "나".repeat(2000) }
  ];
  const partial = makeRuntime([
    new Error("第一块超时"),
    '[{"source":"김성현이","kind":"person"}]'
  ]);
  const partialResult = await partial.runtime.requestChapterTermExtraction(requestBody(longBlocks));
  assert.equal(partialResult.ok, true);
  assert.deepEqual(partialResult.candidates.map(candidate => candidate.source), ["김성현이"]);
  assert.deepEqual(partialResult.candidates[0].evidenceIds, ["b1"]);

  const allFailed = makeRuntime([new Error("超时"), new Error("超时")]);
  const failedResult = await allFailed.runtime.requestChapterTermExtraction(requestBody(longBlocks));
  assert.equal(failedResult.ok, false);
  assert.match(failedResult.error, /超时/u);
});

test("部分失败要交代清楚：失败段数 + 只有成功段覆盖的块才算已处理", async () => {
  // 真机症状：待确认里有术语，但比电脑少、老漏。根因是分段失败被当成成功，
  // 整屏都被标记「已处理」，失败段里的术语再也不会被重新提取。
  const blocks = [
    { id: "b1", text: `김성현이${"가".repeat(1994)}` },   // 第一块
    { id: "b2", text: `${"나".repeat(1990)}하이파이브` }  // 第二块
  ];
  const failure = new Error("第一块超时");
  failure.timeout = true;
  const { runtime } = makeRuntime([failure, '[{"source":"하이파이브","kind":"group"}]']);
  const result = await runtime.requestChapterTermExtraction(requestBody(blocks));
  assert.equal(result.ok, true);
  assert.deepEqual(result.partial, {
    totalChunks: 2,
    failedChunks: 1,
    timedOutChunks: 1,
    coveredBlockIds: ["b2"]
  }, "只把真的跑出结果的分段覆盖的块报上去");
  assert.deepEqual(result.candidates.map(candidate => candidate.source), ["하이파이브"]);
});

test("跑到一半被回收：下次进入跳过已完成的段，只补跑剩下的", async () => {
  const blocks = [
    { id: "b1", text: `김성현이${"가".repeat(1994)}` },
    { id: "b2", text: `${"나".repeat(1990)}하이파이브` }
  ];
  // 第一趟：第一段成功、第二段失败（模拟 service worker 被回收/超时）
  const first = makeRuntime([
    '[{"source":"김성현이","kind":"person"}]',
    new Error("第二段超时")
  ]);
  const firstResult = await first.runtime.requestChapterTermExtraction(requestBody(blocks));
  assert.equal(firstResult.partial.failedChunks, 1);
  assert.deepEqual(firstResult.candidates.map(candidate => candidate.source), ["김성현이"]);

  // 第二趟：同一批块、共享同一份分段进度 —— 第一段不该再请求一次，只补第二段
  const second = makeRuntime(['[{"source":"하이파이브","kind":"group"}]'], {
    progressStore: first.runtime.termExtractProgressStore
  });
  const secondResult = await second.runtime.requestChapterTermExtraction(requestBody(blocks));
  assert.equal(second.requests.length, 1, "已完成的段不再重复请求");
  assert.equal(chunkOf(second.requests[0]).includes("하이파이브"), true, "补跑的是失败的那一段");
  assert.equal(secondResult.partial.failedChunks, 0);
  assert.deepEqual(secondResult.candidates.map(candidate => candidate.source).sort(), ["김성현이", "하이파이브"],
    "续跑结果与整趟跑完一致");
  assert.deepEqual(secondResult.partial.coveredBlockIds.sort(), ["b1", "b2"]);
});

test("模型不照抄字段名 / 英文 kind 也能用（中文 kind、target、译名等别名）", async () => {
  const replies = [
    JSON.stringify([{ 原文: "김성현이", 类型: "人名", 译名: "金成贤", 备注: "主角" }]),
    JSON.stringify([{ source: "김성현이", kind: "person", target: "金成贤" }]),
    JSON.stringify([{ source: "김성현이", kind: "proper_noun" }])
  ];
  const { runtime } = makeRuntime(replies);
  const blocks = [{ id: "b1", text: "김성현이 말했다.", translatedText: "金成贤说道。" }];
  const chinese = await runtime.requestChapterTermExtraction(requestBody(blocks));
  assert.deepEqual(chinese.candidates.map(candidate => candidate.source), ["김성현이"]);
  assert.equal(chinese.candidates[0].kind, "person", "中文 kind 要归一成 person，不能整条丢掉");
  assert.equal(chinese.candidates[0].suggestedTarget, "金成贤", "中文「译名」要当成 suggestedTarget");
  const targetAlias = await runtime.requestChapterTermExtraction(requestBody(blocks));
  assert.equal(targetAlias.candidates[0].suggestedTarget, "金成贤",
    "target 要当成 suggestedTarget：否则译名为空，确认术语时会被 filter(source && target) 丢掉");
  const proper = await runtime.requestChapterTermExtraction(requestBody(blocks));
  assert.equal(proper.candidates[0].kind, "proper_noun");
});

test("该丢的仍然丢：动词、普通名词这类词性不进候选", async () => {
  const reply = JSON.stringify([
    { source: "김성현이", kind: "person" },
    { source: "말했다", kind: "verb" },
    { source: "말했다", kind: "动词" },
    { source: "말했다", kind: "普通名词" },
    { source: "말했다", kind: "common_noun" }
  ]);
  const { runtime } = makeRuntime([reply]);
  const result = await runtime.requestChapterTermExtraction(requestBody([
    { id: "b1", text: "김성현이 말했다." }
  ]));
  assert.deepEqual(result.candidates.map(candidate => candidate.source), ["김성현이"]);
  assert.equal(result.dropped.invalidKind, 4, "丢了几条要能被看到（写进「最近一次提取」）");
});

test("完全不认识的 kind 归一成 proper_noun 保留，并计数（不再静默丢术语）", async () => {
  // 云模型经常自造 kind（英文标签、游戏系统词等）：以前这些条目整条消失，
  // 用户看到的就是「术语老漏」。现在保留为 proper_noun，让用户自己忽略。
  const reply = JSON.stringify([
    { source: "김성현이", kind: "character" },
    { source: "하이파이브", kind: "系统道具" },
    { source: "없는사람", kind: "character" }
  ]);
  const { runtime } = makeRuntime([reply]);
  const result = await runtime.requestChapterTermExtraction(requestBody([
    { id: "b1", text: "김성현이 하이파이브를 소개했다." }
  ]));
  assert.deepEqual(result.candidates.map(candidate => candidate.source).sort(), ["김성현이", "하이파이브"],
    "自造 kind 的两条都保留（排序按得分/长度，这里只比集合）");
  assert.deepEqual(result.candidates.map(candidate => candidate.kind), ["proper_noun", "proper_noun"]);
  assert.equal(result.candidates[0].score, 0.85);
  assert.equal(result.dropped.unknownKind, 3, "自造 kind 的条数要能对上（含原文里没有的那条）");
  assert.equal(result.dropped.notInSource, 1);
});

test("提示词明确要求英文字段名、七个英文 kind，并且译名不许留空", async () => {
  const { runtime, requests } = makeRuntime(["[]"]);
  await runtime.requestChapterTermExtraction(requestBody([{ id: "b1", text: "김성현이 말했다." }]));
  const prompt = userPrompt(requests[0]);
  assert.ok(prompt.includes("字段名必须是这四个英文名"), "要挡住模型把字段名写成中文");
  assert.ok(prompt.includes("kind 只能填这七个英文单词之一"), "要挡住 kind 写成「人名」");
  assert.ok(prompt.includes("不要留空，也不要把原文照抄一遍"), "译名留空会导致候选加不进去");
});

test("没配提取服务时给出可操作的提示，且不发请求", async () => {
  const { runtime, requests } = makeRuntime(["[]"]);
  const result = await runtime.requestChapterTermExtraction(requestBody(
    [{ id: "b1", text: "김성현이 말했다." }], { baseUrl: "", model: "", apiKey: "" }
  ));
  assert.equal(result.ok, false);
  assert.match(result.error, /未配置整章术语提取服务/u);
  assert.equal(requests.length, 0);
});

test("空块直接返回空候选，不打模型", async () => {
  const { runtime, requests } = makeRuntime(["[]"]);
  const result = await runtime.requestChapterTermExtraction(requestBody([
    { id: "", text: "没有 id" },
    { id: "b2", text: "   " }
  ]));
  assert.deepEqual(result, { ok: true, engine: "llm", candidates: [] });
  assert.equal(requests.length, 0);
});

test("模型不支持 JSON 模式时去掉 response_format 重试一次", async () => {
  const { runtime, requests } = makeRuntime([null, '[{"source":"김성현이","kind":"person"}]']);
  const result = await runtime.requestChapterTermExtraction(requestBody([
    { id: "b1", text: "김성현이 말했다." }
  ]));
  assert.equal(result.ok, true);
  assert.equal(requests.length, 2);
  assert.deepEqual(requests[0].body.response_format, { type: "json_object" });
  assert.equal(requests[1].body.response_format, undefined);
});

test("整章提取照抄配置里的思考字段：翻译关掉思考，提取也一起关掉", async () => {
  const { runtime, requests } = makeRuntime(['[]']);
  await runtime.requestChapterTermExtraction(requestBody(
    [{ id: "b1", text: "김성현이 말했다." }],
    {
      baseUrl: "https://relay.test/v1", model: "m", apiKey: "k",
      thinking: { thinking: { type: "disabled" }, enable_thinking: false }
    }
  ));
  // 扩展侧算好的字段原样进请求体（本地服务/手机都不自己判断参数名）
  assert.deepEqual(requests[0].body.thinking, { type: "disabled" });
  assert.equal(requests[0].body.enable_thinking, false);
  // auto（不干预）时一个字段都不发
  const plain = makeRuntime(['[]']);
  await plain.runtime.requestChapterTermExtraction(requestBody([{ id: "b1", text: "김성현이 말했다." }]));
  assert.equal("thinking" in plain.requests[0].body, false);
  assert.equal("enable_thinking" in plain.requests[0].body, false);
});
