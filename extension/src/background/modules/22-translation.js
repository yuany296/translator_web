export function installBackground22(runtime) {
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
    glossaryFingerprint
  }) {
    const outcome = new Map();
    const pending = [];
    const newRequests = [];
    const configuredModel = model || runtime.DEFAULT_MODELS[runtime.PROVIDERS.baiduDeepSeek];
    const configuredBaseUrl = baseUrl || runtime.DEFAULT_TRANSLATION_BASE_URL;
    for (const item of items) {
      const translationFingerprint = runtime.buildCanonicalTranslationFingerprint({
        originalText: item.original_text,
        sourceLanguage,
        targetLanguage,
        model: configuredModel,
        baseUrl: configuredBaseUrl,
        promptVersion,
        glossaryFingerprint,
        translationOptions
      });
      const cacheKey = `${runtime.CANONICAL_TRANSLATION_CACHE_PREFIX}${translationFingerprint}`;
      const cached = await runtime.getCache(cacheKey);
      if (cached && typeof cached.translatedText === "string" && cached.translatedText.trim()) {
        outcome.set(runtime.canonicalTranslationItemKey(item), {
          translatedText: cached.translatedText.trim(),
          translationFingerprint,
          cached: true
        });
        continue;
      }
      let inflight = runtime.inflightTranslationByFingerprint.get(translationFingerprint);
      if (!inflight) {
        let resolveRequest;
        let rejectRequest;
        inflight = new Promise((resolve, reject) => {
          resolveRequest = resolve;
          rejectRequest = reject;
        });
        runtime.inflightTranslationByFingerprint.set(translationFingerprint, inflight);
        newRequests.push({
          item,
          translationFingerprint,
          cacheKey,
          resolve: resolveRequest,
          reject: rejectRequest
        });
      }
      pending.push({
        item,
        translationFingerprint,
        promise: inflight
      });
    }
    if (newRequests.length > 0) {
      const batchTask = (async () => {
        const requestItems = newRequests.map((entry, index) => ({
          id: `canonical-request-${index}`,
          original_text: entry.item.original_text
        }));
        try {
          const rows = await runtime.requestCanonicalTranslationBatch({
            items: requestItems,
            apiKey,
            baseUrl: configuredBaseUrl,
            model: configuredModel,
            sourceLanguage,
            targetLanguage,
            promptVersion,
            translationOptions,
            glossary
          });
          const rowById = new Map((Array.isArray(rows) ? rows : []).map(row => [String(row && row.id || ""), row]));
          for (let index = 0; index < newRequests.length; index += 1) {
            const entry = newRequests[index];
            const row = rowById.get(requestItems[index].id);
            const translatedText = runtime.normalizeTranslationSourceText(row && row.translated_text);
            if (!translatedText) {
              entry.resolve({
                translatedText: "",
                translationFingerprint: entry.translationFingerprint,
                cached: false,
                error: "model_missing_translation"
              });
              continue;
            }
            await runtime.setCache(entry.cacheKey, {
              translatedText,
              translationFingerprint: entry.translationFingerprint
            });
            entry.resolve({
              translatedText,
              translationFingerprint: entry.translationFingerprint,
              cached: false
            });
          }
        } catch (error) {
          newRequests.forEach(entry => entry.reject(error));
        } finally {
          newRequests.forEach(entry => runtime.inflightTranslationByFingerprint.delete(entry.translationFingerprint));
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
    translationOptions
  }) {
    const source = runtime.stableSerialize({
      text: runtime.normalizeTranslationSourceText(originalText),
      sourceLanguage: runtime.normalizeLanguageTag(sourceLanguage, "auto").toLowerCase(),
      targetLanguage: runtime.normalizeLanguageTag(targetLanguage, "zh-CN").toLowerCase(),
      model: String(model || ""),
      baseUrl: String(baseUrl || "").replace(/\/+$/, ""),
      promptVersion: String(promptVersion || runtime.CANONICAL_TRANSLATION_PROMPT_VERSION),
      glossaryFingerprint: String(glossaryFingerprint || ""),
      translationOptions: translationOptions && typeof translationOptions === "object" ? translationOptions : {}
    });
    return runtime.stableHash128(source);
  }
  runtime.buildCanonicalTranslationFingerprint = buildCanonicalTranslationFingerprint;
  async function requestCanonicalTranslationBatch({
    items,
    apiKey,
    baseUrl,
    model,
    sourceLanguage,
    targetLanguage,
    promptVersion,
    translationOptions,
    glossary
  }) {
    if (runtime.backgroundTestHooks && typeof runtime.backgroundTestHooks.requestCanonicalTranslationBatch === "function") {
      return runtime.backgroundTestHooks.requestCanonicalTranslationBatch({
        items,
        sourceLanguage,
        targetLanguage,
        promptVersion,
        translationOptions,
        glossary
      });
    }
    const endpoint = runtime.buildOpenAICompatibleEndpoint(baseUrl || runtime.DEFAULT_TRANSLATION_BASE_URL);
    const body = {
      model: model || runtime.DEFAULT_MODELS[runtime.PROVIDERS.baiduDeepSeek],
      temperature: 0,
      messages: [{
        role: "system",
        content: `You are a manga dialogue translator. Translate from ${sourceLanguage || "auto-detected source"} to ${targetLanguage || "zh-CN"}. Return JSON only and preserve every supplied id.`
      }, {
        role: "user",
        content: [`Prompt version: ${promptVersion || runtime.CANONICAL_TRANSLATION_PROMPT_VERSION}`, `Translation options: ${runtime.stableSerialize(translationOptions && typeof translationOptions === "object" ? translationOptions : {})}`, runtime.buildOpenAICompatibleTranslationPrompt(items, glossary)].join("\n")
      }],
      response_format: {
        type: "json_object"
      }
    };
    let payload = await runtime.sendOpenAICompatibleTranslationRequest(endpoint, apiKey, body);
    if (!payload) {
      const fallbackBody = {
        ...body
      };
      delete fallbackBody.response_format;
      payload = await runtime.sendOpenAICompatibleTranslationRequest(endpoint, apiKey, fallbackBody);
    }
    const parsed = runtime.parseModelJson(runtime.extractOpenAIMessageText(payload).trim());
    return parsed && Array.isArray(parsed.translations) ? parsed.translations : [];
  }
  runtime.requestCanonicalTranslationBatch = requestCanonicalTranslationBatch;
  async function requestOpenAICompatibleTextTranslations({
    items,
    apiKey,
    baseUrl,
    model,
    sourceImageId = "",
    glossary = null,
    glossaryFingerprint = ""
  }) {
    const result = new Map();
    const cacheKeys = new Map();
    const uncachedItems = [];
    for (const item of items) {
      const cacheKey = runtime.buildBlockTranslationCacheKey(sourceImageId, item, model, baseUrl, glossaryFingerprint);
      cacheKeys.set(item.id, cacheKey);
      const cached = await runtime.getCache(cacheKey);
      if (cached && typeof cached.translatedText === "string" && cached.translatedText.trim()) {
        result.set(item.id, cached.translatedText.trim());
      } else {
        uncachedItems.push(item);
      }
    }
    if (uncachedItems.length === 0) {
      return result;
    }
    const endpoint = runtime.buildOpenAICompatibleEndpoint(baseUrl || runtime.DEFAULT_TRANSLATION_BASE_URL);
    const body = {
      model: model || runtime.DEFAULT_MODELS[runtime.PROVIDERS.baiduDeepSeek],
      temperature: 0,
      messages: [{
        role: "system",
        content: "You are a manga dialogue translator. Translate grouped OCR blocks into natural Simplified Chinese, obey every supplied glossary mapping, and return JSON only."
      }, {
        role: "user",
        content: runtime.buildOpenAICompatibleTranslationPrompt(uncachedItems, glossary)
      }],
      response_format: {
        type: "json_object"
      }
    };
    let payload = await runtime.sendOpenAICompatibleTranslationRequest(endpoint, apiKey, body);
    if (!payload) {
      const fallbackBody = {
        ...body
      };
      delete fallbackBody.response_format;
      payload = await runtime.sendOpenAICompatibleTranslationRequest(endpoint, apiKey, fallbackBody);
    }
    const text = runtime.extractOpenAIMessageText(payload).trim();
    const parsed = runtime.parseModelJson(text);
    const rows = parsed && Array.isArray(parsed.translations) ? parsed.translations : [];
    for (const row of rows) {
      const id = String(row && row.id ? row.id : "").trim();
      const translatedText = String(row && row.translated_text ? row.translated_text : "").trim();
      if (id && translatedText) {
        result.set(id, translatedText);
        const cacheKey = cacheKeys.get(id);
        if (cacheKey) {
          await runtime.setCache(cacheKey, {
            translatedText
          });
        }
      }
    }
    return result;
  }
  runtime.requestOpenAICompatibleTextTranslations = requestOpenAICompatibleTextTranslations;
  function buildBlockTranslationCacheKey(sourceImageId, item, model, baseUrl, glossaryFingerprint = "") {
    const text = runtime.normalizeTextForLocalPaddle(item && item.original_text);
    const box = item && item.rawBox ? item.rawBox : item || {};
    const bbox = [box.left ?? box.x, box.top ?? box.y, box.width ?? box.w, box.height ?? box.h].map(value => Math.round(Number(value || 0) * 10) / 10).join(",");
    return `${runtime.CACHE_PREFIX}block:${runtime.hashString([sourceImageId || "unknown-image", text, bbox, model || "", baseUrl || "", glossaryFingerprint || ""].join("|"))}`;
  }
  runtime.buildBlockTranslationCacheKey = buildBlockTranslationCacheKey;
  async function sendOpenAICompatibleTranslationRequest(endpoint, apiKey, body, requestTimeoutMs = runtime.TRANSLATION_REQUEST_TIMEOUT_MS) {
    const timeoutMs = Math.max(1, Number(requestTimeoutMs) || runtime.TRANSLATION_REQUEST_TIMEOUT_MS);
    const {
      response,
      payload
    } = await runtime.fetchJsonWithTimeout(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiKey}`
      },
      body: JSON.stringify(body)
    }, {
      timeoutMs,
      timeoutMessage: `Translation request timed out after ${timeoutMs}ms`
    });
    if (!response.ok) {
      const reason = runtime.getErrorMessage(runtime.toProviderError(payload, response.status, response.statusText, "OpenAI-compatible translation API error"));
      if (body.response_format && runtime.shouldRetryWithoutJsonResponseFormat(reason)) {
        return null;
      }
      throw new Error(reason);
    }
    return payload && payload.choices && payload.choices[0] && payload.choices[0].message ? payload.choices[0].message.content : "";
  }
  runtime.sendOpenAICompatibleTranslationRequest = sendOpenAICompatibleTranslationRequest;
  function buildOpenAICompatibleTranslationPrompt(items, glossary = null) {
    const rows = items.map(item => ({
      id: item.id,
      text: item.original_text
    }));
    const glossaryPrompt = runtime.glossaryCore.buildPrompt(glossary, items);
    return ["Translate each OCR block into Simplified Chinese as one complete manga bubble or narration box.", "Each input text may contain multiple OCR lines from the same bubble. Understand them together; do not translate line by line mechanically.", "Rewrite word order naturally for Chinese, merge broken OCR fragments when needed, and keep character names and tone natural for manga dialogue.", "If an input contains a model attachment label such as [Image #1], [Image#1], or Image 1, ignore that label and do not output it.", "Preserve the input id exactly. Return one translated_text per id.", "Return JSON only with this schema:", '{"translations":[{"id":"t0","translated_text":"..."}]}', ...(glossaryPrompt ? [glossaryPrompt] : []), "Input:", JSON.stringify(rows)].join("\n");
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
