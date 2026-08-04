const PROMPT_VERSION = "kakao-novel-v1";
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

  function indexGlossaryFallbacks(validation) {
    return new Map((validation.glossaryFallbacks || []).map(row => [String(row.id), row]));
  }

  function acceptGlossaryFallback(fallback, translations, warnings) {
    const id = String(fallback && fallback.id || "");
    const translatedText = String(fallback && fallback.translated_text || "").trim();
    if (!id || !translatedText) return false;
    translations.set(id, { id, translated_text: translatedText });
    warnings.set(id, {
      id,
      code: "glossary_warning",
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

  function buildPrompt(items, context, glossary) {
    const rows = items.map(item => ({
      id: item.id,
      text: item.original_text
    }));
    const glossaryPrompt = runtime.glossaryCore.buildPrompt(glossary, items, {
      scopeKey: context.scopeKey
    });
    return [
      `Prompt version: ${PROMPT_VERSION}`,
      `Translate this web-novel passage from ${context.sourceLanguage || "auto-detected source"} into ${context.targetLanguage || "zh-CN"}.`,
      "Preserve paragraph ids and paragraph boundaries. Keep voice, viewpoint, relationships, honorifics, and suspense consistent.",
      "Use the previous translation and nearby context only for continuity; never add events absent from the source.",
      "Return JSON only with translations and memory_delta.",
      '{"translations":[{"id":"p1","translated_text":"..."}],"memory_delta":{"summary":"","characters":[],"relationships":[],"honorifics":[],"unresolved":[]}}',
      ...(glossaryPrompt ? [glossaryPrompt] : []),
      `Book memory: ${runtime.stableSerialize(context.memory || {})}`,
      `Previous translated block: ${String(context.previousTranslation || "").slice(-5000)}`,
      `Nearby preceding text: ${String(context.beforeText || "").slice(-3000)}`,
      `Nearby following text: ${String(context.afterText || "").slice(0, 3000)}`,
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
    if (!translation.apiKey) throw new Error("请先配置翻译 API Key");
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

  async function loadContext(message, configuration) {
    const stored = await runtime.storageGet([runtime.novelMemoryCore.STORAGE_KEY]);
    const memoryStore = runtime.novelMemoryCore.normalizeStore(stored[runtime.novelMemoryCore.STORAGE_KEY]);
    const memoryContext = runtime.novelMemoryCore.getContext(memoryStore, message.scopeKey, message);
    const context = {
      scopeKey: String(message.scopeKey || ""),
      memory: message.memory || memoryContext.memory,
      memoryRevision: Number(message.memoryRevision ?? memoryContext.revision) || 0,
      previousTranslation: message.previousTranslation,
      beforeText: message.beforeText,
      afterText: message.afterText,
      revisionInstruction: String(message.revisionInstruction || "").slice(0, 4000),
      sourceLanguage: String(message.sourceLanguage || configuration.translation.sourceLanguage || "auto"),
      targetLanguage: String(message.targetLanguage || configuration.translation.targetLanguage || "zh-CN")
    };
    const glossary = configuration.glossary;
    const glossaryFingerprint = runtime.glossaryCore.getFingerprint(glossary, context);
    return { context, glossary, glossaryFingerprint };
  }

  async function translatePending(items, context, glossary, configuration, signal = null) {
    const diagnostics = [];
    let first;
    let requestRetried = false;
    try {
      first = await requestModel(items, context, glossary, configuration, diagnostics, signal);
    } catch (error) {
      if (signal && signal.aborted) throw error;
      requestRetried = true;
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
    const initialFallbacks = indexGlossaryFallbacks(checked);
    let firstMemoryUsed = checked.accepted.length > 0;
    let errors = checked.errors;
    let retryDelta = null;
    if (errors.length && !requestRetried) {
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
          const retryFallback = indexGlossaryFallbacks(rechecked).get(item.id);
          if (accepted) {
            byId.set(accepted.id, accepted);
            warnings.delete(accepted.id);
            retryDelta = runtime.novelMemoryCore.mergeMemory(retryDelta, retry && retry.memory_delta);
          } else if (acceptGlossaryFallback(retryFallback, byId, warnings)) {
            retryDelta = runtime.novelMemoryCore.mergeMemory(retryDelta, retry && retry.memory_delta);
          } else if (acceptGlossaryFallback(initialFallbacks.get(item.id), byId, warnings)) {
            firstMemoryUsed = true;
          } else {
            retryErrors.push(...rechecked.errors);
          }
        } catch (error) {
          if (acceptGlossaryFallback(initialFallbacks.get(item.id), byId, warnings)) {
            firstMemoryUsed = true;
          } else {
            retryErrors.push({
              id: item.id,
              code: "retry_failed",
              error: runtime.getErrorMessage(error)
            });
          }
        }
      }
      errors = retryErrors;
    } else if (errors.length) {
      errors = errors.filter(error => {
        if (error.code !== "glossary_violation") return true;
        const accepted = acceptGlossaryFallback(initialFallbacks.get(error.id), byId, warnings);
        firstMemoryUsed ||= accepted;
        return !accepted;
      });
    }
    return {
      translations: [...byId.values()],
      memoryDelta: runtime.novelMemoryCore.mergeMemory(
        firstMemoryUsed ? first && first.memory_delta : null,
        retryDelta
      ),
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
      const configuration = await runtime.loadConfiguration();
      const { context, glossary, glossaryFingerprint } = await loadContext(message, configuration);
      const cachePayload = {
        prompt: PROMPT_VERSION,
        items,
        model: configuration.translation.model,
        baseUrl: configuration.translation.baseUrl,
        sourceLanguage: context.sourceLanguage,
        targetLanguage: context.targetLanguage,
        scopeKey: context.scopeKey,
        glossaryFingerprint,
        memoryRevision: context.memoryRevision,
        memory: context.memory,
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
        translations: result.translations,
        memory_delta: result.memoryDelta,
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
