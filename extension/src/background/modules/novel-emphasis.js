import llmProviders from "../../shared/llm-providers.js";
import thinkingMode from "../../shared/thinking-mode.js";

/**
 * 「让模型排版」:把原文的强调片段对到译文上。
 *
 * 版式复刻的难点只有一个 —— 原文哪几个字是加粗/灰色，译文里对应的又是哪几个字。
 * 按字符占比近似映射能保住观感，但边界会落在句子里随便一个位置；这件事只有模型做得了，
 * 所以这里单独跑一次**排版对齐**小请求:
 *   - 只对「含行内格式」的段落发(真机一整屏 137 段里通常只有个位数)；
 *   - 输入是带 ⟦⟧ 标记的原文 + 已经翻好的译文，输出是加回标记的同一段译文；
 *   - 译文一个字都不许动，动过就整条丢弃(内容侧会退回比例映射)；
 *   - 独立于译文缓存:已翻好的章节不用重译也能把版式修对，也不会污染译文库。
 *
 * 模型配置沿用翻译服务(同一家、同一个模型)，结果按 (提示词版本 + 输入 + 模型) 缓存。
 */
const PROMPT_VERSION = "novel-emphasis-v1";
const CACHE_PREFIX = "mt_cache_v23:novel-emphasis:";
const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ITEMS = 40;
const MAX_SOURCE_CHARS = 4000;
const OPEN = "⟦";
const CLOSE = "⟧";

const SYSTEM_PROMPT = [
  "You are a formatting aligner for an already translated web novel.",
  "You never translate, rewrite, shorten or reorder text. Return strict JSON only."
].join(" ");

const MARK_RULES = [
  `In the source, every styled span is wrapped in ${OPEN} and ${CLOSE}.`,
  `Put those same marks around the span of the translation that renders the same words,`,
  `so that the marked span in your output covers exactly what the marked source span covers.`,
  "Keep the number of marked spans identical and in the same order.",
  "Everything outside the marks, including punctuation and spaces, must stay character-for-character what it was.",
  "If you cannot tell where a marked source span lands in the translation, return the translation unmarked rather than guessing." 
].join(" ");

export function installNovelEmphasis(runtime) {
  function normalizeItems(items) {
    const result = [];
    const ids = new Set();
    for (const item of Array.isArray(items) ? items : []) {
      const id = String(item && item.id || "").slice(0, 180);
      const source = String(item && item.source || "").slice(0, MAX_SOURCE_CHARS);
      const translation = String(item && item.translation || "").slice(0, MAX_SOURCE_CHARS);
      if (!id || !source || !translation || ids.has(id)) continue;
      if (!source.includes(OPEN)) continue;
      ids.add(id);
      result.push({ id, source, translation });
      if (result.length >= MAX_ITEMS) break;
    }
    return result;
  }

  function buildPrompt(items) {
    return [
      `Prompt version: ${PROMPT_VERSION}`,
      MARK_RULES,
      'Return JSON only: {"alignments":[{"id":"p1","marked_translation":"..."}]}',
      `Input: ${JSON.stringify(items.map(item => ({
        id: item.id, source: item.source, translation: item.translation
      })))}`
    ].join("\n");
  }

  /** 去掉标记后的文本(空白差异容错):用来确认模型没改译文。 */
  function stripMarks(value) {
    return String(value || "").split(OPEN).join("").split(CLOSE).join("");
  }

  function folded(value) {
    return String(value || "").replace(/\s+/gu, "");
  }

  /**
   * 只放行「标记成对、段数>0、去掉标记后与原文译文一致」的条目。
   * 段数与原文是否一致由内容侧最后核对(那里才知道原文有几段强调)。
   */
  function sanitizeAlignments(parsed, items) {
    const byId = new Map(items.map(item => [item.id, item]));
    const alignments = [];
    for (const row of Array.isArray(parsed && parsed.alignments) ? parsed.alignments : []) {
      const id = String(row && row.id || "").slice(0, 180);
      const item = byId.get(id);
      const marked = String(row && (row.marked_translation ?? row.markedTranslation) || "");
      if (!item || !marked) continue;
      const opens = marked.split(OPEN).length - 1;
      const closes = marked.split(CLOSE).length - 1;
      if (opens !== closes || opens === 0) continue;
      if (folded(stripMarks(marked)) !== folded(item.translation)) continue;
      alignments.push({ id, marked_translation: marked.slice(0, MAX_SOURCE_CHARS * 2) });
    }
    return alignments;
  }

  function buildCacheKey(items, configuration) {
    return `${CACHE_PREFIX}${runtime.stableHash128(runtime.stableSerialize({
      prompt: PROMPT_VERSION,
      model: configuration.translation.model,
      baseUrl: configuration.translation.baseUrl,
      items
    }))}`;
  }

  async function requestModel(items, configuration) {
    const translation = configuration.translation;
    if (llmProviders.keyRequired(translation.provider) && !translation.apiKey) {
      throw new Error(`翻译 API Key 未配置：请在设置页「翻译服务」中为当前服务商（${llmProviders.providerLabel(translation.provider)}）填写密钥`);
    }
    const endpoint = runtime.buildOpenAICompatibleEndpoint(translation.baseUrl);
    const body = {
      model: translation.model || runtime.DEFAULT_TRANSLATION_MODEL,
      temperature: 0,
      messages: [{ role: "system", content: SYSTEM_PROMPT }, { role: "user", content: buildPrompt(items) }],
      ...thinkingMode.thinkingBodyFields(translation.thinkingMode, translation.provider),
      response_format: { type: "json_object" }
    };
    // 思考参数 / json 模式被服务商拒了就按组剥掉重发（见 translation-utils.js）
    const sent = await runtime.sendTranslationBodyWithFallbacks(
      endpoint, translation.apiKey, body, REQUEST_TIMEOUT_MS, { includeResponseMeta: true }
    );
    const envelope = sent.envelope;
    return runtime.parseModelJson(runtime.extractOpenAIMessageText(envelope && envelope.content));
  }

  async function handleAlignNovelEmphasis(message = {}) {
    try {
      const items = normalizeItems(message.items);
      if (!items.length) return { ok: false, error: "ALIGN_NOVEL_EMPHASIS requires marked source items" };
      if (runtime.backgroundTestHooks && typeof runtime.backgroundTestHooks.alignNovelEmphasis === "function") {
        const stub = await runtime.backgroundTestHooks.alignNovelEmphasis({ items });
        return { ok: true, alignments: sanitizeAlignments(stub, items), source: "test-hook" };
      }
      const configuration = await runtime.loadConfiguration();
      const cacheKey = buildCacheKey(items, configuration);
      if (message.force !== true) {
        const cached = await runtime.getCache(cacheKey);
        if (cached && Array.isArray(cached.alignments)) {
          return { ok: true, cached: true, alignments: cached.alignments };
        }
      }
      const alignments = sanitizeAlignments(await requestModel(items, configuration), items);
      if (alignments.length) await runtime.setCache(cacheKey, { alignments });
      return { ok: true, alignments };
    } catch (error) {
      return { ok: false, error: runtime.getErrorMessage(error) };
    }
  }
  runtime.handleAlignNovelEmphasis = handleAlignNovelEmphasis;
}
