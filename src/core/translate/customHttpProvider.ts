import type { TranslateOptions } from "../types";
import type { TranslatorProvider } from "./TranslatorProvider";

export class CustomHttpTranslatorProvider implements TranslatorProvider {
  name = "Custom HTTP Translator";
  type = "custom-http";

  async translate(text: string, options: TranslateOptions): Promise<string> {
    const [translated] = await this.translateBatch([text], options);
    return translated || text;
  }

  async translateBatch(texts: string[], options: TranslateOptions): Promise<string[]> {
    if (!options.customTranslateUrl) {
      throw new Error("自定义翻译接口地址未配置");
    }
    const response = await fetch(options.customTranslateUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...parseHeaders(options.customTranslateHeaders)
      },
      body: renderTemplate(options.customTranslateBodyTemplate || "{\"texts\":{{textsJson}}}", {
        textsJson: JSON.stringify(texts),
        targetLanguage: options.targetLanguage,
        sourceLanguage: options.sourceLanguage
      })
    });
    const payload = await response.json();
    if (!response.ok) {
      throw new Error(`自定义翻译请求失败：${payload.error || response.statusText}`);
    }
    const results = Array.isArray(payload.translations)
      ? payload.translations
      : Array.isArray(payload.results)
        ? payload.results
        : Array.isArray(payload)
          ? payload
          : [];
    return texts.map((text, index) => String(results[index] || text).trim() || text);
  }
}

function parseHeaders(value?: string): Record<string, string> {
  if (!value) {
    return {};
  }
  try {
    const parsed = JSON.parse(value) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).map(([key, headerValue]) => [key, String(headerValue)]));
  } catch {
    return {};
  }
}

function renderTemplate(template: string, values: Record<string, string>): string {
  return Object.entries(values).reduce(
    (current, [key, value]) => current.replaceAll(`{{${key}}}`, value),
    template
  );
}
