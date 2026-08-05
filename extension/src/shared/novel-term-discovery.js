const DEFAULT_MAX_BLOCKS = 60;

/**
 * 采样已翻译的小说段落用于术语发现：等距抽样，章节首段（标题段，书名
 * 噪音集中处）必含；段落数不超过 maxBlocks 时全量返回。
 */
function sampleTranslatedParagraphs(chapter = {}, translations = null, maxBlocks = DEFAULT_MAX_BLOCKS) {
  const limit = Math.max(1, Math.floor(Number(maxBlocks) || DEFAULT_MAX_BLOCKS));
  const map = translations instanceof Map ? translations : new Map();
  const pool = (Array.isArray(chapter.paragraphs) ? chapter.paragraphs : [])
    .filter(item => map.has(item && item.id))
    .map(item => ({
      id: String(item.paragraphKey || item.id || "").trim(),
      originalText: String(item.original_text || "").trim(),
      translatedText: String(map.get(item.id) || "").trim()
    }))
    .filter(block => block.id && block.originalText && block.translatedText);
  if (pool.length <= limit) {
    return pool;
  }
  const step = pool.length / limit;
  const picked = [];
  for (let index = 0; index < limit; index += 1) {
    picked.push(pool[Math.min(pool.length - 1, Math.floor(index * step))]);
  }
  return picked;
}

/** 构造小说术语发现消息：targetKey 带 novel- 前缀，携带自动忽略来源（小说名）。 */
function buildNovelDiscoveryMessage(chapter = {}, blocks = [], pageUrl = "", pageTitle = "") {
  return {
    type: "DISCOVER_TERMS",
    pageUrl: String(pageUrl || ""),
    pageTitle: String(pageTitle || ""),
    targetKey: `novel-${String(chapter.scopeKey || "")}:${String(chapter.chapterId || "")}`,
    blocks,
    autoIgnoreSources: [String(chapter.seriesTitle || "").trim()].filter(Boolean)
  };
}

export default Object.freeze({
  DEFAULT_MAX_BLOCKS,
  sampleTranslatedParagraphs,
  buildNovelDiscoveryMessage
});
