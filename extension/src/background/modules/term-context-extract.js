const EXTRACT_TIMEOUT_MS = 30000;
const SOURCE_TEXT_LIMIT = 4000;
const SELECTED_LIMIT = 200;
const TERM_LIMIT = 120;

function buildExtractPrompt(sourceText, translatedText, selectedText, targetLanguage) {
  return [
    `韩文原文段落：【${sourceText}】`,
    `其中文译文：【${translatedText}】`,
    `用户选中的中文文本：「${selectedText}」`,
    "请找出原文段落中与选中中文对应的韩文术语（人名、地名、称号等），只返回该术语本身。",
    "若原文中没有对应术语，返回空字符串。",
    `目标语言为 ${targetLanguage}。`,
    '返回 JSON：{"term":"..."}'
  ].join("\n");
}

function containsSourceTerm(sourceText, term) {
  const text = sourceText.normalize("NFKC");
  if (text.includes(term)) {
    return true;
  }
  const stripped = term.replace(/[은는이가을를의에와]$/, "");
  return stripped.length >= 2 && text.includes(stripped);
}

export function installTermContextExtract(runtime) {
  async function handleExtractTermFromContext(message = {}) {
    const sourceText = String(message.sourceText || "").trim().slice(0, SOURCE_TEXT_LIMIT);
    const translatedText = String(message.translatedText || "").trim().slice(0, SOURCE_TEXT_LIMIT);
    const selectedText = String(message.selectedText || "").trim().slice(0, SELECTED_LIMIT);
    const targetLanguage = String(message.targetLanguage || "").trim().slice(0, 40) || "zh-CN";
    if (!sourceText || !selectedText) {
      return {
        ok: false,
        error: "缺少原文段落或选中文字"
      };
    }
    if (runtime.backgroundTestHooks && typeof runtime.backgroundTestHooks.extractTermFromContext === "function") {
      return runtime.backgroundTestHooks.extractTermFromContext({
        sourceText,
        translatedText,
        selectedText,
        targetLanguage
      });
    }
    const configuration = await runtime.loadConfiguration();
    const translation = configuration.translation;
    if (!translation.apiKey) {
      return {
        ok: false,
        error: "请先配置翻译 API Key"
      };
    }
    const body = {
      model: translation.model || runtime.DEFAULT_TRANSLATION_MODEL,
      temperature: 0,
      messages: [{
        role: "system",
        content: "You are a Korean web-novel terminology assistant. Return strict JSON only."
      }, {
        role: "user",
        content: buildExtractPrompt(sourceText, translatedText, selectedText, targetLanguage)
      }],
      response_format: {
        type: "json_object"
      }
    };
    const endpoint = runtime.buildOpenAICompatibleEndpoint(translation.baseUrl);
    try {
      let envelope = await runtime.sendOpenAICompatibleTranslationRequest(
        endpoint, translation.apiKey, body, EXTRACT_TIMEOUT_MS, { includeResponseMeta: true }
      );
      if (!envelope || !envelope.content) {
        const fallback = {
          ...body
        };
        delete fallback.response_format;
        envelope = await runtime.sendOpenAICompatibleTranslationRequest(
          endpoint, translation.apiKey, fallback, EXTRACT_TIMEOUT_MS, { includeResponseMeta: true }
        );
      }
      const content = String(runtime.extractOpenAIMessageText(envelope && envelope.content) || "");
      const parsed = runtime.parseModelJson(content) || {};
      const term = String(parsed.term || "").normalize("NFKC").trim().slice(0, TERM_LIMIT);
      return {
        ok: true,
        term,
        foundInSource: term ? containsSourceTerm(sourceText, term) : false
      };
    } catch (error) {
      return {
        ok: false,
        error: runtime.getErrorMessage(error)
      };
    }
  }
  runtime.handleExtractTermFromContext = handleExtractTermFromContext;
}
