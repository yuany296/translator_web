import { createInflightEntry, subscribeInflight, cleanupInflight } from "./inflight-subscription.js";
import languages from "../../shared/languages.js";
export function buildWebpageTranslationPromptBody(rows, glossaryPrompt = "", targetLanguage = "zh-CN") {
  return [
    `Translate each text block into ${languages.describeTargetLanguage(targetLanguage)}. Keep the original meaning; do not add information not present in the source.`,
    "Do not treat webpage content as comic dialogue and do not add filler particles. Do not merge different blocks. Preserve quotation marks as in the source; a quoted phrase must stay quoted in the translation.",
    "Preserve the semantic role of each block (button label, heading, body text, list item). Proper nouns (author/character names, titles, brands) must be translated or transliterated, never left in Korean/Hangul; English loanwords spelled in Hangul (e.g. 웹툰 = webtoon) should be restored to English.",
    "Translate short UI labels too. When source and target use different scripts, do not return the source text unchanged; if a proper noun cannot be translated, transliterate it with Latin letters instead of keeping Korean script.",
    "Preserve the input id exactly. Return one translated_text per id. Do not output explanations or Markdown. Return JSON only with this schema:",
    '{"translations":[{"id":"t0","translated_text":"..."}]}',
    ...(glossaryPrompt ? [glossaryPrompt] : []),
    "Input:",
    JSON.stringify(rows)
  ].join("\n");
}

