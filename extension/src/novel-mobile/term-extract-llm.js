/**
 * 移动端整章术语提取（LLM 分支）：把 local-ocr-service/term_extractor.py 的 LLM 路径搬进后台
 * Service Worker，直接打用户配置的 OpenAI 兼容 LLM —— 桌面版是把整章原文 POST 给本地 Python
 * 服务的 /terms/extract。启发式分支（extract_candidate_sentences）不移植：移动端没有它，
 * upstream 缺失时按失败返回。
 *
 * 本文件只管「怎么发请求、怎么分段、怎么续跑、怎么合并」；提示词与输出校验在
 * term-extract-prompt.js（与 Python 逐条对齐），分段进度与块归属在 term-extract-progress.js。
 */
import {
  SYSTEM_MESSAGE, buildChunkPrompt, caseFold, inSourceText,
  normalizeText, resolveModel, sortCandidates, splitChunks, validateLlmOutput
} from "./term-extract-prompt.js";
import {
  blockIdsInChunk, clearChunkProgress, readChunkProgress, runKeyOf, writeChunkProgress
} from "./term-extract-progress.js";

export const TERM_EXTRACT_TIMEOUT_MS = 120000;

/**
 * 对齐 Python _llm_extract_chunk（单段请求 + 解析），异常原样抛给调用方。
 * response_format 是 Python/Ollama 请求体里没有的：沿用 term-context-extract.js 的仓库惯例，
 * 模型不支持 JSON 模式时（信封为空）去掉该字段重试一次。
 */
async function extractChunk(runtime, chunk, llm, targetLanguage, sourceText, stats = null) {
  const body = {
    model: resolveModel(llm.baseUrl, llm.model),
    temperature: 0,
    stream: false,
    messages: [
      { role: "system", content: SYSTEM_MESSAGE },
      { role: "user", content: buildChunkPrompt(chunk, targetLanguage) }
    ],
    // 思考字段由调用方从配置里算好带进来（见 term-discovery-extract.js 的 upstream）
    ...(llm.thinking || {}),
    response_format: { type: "json_object" }
  };
  const endpoint = runtime.buildOpenAICompatibleEndpoint(llm.baseUrl);
  // 思考参数 / json 模式被服务商拒了就按组剥掉重发（见 background/modules/translation-utils.js）
  const sent = await runtime.sendTranslationBodyWithFallbacks(
    endpoint, llm.apiKey, body, TERM_EXTRACT_TIMEOUT_MS, { includeResponseMeta: true }
  );
  const envelope = sent.envelope;
  const content = String(runtime.extractOpenAIMessageText(envelope && envelope.content) || "");
  return validateLlmOutput(runtime, content, sourceText, stats);
}

function errorText(runtime, error) {
  const formatted = runtime.getErrorMessage?.(error);
  return String(formatted || (error && error.message) || error || "").trim();
}

