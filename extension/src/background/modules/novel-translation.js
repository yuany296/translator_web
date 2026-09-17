import llmProviders from "../../shared/llm-providers.js";

const PROMPT_VERSION = "kakao-novel-v4";
const CACHE_PREFIX = "mt_cache_v23:novel:";
const REQUEST_TIMEOUT_MS = 90_000;

export function installNovelTranslation(runtime) {
  runtime.NOVEL_TRANSLATION_PROMPT_VERSION = PROMPT_VERSION;
  function normalizeDiagnosticError(error) {
    return runtime.getErrorMessage(error).slice(0, 500);
  }

  function getReturnedIds(payload) {
    return (Array.isArray(payload && payload.translations) ? payload.translations : [])
      .map(row => String(row && row.id || "").slice(0, 180))
      .filter(Boolean);
  }

  function attachValidationErrors(diagnostics, errors) {
    const target = diagnostics.at(-1);
    if (!target || target.status !== "parsed") return;
    target.validationErrors = (Array.isArray(errors) ? errors : []).map(error => ({
      id: String(error && error.id || "").slice(0, 180),
      code: String(error && error.code || "unknown").slice(0, 80),
      terms: (Array.isArray(error && error.terms) ? error.terms : [])
        .map(term => String(term).slice(0, 120)).slice(0, 20)
    }));
  }

  /**
   * 校验没通过、但仍应保留译文的回落项：术语没照用(glossary_warning)与
   * 原文引号被丢掉(dialogue_quote_warning)。两者形状一样、只有警告码不同，
   * 所以合成一张表；重试后仍失败时按这里的顺序回落（术语优先）。
   */
  function indexFallbacks(validation) {
    const rows = [
      ...(validation.glossaryFallbacks || []).map(row => ({ ...row, code: "glossary_warning" })),
      ...(validation.quoteFallbacks || []).map(row => ({ ...row, code: "dialogue_quote_warning" }))
    ];
    return new Map(rows.map(row => [String(row.id), row]));
  }

  function acceptFallback(fallback, translations, warnings) {
    const id = String(fallback && fallback.id || "");
    const translatedText = String(fallback && fallback.translated_text || "").trim();
    if (!id || !translatedText) return false;
    translations.set(id, { id, translated_text: translatedText });
    warnings.set(id, {
      id,
      code: String(fallback.code || "glossary_warning"),
      terms: (Array.isArray(fallback.terms) ? fallback.terms : []).map(String)
    });
    return true;
  }

  function buildCacheKey(kind, payload) {
    return `${CACHE_PREFIX}${kind}:${runtime.stableHash128(runtime.stableSerialize(payload))}`;
  }

  function normalizeRequestItems(items) {
    const result = [];
    const ids = new Set();
    for (let index = 0; index < (Array.isArray(items) ? items.length : 0); index += 1) {
      const item = runtime.novelCore.normalizeParagraph(items[index], index);
      if (!item || ids.has(item.id)) continue;
      ids.add(item.id);
      result.push(item);
    }
    return result;
  }

  // 对话引号的硬规则。模型最容易在这里偷懒(JSON/NDJSON 模式下把引号当格式丢掉),
  // 所以规则写死到字符级、并给正反例;这不是"风格建议"，是必须逐字符保持的内容。
  const QUOTE_RULE = [
    "Dialogue quotation marks are content, not formatting: reproduce the source's own quote characters exactly",
    "(“ ” 「 」 『 』 ‘ ’ ｢ ｣ and the ASCII double/single quotes).",
    "If a source paragraph is wrapped in quotes, the whole translated paragraph must stay wrapped in that same pair.",
    "If the source contains quoted speech inside a longer paragraph, the translation must contain a matching quoted span in the same place.",
    "Never drop the quotes, never swap them for another style, and never add quotes the source does not have.",
    'Example: source `"난 무조건 탈색부터 한다."` -> correct `“我不管，肯定要先漂发。”`, wrong `我不管，肯定要先漂发。`'
  ].join(" ");

  function buildPrompt(items, context, glossary) {
    const rows = items.map(item => ({
      id: item.id,
      text: item.original_text
    }));
    const glossaryPrompt = runtime.glossaryCore.buildPrompt(glossary, items, {
      scopeKey: context.scopeKey
    });
    // 重试时点名"上一次哪几段把引号丢了",比一句泛泛的规则更管用。
    const quoteRetryIds = (Array.isArray(context.retryErrors) ? context.retryErrors : [])
      .filter(error => error && error.code === "dialogue_quote_missing")
      .map(error => String(error.id || "").slice(0, 180)).filter(Boolean);
    return [
      `Prompt version: ${PROMPT_VERSION}`,
      `Translate this web-novel passage from ${context.sourceLanguage || "auto-detected source"} into ${context.targetLanguage || "zh-CN"}.`,
      "Preserve paragraph ids and paragraph boundaries. Keep voice, viewpoint, relationships, honorifics, and suspense consistent.",
      "Translate each input item independently. Never merge two items into one translation; never let one item's translation continue from or repeat another item's translation. Output exactly one translations entry per input id, covering only that id's own text.",
      QUOTE_RULE,
      "Use the previous translation and nearby context only for continuity; never add events absent from the source.",
      "Return JSON only with translations.",
      '{"translations":[{"id":"p1","translated_text":"..."}]}',
      ...(glossaryPrompt ? [glossaryPrompt] : []),
      `Previous translated block: ${String(context.previousTranslation || "").slice(-5000)}`,
      `Nearby preceding text: ${String(context.beforeText || "").slice(-3000)}`,
      `Nearby following text: ${String(context.afterText || "").slice(0, 3000)}`,
      ...(quoteRetryIds.length
        ? [`These ids dropped the source dialogue quotes last time (${quoteRetryIds.join(
          ", ")}): re-output them with the source's own quote characters around the same dialogue.`]
        : []),
      ...(Array.isArray(context.retryErrors) && context.retryErrors.length
        ? [`Retry corrections required: ${runtime.stableSerialize(context.retryErrors)}`] : []),
      ...(context.revisionInstruction
        ? [`User revision instruction for this single request: ${String(context.revisionInstruction).slice(0, 4000)}`]
        : []),
      `Input: ${JSON.stringify(rows)}`
    ].join("\n");
  }

  async function requestModel(items, context, glossary, configuration, diagnostics, signal = null) {
    const diagnostic = {
      itemIds: items.map(item => item.id),
      status: "started",
      usedJsonMode: true,
      responseChars: 0,
      returnedIds: [],
      validationErrors: []
    };
    if (runtime.backgroundTestHooks && typeof runtime.backgroundTestHooks.requestNovelChunk === "function") {
      try {
        const result = await runtime.backgroundTestHooks.requestNovelChunk({ items, context, glossary });
        Object.assign(diagnostic, {
          source: "test-hook",
          status: "parsed",
          returnedIds: getReturnedIds(result)
        });
        diagnostics.push(diagnostic);
        return result;
      } catch (error) {
        diagnostic.status = "request_failed";
        diagnostic.error = normalizeDiagnosticError(error);
        diagnostics.push(diagnostic);
        throw error;
      }
    }
    const translation = configuration.translation;
    // 免密钥本地服务商(Ollama 等)允许空 Key,只有 needsKey 服务商才要求配置
    if (llmProviders.keyRequired(translation.provider) && !translation.apiKey) {
      throw new Error(`翻译 API Key 未配置：请在设置页「翻译服务」中为当前服务商（${llmProviders.providerLabel(translation.provider)}）填写密钥`);
    }
    const body = {
      model: translation.model || runtime.DEFAULT_TRANSLATION_MODEL,
      temperature: 0,
      messages: [{
        role: "system",
        content: "You are a web-novel literary translator and continuity editor. Return strict JSON only."
      }, {
        role: "user",
        content: buildPrompt(items, context, glossary)
      }],
      response_format: { type: "json_object" }
    };
    const endpoint = runtime.buildOpenAICompatibleEndpoint(translation.baseUrl);
    try {
      let envelope = await runtime.sendOpenAICompatibleTranslationRequest(
        endpoint, translation.apiKey, body, REQUEST_TIMEOUT_MS, { includeResponseMeta: true, signal }
      );
      if (!envelope || !envelope.content) {
        const fallback = { ...body };
        delete fallback.response_format;
        diagnostic.usedJsonMode = false;
        envelope = await runtime.sendOpenAICompatibleTranslationRequest(
          endpoint, translation.apiKey, fallback, REQUEST_TIMEOUT_MS, { includeResponseMeta: true, signal }
        );
      }
      const content = runtime.extractOpenAIMessageText(envelope && envelope.content);
      diagnostic.responseMeta = envelope && envelope.responseMeta || {};
      diagnostic.responseChars = content.length;
      const parsed = runtime.parseModelJson(content);
      diagnostic.status = "parsed";
      diagnostic.returnedIds = getReturnedIds(parsed);
      diagnostics.push(diagnostic);
      return parsed;
    } catch (error) {
      diagnostic.status = diagnostic.responseChars ? "parse_failed" : "request_failed";
      diagnostic.error = normalizeDiagnosticError(error);
      diagnostics.push(diagnostic);
      throw error;
    }
  }

  async function loadContext(message, configuration, sender = {}) {
    const context = {
      scopeKey: String(message.scopeKey || ""),
      previousTranslation: message.previousTranslation,
      beforeText: message.beforeText,
      afterText: message.afterText,
      revisionInstruction: String(message.revisionInstruction || "").slice(0, 4000),
      sourceLanguage: String(message.sourceLanguage || configuration.translation.sourceLanguage || "auto"),
      targetLanguage: String(message.targetLanguage || configuration.translation.targetLanguage || "zh-CN"),
      pageUrl: String(message.pageUrl || sender && sender.tab && sender.tab.url || "")
    };
    const glossary = configuration.glossary;
    const glossaryFingerprint = runtime.glossaryCore.getFingerprint(glossary, context);
    return { context, glossary, glossaryFingerprint };
  }

  async function translatePending(items, context, glossary, configuration, signal = null) {
    const diagnostics = [];
    let first;
    try {
      first = await requestModel(items, context, glossary, configuration, diagnostics, signal);
    } catch (error) {
      if (signal && signal.aborted) throw error;
      first = await requestModel(items, {
        ...context,
        retryErrors: [{ code: "request_failed", error: runtime.getErrorMessage(error) }]
      }, glossary, configuration, diagnostics, signal);
    }
    const relevant = runtime.glossaryCore.getRelevantEntries(glossary, items, context);
    const checked = runtime.novelCore.validateTranslations(items, first && first.translations, relevant, context);
    attachValidationErrors(diagnostics, checked.errors);
    const byId = new Map(checked.accepted.map(row => [row.id, row]));
    const warnings = new Map();
    const initialFallbacks = indexFallbacks(checked);
    let errors = checked.errors;
    // 缺段/坏段必须走逐段补救重试：这是缺译文段落的唯一恢复路径，网络失败整体重试过也不例外。
    if (errors.length) {
      const retryItems = items.filter(item => errors.some(error => error.id === item.id));
      const retryErrors = [];
      for (const item of retryItems) {
        const itemErrors = errors.filter(error => error.id === item.id);
        try {
          // 漏项逐段补救，避免模型在第二个批量响应中再次跳过中间 ID。
          const retry = await requestModel([item], {
            ...context,
            retryErrors: itemErrors
          }, glossary, configuration, diagnostics, signal);
          const retryRelevant = runtime.glossaryCore.getRelevantEntries(glossary, [item], context);
          const rechecked = runtime.novelCore.validateTranslations(
            [item], retry && retry.translations, retryRelevant, context
          );
          attachValidationErrors(diagnostics, rechecked.errors);
          const accepted = rechecked.accepted.find(row => row.id === item.id);
          const retryFallback = indexFallbacks(rechecked).get(item.id);
          if (accepted) {
            byId.set(accepted.id, accepted);
            warnings.delete(accepted.id);
          } else if (!acceptFallback(retryFallback, byId, warnings)
            && !acceptFallback(initialFallbacks.get(item.id), byId, warnings)) {
            retryErrors.push(...rechecked.errors);
          }
        } catch (error) {
          if (!acceptFallback(initialFallbacks.get(item.id), byId, warnings)) {
            retryErrors.push({
              id: item.id,
              code: "retry_failed",
              error: runtime.getErrorMessage(error)
            });
          }
        }
      }
      errors = retryErrors;
    }
    return {
      translations: [...byId.values()],
      errors,
      warnings: [...warnings.values()],
      diagnostics
    };
  }

  async function handleTranslateNovelChunk(message = {}, sender = {}) {
    try {
      const items = normalizeRequestItems(message.items);
      if (!items.length || items.length !== (Array.isArray(message.items) ? message.items.length : 0)) {
        return { ok: false, error: "TRANSLATE_NOVEL_CHUNK requires unique stable paragraph ids" };
      }
      const originalById = new Map(items.map(item => [item.id, item.original_text]));
      // LLM 偶发丢掉对话引号:按原文引号对做确定性兜底,缓存命中同样处理。
      const restoreQuotes = rows => (Array.isArray(rows) ? rows : []).map(row => {
        const original = originalById.get(String(row && row.id || ""));
        return original ? {
          ...row,
          translated_text: runtime.restoreDialogueQuotes(original, String(row && row.translated_text || ""))
        } : row;
      });
      const configuration = await runtime.loadConfiguration();
      const { context, glossary, glossaryFingerprint } = await loadContext(message, configuration, sender);
      const cachePayload = {
        prompt: PROMPT_VERSION,
        items,
        model: configuration.translation.model,
        baseUrl: configuration.translation.baseUrl,
        sourceLanguage: context.sourceLanguage,
        targetLanguage: context.targetLanguage,
        scopeKey: context.scopeKey,
        glossaryFingerprint,
        previousTranslation: context.previousTranslation,
        beforeText: context.beforeText,
        afterText: context.afterText,
        revisionInstruction: context.revisionInstruction
      };
      const cacheKey = buildCacheKey("chunk", cachePayload);
      const cached = message.force === true ? null : await runtime.getCache(cacheKey);
      if (cached && Array.isArray(cached.translations)) {
        return {
          ok: true,
          cached: true,
          ...cached,
          translations: restoreQuotes(cached.translations),
          diagnostics: [{
            source: "cache",
            status: "cache_hit",
            itemIds: items.map(item => item.id)
          }]
        };
      }
      const taskId = String(message && message.taskId || "");
      const controller = taskId ? new AbortController() : null;
      if (controller) runtime.registerTaskAbort(taskId, controller, sender && sender.tab && sender.tab.id);
      let result;
      try {
        result = await translatePending(items, context, glossary, configuration, controller ? controller.signal : null);
      } catch (error) {
        if (runtime.isAbortError(error)) {
          return { ok: false, cancelled: true, translations: [], errors: [], warnings: [], diagnostics: [] };
        }
        throw error;
      } finally {
        if (controller) runtime.unregisterTaskAbort(taskId, controller);
      }
      const cacheValue = {
        translations: restoreQuotes(result.translations),
        errors: result.errors,
        warnings: result.warnings,
        partial: result.errors.length > 0
      };
      if (!cacheValue.partial) await runtime.setCache(cacheKey, cacheValue);
      return { ok: true, ...cacheValue, diagnostics: result.diagnostics };
    } catch (error) {
      return { ok: false, error: runtime.getErrorMessage(error) };
    }
  }
  runtime.handleTranslateNovelChunk = handleTranslateNovelChunk;
}