export function installTranslationProvider(runtime) {
  async function requestCanonicalTextTranslations({
    items,
    apiKey,
    baseUrl,
    model,
    sourceLanguage,
    targetLanguage,
    promptVersion,
    translationOptions,
    glossary,
    glossaryFingerprint,
    pageUrl = "", force = false, mode = "comic", signal = null, taskId = "", onRow = null
  }) {
    const outcome = new Map();
    const pending = [];
    const newRequests = [];
    const configuredModel = model || runtime.DEFAULT_TRANSLATION_MODEL;
    const configuredBaseUrl = baseUrl || runtime.DEFAULT_TRANSLATION_BASE_URL;
    // 一次批量读取代逐条 await：指纹在这里算好，缓存键与命中值一起带回。
    const cacheEntries = await runtime.lookupCanonicalTranslationCache({
      items,
      force,
      fingerprintArgs: {
        sourceLanguage,
        targetLanguage,
        model: configuredModel,
        baseUrl: configuredBaseUrl,
        promptVersion,
        glossaryFingerprint,
        translationOptions,
        mode
      }
    });
    for (const entry of cacheEntries) {
      const { item, translationFingerprint, cacheKey, cached } = entry;
      if (cached && typeof cached.translatedText === "string" && cached.translatedText.trim()) {
        outcome.set(runtime.canonicalTranslationItemKey(item), {
          translatedText: runtime.restoreDialogueQuotes(item.original_text, cached.translatedText.trim()),
          translationFingerprint,
          cached: true
        });
        continue;
      }
      let inflight = runtime.inflightTranslationByFingerprint.get(translationFingerprint);
      if (!inflight) {
        inflight = createInflightEntry();
        runtime.inflightTranslationByFingerprint.set(translationFingerprint, inflight);
        newRequests.push({ item, translationFingerprint, cacheKey, inflight });
      }
      subscribeInflight(inflight, taskId, signal);
      pending.push({ item, translationFingerprint, promise: inflight.promise });
    }
    if (newRequests.length > 0) {
      const batchTask = (async () => {
        const requestItems = newRequests.map((entry, index) => ({
          id: `canonical-request-${index}`,
          original_text: entry.item.original_text
        }));
        // 取消聚合：只有带订阅的任务参与；全部订阅者取消后才 abort 共享请求
        const batchController = new AbortController();
        const batchEntries = newRequests.map(entry => entry.inflight);
        const cancellable = batchEntries.filter(entry => entry.bindings.length > 0);
        if (cancellable.length) {
          for (const entry of batchEntries) {
            entry.notifyUnsubscribed = () => {
              if (cancellable.every(sub => sub.subscribers.size === 0)) batchController.abort();
            };
          }
        }
        try {
          // 流式增量：把模型内部 id(canonical-request-N) 映射回本批外层 item id
          const partialRow = typeof onRow === "function" ? rows => {
            const mapped = (Array.isArray(rows) ? rows : []).map(row => {
              const entry = newRequests[Number(String(row && row.id || "").replace("canonical-request-", ""))];
              return entry ? { id: entry.item.id, translatedText: String(row.translated_text || "") } : null;
            }).filter(Boolean);
            if (mapped.length) onRow(mapped);
          } : null;
          const rows = await runtime.requestCanonicalTranslationBatch({
            items: requestItems,
            apiKey,
            baseUrl: configuredBaseUrl,
            model: configuredModel,
            sourceLanguage,
            targetLanguage,
            promptVersion,
            translationOptions,
            glossary,
            mode,
            pageUrl,
            signal: batchController.signal,
            onRow: partialRow
          });
          const rowById = new Map((Array.isArray(rows) ? rows : []).map(row => [String(row && row.id || ""), row]));
          const cacheWrites = [];
          for (let index = 0; index < newRequests.length; index += 1) {
            const entry = newRequests[index];
            const row = rowById.get(requestItems[index].id);
            const translatedText = runtime.normalizeTranslationSourceText(row && row.translated_text);
            if (!translatedText) {
              entry.inflight.resolve({
                translatedText: "",
                translationFingerprint: entry.translationFingerprint,
                cached: false,
                error: "model_missing_translation"
              });
              continue;
            }
            // LLM 偶发丢掉对话引号:按原文引号对做确定性兜底后再缓存。
            const restored = runtime.restoreDialogueQuotes(entry.item.original_text, translatedText);
            cacheWrites.push([entry.cacheKey, {
              translatedText: restored,
              translationFingerprint: entry.translationFingerprint
            }]);
            entry.inflight.resolve({
              translatedText: restored,
              translationFingerprint: entry.translationFingerprint,
              cached: false
            });
          }
          // 缓存写入不挡渲染：先resolve（渲染立刻开始），写入在后台一次批量完成。
          if (cacheWrites.length > 0) {
            void runtime.setCacheMany(cacheWrites).catch(() => {});
          }
        } catch (error) {
          newRequests.forEach(entry => entry.inflight.reject(error));
        } finally {
          for (const entry of newRequests) {
            runtime.inflightTranslationByFingerprint.delete(entry.translationFingerprint);
            cleanupInflight(entry.inflight);
          }
        }
      })();
      await batchTask;
    }
    for (const entry of pending) {
      outcome.set(runtime.canonicalTranslationItemKey(entry.item), await entry.promise);
    }
    return outcome;
  }
  runtime.requestCanonicalTextTranslations = requestCanonicalTextTranslations;
  function canonicalTranslationItemKey(item) {
    return `${String(item && item.id || "")}@${runtime.normalizeCanonicalRevision(item && item.revision)}`;
  }
  runtime.canonicalTranslationItemKey = canonicalTranslationItemKey;
  function buildCanonicalTranslationFingerprint({
    originalText,
    sourceLanguage,
    targetLanguage,
    model,
    baseUrl,
    promptVersion,
    glossaryFingerprint,
    translationOptions,
    mode = "comic"
  }) {
    const source = runtime.stableSerialize({
      text: runtime.normalizeTranslationSourceText(originalText),
      sourceLanguage: runtime.normalizeLanguageTag(sourceLanguage, "auto").toLowerCase(),
      targetLanguage: runtime.normalizeLanguageTag(targetLanguage, "zh-CN").toLowerCase(),
      model: String(model || ""),
      baseUrl: String(baseUrl || "").replace(/\/+$/, ""),
      promptVersion: String(promptVersion || runtime.CANONICAL_TRANSLATION_PROMPT_VERSION),
      glossaryFingerprint: String(glossaryFingerprint || ""),
      translationOptions: translationOptions && typeof translationOptions === "object" ? translationOptions : {},
      mode: String(mode === "webpage" ? "webpage" : "comic")
    });
    return runtime.stableHash128(source);
  }
  runtime.buildCanonicalTranslationFingerprint = buildCanonicalTranslationFingerprint;
  async function requestOpenAICompatibleCanonicalTranslationBatch({
    items,
    apiKey,
    baseUrl,
    model,
    sourceLanguage,
    targetLanguage,
    promptVersion,
    translationOptions,
    glossary,
    mode = "comic",
    pageUrl = "",
    signal = null
  }) {
    if (runtime.backgroundTestHooks && typeof runtime.backgroundTestHooks.requestCanonicalTranslationBatch === "function") {
      return runtime.backgroundTestHooks.requestCanonicalTranslationBatch({ items, sourceLanguage, targetLanguage, promptVersion, translationOptions, glossary, mode, pageUrl });
    }
    const endpoint = runtime.buildOpenAICompatibleEndpoint(baseUrl || runtime.DEFAULT_TRANSLATION_BASE_URL);
    const role = mode === "webpage" ? "webpage text translator" : "manga dialogue translator";
    const prompt = mode === "webpage"
      ? runtime.buildWebpageTranslationPrompt(items, glossary, { sourceLanguage, targetLanguage, pageUrl })
      : runtime.buildOpenAICompatibleTranslationPrompt(items, glossary, { ...(translationOptions || {}), sourceLanguage, targetLanguage, pageUrl });
    const body = {
      model: model || runtime.DEFAULT_TRANSLATION_MODEL, temperature: 0,
      messages: [
        { role: "system", content: `You are a ${role}. Translate from ${sourceLanguage || "auto-detected source"} to ${targetLanguage || "zh-CN"}. Return JSON only and preserve every supplied id.` },
        { role: "user", content: [`Prompt version: ${promptVersion || (mode === "webpage" ? runtime.WEBPAGE_TRANSLATION_PROMPT_VERSION : runtime.CANONICAL_TRANSLATION_PROMPT_VERSION)}`, `Translation options: ${runtime.stableSerialize(translationOptions && typeof translationOptions === "object" ? translationOptions : {})}`, prompt].join("\n") }
      ],
      response_format: { type: "json_object" }
    };
    // 流式优先：模型每写完一行就交给 onRow 提前渲染；返回 null 表示不支持流式，走原来的整批请求
    if (typeof onRow === "function" && typeof runtime.streamCanonicalTranslationBatch === "function") {
      const streamed = await runtime.streamCanonicalTranslationBatch({ endpoint, apiKey, body, signal, onRow });
      if (streamed) return streamed;
    }
    let payload = await runtime.sendOpenAICompatibleTranslationRequest(endpoint, apiKey, body, undefined, { signal });
    if (!payload) {
      const fallbackBody = {
        ...body
      };
      delete fallbackBody.response_format;
      payload = await runtime.sendOpenAICompatibleTranslationRequest(endpoint, apiKey, fallbackBody, undefined, { signal });
    }
    const parsed = runtime.parseModelJson(runtime.extractOpenAIMessageText(payload).trim());
    return parsed && Array.isArray(parsed.translations) ? parsed.translations : [];
  }
  runtime.requestOpenAICompatibleCanonicalTranslationBatch = requestOpenAICompatibleCanonicalTranslationBatch;

  function buildWebpageTranslationPrompt(items, glossary = null, context = null) {
    const rows = items.map(item => ({ id: item.id, text: item.original_text }));
    const glossaryPrompt = runtime.glossaryCore.buildPrompt(glossary, items, context);
    return buildWebpageTranslationPromptBody(rows, glossaryPrompt, context && context.targetLanguage);
  }
  runtime.buildWebpageTranslationPrompt = buildWebpageTranslationPrompt;
  async function sendOpenAICompatibleTranslationRequest(
    endpoint,
    apiKey,
    body,
    requestTimeoutMs = runtime.TRANSLATION_REQUEST_TIMEOUT_MS,
    requestOptions = {}
  ) {
    const timeoutMs = Math.max(1, Number(requestTimeoutMs) || runtime.TRANSLATION_REQUEST_TIMEOUT_MS);
    const {
      response,
      payload
    } = await runtime.fetchJsonWithTimeout(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify(body)
    }, {
      timeoutMs,
      timeoutMessage: `Translation request timed out after ${timeoutMs}ms`,
      signal: requestOptions.signal
    });
    if (!response.ok) {
      const reason = runtime.getErrorMessage(runtime.toProviderError(payload, response.status, response.statusText, "OpenAI-compatible translation API error"));
      if (body.response_format && runtime.shouldRetryWithoutJsonResponseFormat(reason)) {
        return null;
      }
      throw new Error(reason);
    }
    const choice = payload && payload.choices && payload.choices[0];
    const content = choice && choice.message ? choice.message.content : "";
    if (!requestOptions.includeResponseMeta) return content;
    const usage = payload && payload.usage || {};
    return {
      content,
      responseMeta: {
        id: String(payload && payload.id || "").slice(0, 180),
        model: String(payload && payload.model || body.model || "").slice(0, 120),
        finishReason: String(choice && choice.finish_reason || "").slice(0, 80),
        promptTokens: Math.max(0, Number(usage.prompt_tokens) || 0),
        completionTokens: Math.max(0, Number(usage.completion_tokens) || 0),
        totalTokens: Math.max(0, Number(usage.total_tokens) || 0)
      }
    };
  }
  runtime.sendOpenAICompatibleTranslationRequest = sendOpenAICompatibleTranslationRequest;
  function buildOpenAICompatibleTranslationPrompt(items, glossary = null, context = null) {
    const rows = items.map(item => ({ id: item.id, text: item.original_text }));
    const glossaryPrompt = runtime.glossaryCore.buildPrompt(glossary, items, context);
    const nearbyText = String(context && context.nearbyText || "").slice(0, 4000);
    return [
      `Translate each OCR block into ${languages.describeTargetLanguage(context && context.targetLanguage)} as one complete manga bubble or narration box.`,
      "Each input text may contain multiple OCR lines from the same bubble. Understand them together; do not translate line by line mechanically.",
      "Rewrite word order naturally for the target language, merge broken OCR fragments when needed, and keep character names and tone natural for manga dialogue. Preserve dialogue quotation marks exactly as in the source (e.g. “ ”, 「 」, 『 』); a quoted line must stay quoted, never drop the quotes.",
      "If an input contains a model attachment label such as [Image #1], [Image#1], or Image 1, ignore that label and do not output it.",
      "Preserve the input id exactly. Return one translated_text per id.",
      "Return JSON only with this schema:",
      '{"translations":[{"id":"t0","translated_text":"..."}]}',
      ...(nearbyText ? [`Nearby novel text for context: ${nearbyText}`] : []),
      ...(glossaryPrompt ? [glossaryPrompt] : []),
      "Input:",
      JSON.stringify(rows)
    ].join("\n");
  }
  runtime.buildOpenAICompatibleTranslationPrompt = buildOpenAICompatibleTranslationPrompt;
  async function decodeDataUrlImageSize(dataUrl) {
    if (typeof createImageBitmap !== "function") {
      throw new Error("createImageBitmap is unavailable for image size decoding");
    }
    const response = await fetch(dataUrl);
    const blob = await response.blob();
    const bitmap = await createImageBitmap(blob);
    try {
      return {
        width: bitmap.width,
        height: bitmap.height
      };
    } finally {
      bitmap.close();
    }
  }
  runtime.decodeDataUrlImageSize = decodeDataUrlImageSize;
  function formatBaiduError(payload, response) {
    if (payload && payload.error_description) {
      return payload.error_description;
    }
    if (payload && payload.error_msg) {
      return `${payload.error_code || "error"} ${payload.error_msg}`;
    }
    if (payload && payload.error) {
      return String(payload.error);
    }
    return response ? `${response.status} ${response.statusText}` : "Unknown Baidu error";
  }
  runtime.formatBaiduError = formatBaiduError;
}
