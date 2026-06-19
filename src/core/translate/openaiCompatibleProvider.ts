import type { TranslateOptions } from "../types";
import type { TranslatorProvider } from "./TranslatorProvider";
import { buildMangaTranslationPrompt } from "./TranslatorProvider";

interface ChatChoice {
  message?: {
    content?: string;
  };
}

export class OpenAICompatibleProvider implements TranslatorProvider {
  name = "OpenAI-compatible";
  type = "openai-compatible";

  async translate(text: string, options: TranslateOptions): Promise<string> {
    const [translated] = await this.translateBatch([text], options);
    return translated || text;
  }

  async translateBatch(texts: string[], options: TranslateOptions): Promise<string[]> {
    if (texts.length === 0) {
      return [];
    }
    if (!options.apiKey) {
      throw new Error("OpenAI-compatible API Key 未配置");
    }
    if (!options.baseUrl) {
      throw new Error("OpenAI-compatible Base URL 未配置");
    }

    const endpoint = `${sanitizeBaseUrl(options.baseUrl)}/v1/chat/completions`;
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${options.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: options.model || "deepseek-chat",
        temperature: 0.2,
        messages: [
          {
            role: "system",
            content:
              "You translate manga dialogue. Return strict JSON only, no markdown. The JSON must be an array of translated strings with the same length and order as input."
          },
          {
            role: "user",
            content: buildBatchPrompt(texts, options.targetLanguage)
          }
        ]
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`OpenAI-compatible 翻译失败：${payload.error?.message || response.statusText}`);
    }
    return normalizeTranslations((payload.choices as ChatChoice[] | undefined)?.[0]?.message?.content, texts);
  }
}

function buildBatchPrompt(texts: string[], targetLanguage: string): string {
  const source = texts.map((text, index) => ({ id: index, text }));
  return `${buildMangaTranslationPrompt(JSON.stringify(source, null, 2), targetLanguage)}

请只输出 JSON 字符串数组，例如 ["译文1","译文2"]，数量和顺序必须与原数组一致。`;
}

function normalizeTranslations(raw: unknown, fallback: string[]): string[] {
  const text = String(raw || "").trim();
  const start = text.indexOf("[");
  const end = text.lastIndexOf("]");
  if (start >= 0 && end > start) {
    try {
      const parsed = JSON.parse(text.slice(start, end + 1));
      if (Array.isArray(parsed)) {
        return fallback.map((source, index) => String(parsed[index] || source).trim() || source);
      }
    } catch {
      // 解析失败时走降级，避免静默吞错。
    }
  }
  if (fallback.length === 1 && text) {
    return [text];
  }
  return fallback;
}

function sanitizeBaseUrl(value: string): string {
  return String(value || "").replace(/\/+$/, "");
}
