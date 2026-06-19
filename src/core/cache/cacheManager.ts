import type { OCRTranslateResult } from "../types";

const CACHE_PREFIX = "mangaTranslator.cache.v1:";

export interface CacheStats {
  entries: number;
}

export interface TranslationCacheKeyInput {
  sourceUrl: string;
  width: number;
  height: number;
  ocrProvider: string;
  translatorProvider: string;
  targetLanguage: string;
  model: string;
}

export async function getCachedTranslation(key: string): Promise<OCRTranslateResult | null> {
  const data = await chrome.storage.local.get(key);
  return (data[key] as OCRTranslateResult | undefined) || null;
}

export async function setCachedTranslation(key: string, value: OCRTranslateResult): Promise<void> {
  await chrome.storage.local.set({ [key]: value });
}

export async function clearTranslationCache(): Promise<CacheStats> {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((key) => key.startsWith(CACHE_PREFIX));
  if (keys.length > 0) {
    await chrome.storage.local.remove(keys);
  }
  return { entries: keys.length };
}

export async function getCacheStats(): Promise<CacheStats> {
  const all = await chrome.storage.local.get(null);
  return {
    entries: Object.keys(all).filter((key) => key.startsWith(CACHE_PREFIX)).length
  };
}

export function buildTranslationCacheKey(input: TranslationCacheKeyInput): string {
  const raw = [
    input.sourceUrl,
    input.width,
    input.height,
    input.ocrProvider,
    input.translatorProvider,
    input.targetLanguage,
    input.model
  ].join("|");
  return `${CACHE_PREFIX}${hashString(raw)}`;
}

function hashString(value: string): string {
  let hash = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16);
}
