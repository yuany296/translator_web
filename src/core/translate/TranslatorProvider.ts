import type { TranslateOptions, TranslatorProviderType } from "../types";

export interface TranslatorProvider {
  name: string;
  type: TranslatorProviderType;
  translate(text: string, options: TranslateOptions): Promise<string>;
  translateBatch(texts: string[], options: TranslateOptions): Promise<string[]>;
}

export function buildMangaTranslationPrompt(text: string, targetLanguage: string): string {
  return [
    `你是专业漫画翻译助手。请把以下漫画对白翻译成${targetLanguage}。`,
    "要求：",
    "1. 保留人物语气。",
    "2. 语言自然，适合漫画气泡。",
    "3. 不要添加解释。",
    "4. 不要输出引号。",
    "5. 如果是拟声词，也翻译成适合漫画场景的表达。",
    "原文：",
    text
  ].join("\n");
}