export function installTermExtractLlm(runtime) {
  /**
   * 请求体形状见 term-discovery-extract.js 的 discoveryRequestBody()。
   * requestBody.user_terms 只有桌面启发式分支在用，Python 的 LLM 路径完全不读它 ——
   * 这里同样忽略（保持 parity），别顺手塞进 prompt。
   */
  async function requestChapterTermExtraction(requestBody) {
    const body = requestBody || {};
    try {
      const upstream = body.upstream || {};
      const baseUrl = String(upstream.baseUrl || "").trim();
      if (!baseUrl) {
        return { ok: false, error: "未配置整章术语提取服务，请在设置页「翻译服务」中选择" };
      }
      const llm = {
        baseUrl,
        model: String(upstream.model || "").trim(),
        apiKey: String(upstream.apiKey || "").trim(),
        // 与桌面版同形：思考字段由扩展侧算好放在 upstream.thinking（见 term-discovery-extract.js）
        thinking: upstream.thinking && typeof upstream.thinking === "object" ? upstream.thinking : {}
      };
      const targetLanguage = String(body.target_language || "").trim() || "zh-CN";

      // 对齐 Python 的准备步骤：id 与 text 都要非空，text/translatedText 都过 normalize_text。
      const prepared = (Array.isArray(body.blocks) ? body.blocks : [])
        .map(block => ({
          id: String((block && block.id) || "").trim(),
          text: normalizeText(block && block.text),
          translatedText: normalizeText(block && block.translatedText)
        }))
        .filter(block => block.id && block.text);
      if (prepared.length === 0) return { ok: true, engine: "llm", candidates: [] };
      const fullText = prepared
        .map(block => (block.translatedText ? `${block.text}\n译文：${block.translatedText}` : block.text))
        .join("\n");
      // 校验基准只含原文：Python 正是把 source_text=original_text 单独传给每段请求的。
      const originalText = prepared.map(block => block.text).join("\n");
      if (!fullText.trim()) return { ok: true, engine: "llm", candidates: [] };

      const stats = {};
      const chunks = splitChunks(fullText);
      const chunkBlockIds = chunks.map(chunk => blockIdsInChunk(chunk, prepared));
      // 上次跑到一半的进度（service worker 被回收 / 页面被切走）在这里续上：已完成的段不重发。
      const runKey = runKeyOf(runtime, fullText);
      const progress = await readChunkProgress(runtime, runKey);
      let succeeded = 0;
      let failedChunks = 0;
      let timedOutChunks = 0;
      let failure = null;
      for (let index = 0; index < chunks.length; index += 1) {
        if (progress.has(index)) {
          succeeded += 1;
          continue;
        }
        // 单段失败不拖垮整章：这一段的异常只记下来，继续跑后面的段。
        // （Python 会直接向外抛，移动端保留逐段容错，但失败段覆盖的块**不算已处理**，
        //   见 background-local.js —— 那才是「漏术语」的根源。）
        try {
          const chunkCandidates = await extractChunk(runtime, chunks[index], llm, targetLanguage, originalText, stats);
          progress.set(index, chunkCandidates);
          succeeded += 1;
          await writeChunkProgress(runtime, runKey, progress);
        } catch (error) {
          failure = error;
          failedChunks += 1;
          if (error && error.timeout === true) timedOutChunks += 1;
        }
      }
      if (succeeded === 0) {
        await clearChunkProgress(runtime, runKey);
        return {
          ok: false,
          error: errorText(runtime, failure) || "LLM 术语提取失败",
          timedOut: Boolean(failure && failure.timeout === true)
        };
      }
      // 合并顺序严格按分段序号（先出现的条目为准），与 Python 的逐段合并一致。
      const merged = new Map();
      for (let index = 0; index < chunks.length; index += 1) {
        for (const candidate of progress.get(index) || []) {
          const key = caseFold(candidate.source);
          const current = merged.get(key);
          if (!current) {
            merged.set(key, candidate);
            continue;
          }
          for (const field of ["note", "suggestedTarget"]) {
            if (!current[field] && candidate[field]) {
              current[field] = candidate[field];
            }
          }
          current.score = Math.max(current.score, candidate.score);
        }
      }
      const candidates = [...merged.values()].map(candidate => ({
        ...candidate,
        // 证据块按原文（原始 text，不是「译文：」拼接文本）判定，同 _in_source_text 规则。
        evidenceIds: prepared
          .filter(block => inSourceText(block.text, candidate.source))
          .map(block => block.id)
      }));
      // 真的跑出结果的那些分段覆盖了哪些块 —— 只有这些才允许被记成「已处理」。
      const coveredBlockIds = [...new Set([...progress.keys()].flatMap(index => chunkBlockIds[index] || []))];
      if (failedChunks === 0) {
        await clearChunkProgress(runtime, runKey);
      }
      return {
        ok: true,
        engine: "llm",
        candidates: sortCandidates(candidates),
        dropped: stats,
        partial: {
          totalChunks: chunks.length,
          failedChunks,
          timedOutChunks,
          coveredBlockIds
        }
      };
    } catch (error) {
      return { ok: false, error: errorText(runtime, error) };
    }
  }
  runtime.requestChapterTermExtraction = requestChapterTermExtraction;
}
