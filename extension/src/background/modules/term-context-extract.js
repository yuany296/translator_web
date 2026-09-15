import { resolveExtractionConfig } from "../../config/store.js";

const EXTRACT_TIMEOUT_MS = 60000;
const SOURCE_TEXT_LIMIT = 4000;
const SELECTED_LIMIT = 200;
const TERM_LIMIT = 120;
const SENTENCE_TERM_LIMIT = 3;

function buildExtractPrompt(sourceText, translatedText, selectedText, targetLanguage) {
  return [
    `原文段落：【${sourceText}】`,
    `其中文译文：【${translatedText}】`,
    `用户选中的文本：「${selectedText}」`,
    "请找出原文段落中与选中文本对应的专有名词（人名、地名、称号等），只返回该术语本身。",
    "「term」必须是原文段落中逐字出现的原文文字（保持原文语言），不要填译文。",
    "若原文中没有对应术语，返回空字符串。",
    `目标语言为 ${targetLanguage}。`,
    '返回 JSON：{"term":"..."}'
  ].join("\n");
}

function buildSentenceTermsPrompt(sourceText, translatedText, targetLanguage) {
  return [
    `源句：【${sourceText}】`,
    `其译文：【${translatedText}】`,
    "请找出这句话中的专有名词与术语（人名、地名、作品名、团体名、英文名等），最多 3 个。",
    "不要输出普通名词、动词或助词。",
    "「term」必须是源句中逐字出现的原文文字（保持原文语言，例如韩文），不要填译文；「target」填对应的目标语言译文。",
    `目标语言为 ${targetLanguage}。`,
    '返回 JSON：{"terms":[{"term":"...","target":"..."}]}',
    "若句中没有专有名词，返回 {\"terms\":[]}。"
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

/**
 * 句子级提取用哪套 AI：设置页里选定的配置库条目（旧存档仍按「跟随翻译服务」解析）。
 * 关掉开关或没选配置都返回 error，文案指向合并后的「翻译服务」页。
 */
function resolveSentenceService(configuration) {
  if ((configuration.runtime || {}).sentenceExtractionEnabled === false) {
    return { llm: null, error: "句子级术语提取已关闭，可在设置页「翻译服务」中开启" };
  }
  const sentence = resolveExtractionConfig(configuration, "sentenceExtraction");
  if (!sentence || !sentence.baseUrl) {
    return { llm: null, error: "未选择句子级术语提取配置，可在设置页「翻译服务」中选择" };
  }
  return {
    llm: {
      baseUrl: sentence.baseUrl,
      model: sentence.model,
      apiKey: String(sentence.apiKey || "")
    },
    error: ""
  };
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
    const { llm, error: serviceError } = resolveSentenceService(configuration);
    if (!llm) {
      return {
        ok: false,
        error: serviceError
      };
    }
    const body = {
      model: llm.model,
      temperature: 0,
      messages: [{
        role: "system",
        content: "You are a web-novel terminology assistant. Return strict JSON only."
      }, {
        role: "user",
        content: buildExtractPrompt(sourceText, translatedText, selectedText, targetLanguage)
      }],
      response_format: {
        type: "json_object"
      }
    };
    const endpoint = runtime.buildOpenAICompatibleEndpoint(llm.baseUrl);
    try {
      let envelope = await runtime.sendOpenAICompatibleTranslationRequest(
        endpoint, llm.apiKey, body, EXTRACT_TIMEOUT_MS, { includeResponseMeta: true }
      );
      if (!envelope || !envelope.content) {
        const fallback = {
          ...body
        };
        delete fallback.response_format;
        envelope = await runtime.sendOpenAICompatibleTranslationRequest(
          endpoint, llm.apiKey, fallback, EXTRACT_TIMEOUT_MS, { includeResponseMeta: true }
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

  async function handleExtractTermsFromSentence(message = {}) {
    const sourceText = String(message.sourceText || "").trim().slice(0, SOURCE_TEXT_LIMIT);
    const translatedText = String(message.translatedText || "").trim().slice(0, SOURCE_TEXT_LIMIT);
    const targetLanguage = String(message.targetLanguage || "").trim().slice(0, 40) || "zh-CN";
    if (!sourceText) {
      return {
        ok: false,
        error: "缺少句子原文"
      };
    }
    if (runtime.backgroundTestHooks && typeof runtime.backgroundTestHooks.extractTermsFromSentence === "function") {
      return runtime.backgroundTestHooks.extractTermsFromSentence({
        sourceText,
        translatedText,
        targetLanguage
      });
    }
    const configuration = await runtime.loadConfiguration();
    const { llm, error: serviceError } = resolveSentenceService(configuration);
    if (!llm) {
      return {
        ok: false,
        error: serviceError
      };
    }
    const body = {
      model: llm.model,
      temperature: 0,
      messages: [{
        role: "system",
        content: "You are a web-novel terminology assistant. Return strict JSON only."
      }, {
        role: "user",
        content: buildSentenceTermsPrompt(sourceText, translatedText, targetLanguage)
      }],
      response_format: {
        type: "json_object"
      }
    };
    const endpoint = runtime.buildOpenAICompatibleEndpoint(llm.baseUrl);
    try {
      let envelope = await runtime.sendOpenAICompatibleTranslationRequest(
        endpoint, llm.apiKey, body, EXTRACT_TIMEOUT_MS, { includeResponseMeta: true }
      );
      if (!envelope || !envelope.content) {
        const fallback = {
          ...body
        };
        delete fallback.response_format;
        envelope = await runtime.sendOpenAICompatibleTranslationRequest(
          endpoint, llm.apiKey, fallback, EXTRACT_TIMEOUT_MS, { includeResponseMeta: true }
        );
      }
      const content = String(runtime.extractOpenAIMessageText(envelope && envelope.content) || "");
      const parsed = runtime.parseModelJson(content) || {};
      const terms = (Array.isArray(parsed.terms) ? parsed.terms : [])
        .filter(item => item && typeof item === "object")
        .map(item => {
          let term = String(item.term || "").normalize("NFKC").trim().slice(0, TERM_LIMIT);
          let target = String(item.target || "").trim().slice(0, TERM_LIMIT);
          // 小模型偶尔把 term/target 填反（term 是译文、target 反而是原文），
          // 此时交换两者，保证 term 是源句中的原文文字。
          if (term && !containsSourceTerm(sourceText, term) && containsSourceTerm(sourceText, target)) {
            const swapped = term;
            term = target;
            target = swapped;
          }
          return {
            term,
            target
          };
        })
        .filter(item => item.term && containsSourceTerm(sourceText, item.term))
        .slice(0, SENTENCE_TERM_LIMIT);
      const seen = new Set();
      const unique = terms.filter(item => {
        const key = String(item.term).toLocaleLowerCase("en-US");
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      return {
        ok: true,
        terms: unique
      };
    } catch (error) {
      return {
        ok: false,
        error: runtime.getErrorMessage(error)
      };
    }
  }
  runtime.handleExtractTermsFromSentence = handleExtractTermsFromSentence;

  async function handleGetLlmModels(message = {}) {
    const baseUrl = String(message.baseUrl || "").trim().replace(/\/+$/, "");
    if (!baseUrl) {
      return { ok: true, models: [] };
    }
    const apiKey = String(message.apiKey || "").trim();
    const headers = apiKey ? { Authorization: `Bearer ${apiKey}` } : {};
    try {
      const { response, payload } = await runtime.fetchJsonWithTimeout(`${baseUrl}/models`, {
        headers
      }, { timeoutMs: 8000, timeoutMessage: "模型列表获取超时" });
      if (!response.ok) {
        return { ok: false, error: `HTTP ${response.status}` };
      }
      const data = payload && payload.data ? payload.data : (payload && payload.models ? payload.models : []);
      const names = (Array.isArray(data) ? data : [])
        .map(item => String(item && (item.id || item.name) || "").trim())
        .filter(Boolean);
      return { ok: true, models: names };
    } catch (error) {
      return { ok: false, error: runtime.getErrorMessage(error) };
    }
  }
  runtime.handleGetLlmModels = handleGetLlmModels;
}
