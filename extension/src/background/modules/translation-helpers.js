export function installTranslationHelpers(runtime) {
  async function sendOpenAICompatibleWithJsonFallback({
    endpoint,
    model,
    apiKey,
    dataUrl,
    prompt,
    requestTimeoutMs
  }) {
    try {
      return await runtime.sendOpenAICompatibleOnce({
        endpoint,
        model,
        apiKey,
        dataUrl,
        prompt,
        useJsonResponseFormat: true,
        requestTimeoutMs
      });
    } catch (error) {
      const reason = runtime.getErrorMessage(error);
      if (!runtime.shouldRetryWithoutJsonResponseFormat(reason)) {
        throw error;
      }
      return runtime.sendOpenAICompatibleOnce({
        endpoint,
        model,
        apiKey,
        dataUrl,
        prompt,
        useJsonResponseFormat: false,
        requestTimeoutMs
      });
    }
  }
  runtime.sendOpenAICompatibleWithJsonFallback = sendOpenAICompatibleWithJsonFallback;
  async function sendOpenAICompatibleOnce({
    endpoint,
    model,
    apiKey,
    dataUrl,
    prompt,
    useJsonResponseFormat,
    requestTimeoutMs = runtime.VISION_OCR_REQUEST_TIMEOUT_MS
  }) {
    const body = {
      model: model || runtime.DEFAULT_VISION_OCR_MODEL,
      temperature: 0,
      messages: [{
        role: "system",
        content: "You are a manga OCR + translation engine. Return JSON only."
      }, {
        role: "user",
        content: [{
          type: "text",
          text: prompt
        }, {
          type: "image_url",
          image_url: {
            url: dataUrl
          }
        }]
      }]
    };
    if (useJsonResponseFormat) {
      body.response_format = {
        type: "json_object"
      };
    }
    const timeoutMs = Math.max(1, Number(requestTimeoutMs) || runtime.VISION_OCR_REQUEST_TIMEOUT_MS);
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
      timeoutMessage: `Vision OCR request timed out after ${timeoutMs}ms`
    });
    if (!response.ok) {
      throw runtime.toProviderError(payload, response.status, response.statusText, "OpenAI-compatible API error");
    }
    const message = payload && payload.choices && payload.choices[0] && payload.choices[0].message;
    const text = runtime.extractOpenAIMessageText(message ? message.content : "").trim();
    if (!text) {
      throw new Error("OpenAI-compatible response is empty");
    }
    return text;
  }
  runtime.sendOpenAICompatibleOnce = sendOpenAICompatibleOnce;
  function buildOpenAICompatibleEndpoint(baseUrl) {
    const normalized = runtime.sanitizeOpenAICompatibleBaseUrl(baseUrl);
    if (!normalized) {
      throw new Error("Base URL is empty");
    }
    return `${normalized}/chat/completions`;
  }
  runtime.buildOpenAICompatibleEndpoint = buildOpenAICompatibleEndpoint;
  function sanitizeOpenAICompatibleBaseUrl(baseUrl) {
    let normalized = String(baseUrl || "").trim().replace(/\/+$/, "");
    normalized = normalized.replace(/\/chat\/completions$/i, "");
    normalized = normalized.replace(/\/responses$/i, "");
    return normalized;
  }
  runtime.sanitizeOpenAICompatibleBaseUrl = sanitizeOpenAICompatibleBaseUrl;
  function ensureOpenAICompatibleError(reason) {
    const text = String(reason || "Unknown error");
    if (/^OpenAI-compatible API error:/i.test(text)) {
      return text;
    }
    return `OpenAI-compatible API error: ${text}`;
  }
  runtime.ensureOpenAICompatibleError = ensureOpenAICompatibleError;
  function parseModelJson(rawText) {
    const text = String(rawText || "").trim();
    if (!text) {
      throw new Error("Model output is empty");
    }
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const candidate = fenced ? fenced[1].trim() : text;
    const start = candidate.indexOf("{");
    const end = candidate.lastIndexOf("}");
    if (start < 0 || end <= start) {
      throw new Error("Model output does not contain valid JSON object");
    }
    const jsonText = candidate.slice(start, end + 1);
    return JSON.parse(jsonText);
  }
  runtime.parseModelJson = parseModelJson;
  function normalizeBgType(value) {
    const text = String(value || "").trim().toLowerCase();
    if (text === "solid" || text === "transparent" || text === "none") {
      return text;
    }
    return "solid";
  }
  runtime.normalizeBgType = normalizeBgType;
  function cleanDecorativeSymbols(text) {
    if (!text) {
      return "";
    }
    return String(text).replace(/[♪♫♩♬♭♯𝄞]/gu, "").replace(runtime.MODEL_IMAGE_PLACEHOLDER_BRACKET_RE, " ").replace(/\s+/g, " ").trim().replace(runtime.MODEL_IMAGE_PLACEHOLDER_ONLY_RE, "");
  }
  runtime.cleanDecorativeSymbols = cleanDecorativeSymbols;
  function isModelImagePlaceholderOnly(text) {
    const compact = String(text || "").trim().replace(runtime.MODEL_IMAGE_PLACEHOLDER_BRACKET_RE, " ").replace(/\s+/g, " ").trim();
    return runtime.MODEL_IMAGE_PLACEHOLDER_ONLY_RE.test(compact);
  }
  runtime.isModelImagePlaceholderOnly = isModelImagePlaceholderOnly;
  function shouldDropSymbolOnlyBubble(item) {
    const original = String(item && item.original_text ? item.original_text : "").trim();
    const translated = String(item && item.translated_text ? item.translated_text : "").trim();
    if (!original && !translated) {
      return true;
    }
    if (runtime.isSymbolOnlyText(original) && runtime.isSymbolOnlyText(translated)) {
      return true;
    }
    return false;
  }
  runtime.shouldDropSymbolOnlyBubble = shouldDropSymbolOnlyBubble;
  function shouldDropMeaninglessAlphabeticBubble(item) {
    const original = String(item && item.original_text ? item.original_text : "").trim();
    const translated = String(item && item.translated_text ? item.translated_text : "").trim();
    if (!original) {
      return false;
    }
    const originalCompact = original.replace(/\s+/g, "");
    const translatedCompact = translated.replace(/\s+/g, "");
    if (!runtime.isLatinOnlyFragment(originalCompact)) {
      return false;
    }
    if (runtime.isMeaningfulLatinToken(originalCompact)) {
      return false;
    }
    const lowerOriginal = originalCompact.toLowerCase();
    const lowerTranslated = translatedCompact.toLowerCase();

    // Very short alphabetic fragments are usually OCR noise.
    if (lowerOriginal.length <= 2) {
      return true;
    }

    // Repeated same letter (aaa/zzz) tends to be decorative noise.
    if (/^(.)\1{2,}$/i.test(lowerOriginal)) {
      return true;
    }

    // Common meaningless filler tokens.
    if (/^(ah|oh|uh|hm|hmm|mm|ng|ha|haha|heh|eh|uhh|huh|zzz|lol|wow)$/i.test(lowerOriginal)) {
      return true;
    }

    // If model effectively kept the same Latin text, treat short fragments as noise.
    if (lowerTranslated === lowerOriginal && lowerOriginal.length <= 7) {
      return true;
    }

    // Consonant-heavy short tokens are likely OCR artifacts.
    if (lowerOriginal.length <= 6 && !/[aeiou]/i.test(lowerOriginal)) {
      return true;
    }
    return false;
  }
  runtime.shouldDropMeaninglessAlphabeticBubble = shouldDropMeaninglessAlphabeticBubble;
  function shouldDropLocalPaddleCandidateBubble(item, imageSize) {
    const text = String(item && item.original_text ? item.original_text : "").replace(/\s+/g, "");
    if (!text) {
      return true;
    }
    if (runtime.isLikelyMojibakeShortOcrText(text)) {
      return true;
    }
    const box = runtime.getNormalizedCandidatePixelBox(item, imageSize);
    if (!box) {
      return true;
    }
    if (runtime.isReliableShortSpeechBubbleItem(item)) {
      return false;
    }
    const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
    const areaRatio = box.width * box.height / Math.max(1, imageWidth * imageHeight);
    const score = Number(item.confidence || 0);
    const scriptChars = runtime.countScriptChars(text);
    const meaningfulText = runtime.isMeaningfulOcrText(text);
    const hangulChars = (text.match(/[\uac00-\ud7af]/g) || []).length;
    const cjkChars = (text.match(/[\u4e00-\u9fff]/g) || []).length;
    const digitChars = (text.match(/\d/g) || []).length;
    const compactText = text.replace(/[^\uac00-\ud7af\u3040-\u30ff\u4e00-\u9fffA-Za-z0-9]/g, "");
    const verySmall = areaRatio < 0.0045 || box.width < imageWidth * 0.065 || box.height < imageHeight * 0.018;
    if (/^\d+$/.test(text) && text.length <= 3) {
      return true;
    }
    if (digitChars >= 1 && compactText.length <= 2 && areaRatio < 0.01) {
      return true;
    }
    if (!meaningfulText && scriptChars <= 1 && areaRatio < 0.012) {
      return true;
    }
    if (scriptChars <= 2 && verySmall && score < 0.96 && !runtime.isReliableMeaningfulShortOcrText(text)) {
      return true;
    }
    if (hangulChars === 0 && cjkChars > 0 && text.length <= 4 && areaRatio < 0.02) {
      return true;
    }
    if (hangulChars === 0 && scriptChars <= 3 && score < 0.82) {
      return true;
    }
    return false;
  }
  runtime.shouldDropLocalPaddleCandidateBubble = shouldDropLocalPaddleCandidateBubble;
  function getNormalizedCandidatePixelBox(item, imageSize) {
    if (item && item.rawBox) {
      const left = Number(item.rawBox.left || 0);
      const top = Number(item.rawBox.top || 0);
      const width = Number(item.rawBox.width || 0);
      const height = Number(item.rawBox.height || 0);
      if (width > 0 && height > 0) {
        return runtime.buildBaiduBox(left, top, left + width, top + height);
      }
    }
    const imageWidth = Math.max(1, Number(imageSize && imageSize.width) || 1);
    const imageHeight = Math.max(1, Number(imageSize && imageSize.height) || 1);
    const left = Number(item && item.x) / 100 * imageWidth;
    const top = Number(item && item.y) / 100 * imageHeight;
    const width = Number(item && item.w) / 100 * imageWidth;
    const height = Number(item && item.h) / 100 * imageHeight;
    if (!(width > 0 && height > 0)) {
      return null;
    }
    return runtime.buildBaiduBox(left, top, left + width, top + height);
  }
  runtime.getNormalizedCandidatePixelBox = getNormalizedCandidatePixelBox;
  function coalesceOverlappingOcrCandidates(candidates) {
    const groups = (Array.isArray(candidates) ? candidates : []).filter(item => item && runtime.getPercentBubbleBox(item)).map(item => [item]);
    let changed = true;
    while (changed) {
      changed = false;
      for (let leftIndex = 0; leftIndex < groups.length; leftIndex += 1) {
        for (let rightIndex = leftIndex + 1; rightIndex < groups.length; rightIndex += 1) {
          if (!runtime.shouldCoalesceOcrCandidateGroups(groups[leftIndex], groups[rightIndex])) {
            continue;
          }
          groups[leftIndex].push(...groups[rightIndex]);
          groups.splice(rightIndex, 1);
          changed = true;
          rightIndex -= 1;
        }
      }
    }
    return groups.map((group, index) => runtime.mergeOcrCandidateGroup(group, index)).sort((left, right) => left.y - right.y || left.x - right.x);
  }
  runtime.coalesceOverlappingOcrCandidates = coalesceOverlappingOcrCandidates;
}
