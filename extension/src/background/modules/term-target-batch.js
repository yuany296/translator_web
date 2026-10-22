import keys from "../../shared/term-discovery-keys.js";
import pendingCore from "../../shared/term-discovery-pending.js";

/** 一次请求最多问几个词：太多小模型会漏编号，太少则整章要来回十几趟。 */
const MAX_ITEMS_PER_REQUEST = 20;
const BATCH_TIMEOUT_MS = 90000;
const TERM_LIMIT = 120;
const CONTEXT_LIMIT = 160;
const CONTEXT_MAX = 2;

/**
 * 待补译名的词表归一化：去空、按 sourceKey 去重、截断到一次能问完的量。
 * `id` 是给模型看的编号（从 1 起），回来时优先靠它对齐 —— 小模型对齐编号比对齐原文稳。
 */
export function normalizeBatchItems(raw) {
  const items = [];
  const seen = new Set();
  for (const value of Array.isArray(raw) ? raw : []) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const source = keys.normalizeSource(value.source || value.term);
    if (!source) {
      continue;
    }
    const sourceKey = keys.getSourceKey(source);
    if (seen.has(sourceKey)) {
      continue;
    }
    seen.add(sourceKey);
    const contexts = (Array.isArray(value.contexts) ? value.contexts : [])
      .map(item => String(item && (item.originalText || item.original_text) || "").trim().slice(0, CONTEXT_LIMIT))
      .filter(Boolean)
      .slice(0, CONTEXT_MAX);
    items.push({
      id: items.length + 1,
      source,
      sourceKey,
      kind: String(value.kind || "proper_noun").trim().slice(0, 40),
      contexts
    });
    if (items.length >= MAX_ITEMS_PER_REQUEST) {
      break;
    }
  }
  return items;
}

export function buildTermTargetsPrompt({ items, targetLanguage }) {
  const lines = [
    `下面是一部小说里的专有名词，共 ${items.length} 个，请给每个词一个${targetLanguage}译名。`,
    "要求：",
    "- 人名用音译，地名/组织名可意译或音译，符合中文小说译名习惯；",
    "- 每个词只给一个译名，不要列备选、不要加括号注释；",
    "- 严格按下面的编号作答，不要新增、不要漏掉；",
    "- 「source」原样照抄，不要改写原文。",
    "",
    "词表："
  ];
  for (const item of items) {
    const sample = item.contexts.length > 0 ? `｜例句：${item.contexts[0]}` : "";
    lines.push(`${item.id}. ${item.source}（${item.kind}）${sample}`);
  }
  lines.push(
    "",
    `目标语言为 ${targetLanguage}。`,
    '返回 JSON：{"terms":[{"id":1,"source":"原文","target":"译名"}]}'
  );
  return lines.join("\n");
}

function parseJsonLoose(content) {
  const text = String(content || "").trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  // 先当整段就是 JSON 解析 —— 模型偶尔直接吐裸数组，先截取大括号会把它变成单个对象。
  try {
    return JSON.parse(text);
  } catch {
    // 落到下面的「截首尾大括号」兜底：模型爱在 JSON 前后加解释文字。
  }
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start < 0 || end <= start) {
    return null;
  }
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
}

/**
 * 把模型输出对齐回本批词表：先认 `id`，id 缺失或对不上时退回用原文 sourceKey 对齐。
 * 两点会直接丢掉一条：译名为空、译名和原文一模一样（模型把原文抄了回来，不是译名）。
 */
export function parseTermTargets(content, items) {
  const list = normalizeBatchItems(items);
  const parsed = typeof content === "string" ? parseJsonLoose(content) : content;
  const rows = Array.isArray(parsed)
    ? parsed
    : (parsed && typeof parsed === "object" && Array.isArray(parsed.terms) ? parsed.terms : []);
  const byId = new Map(list.map(item => [String(item.id), item]));
  const bySourceKey = new Map(list.map(item => [item.sourceKey, item]));
  const filled = [];
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row !== "object") {
      continue;
    }
    const sourceText = keys.normalizeSource(row.source || row.term || "");
    const target = String(row.target || row.translation || "").normalize("NFKC").trim().slice(0, TERM_LIMIT);
    const match = byId.get(String(row.id || "").trim())
      || (sourceText ? bySourceKey.get(keys.getSourceKey(sourceText)) : null)
      // 只问了一个词时模型常常省掉 id 和 source，直接认下唯一的那条。
      || (list.length === 1 ? list[0] : null);
    if (!match || !target || seen.has(match.sourceKey)) {
      continue;
    }
    if (keys.getSourceKey(target) === match.sourceKey) {
      continue;
    }
    seen.add(match.sourceKey);
    filled.push({
      source: match.source,
      sourceKey: match.sourceKey,
      target
    });
  }
  return filled;
}

/**
 * 把译名落到待确认候选上 —— **只补空的**。
 *
 * `suggestedTargets.length > 0` 就代表这条已经有译名（用户手填的、或者上一次补全的结果），
 * 一律不动；这是「不覆盖用户填写」的唯一判据，别改成看 `note` 或 `updatedAt`。
 * 章节的 `updatedAt` 也不动：它代表「这一章有新的候选」，补译名不是新候选。
 */
export function applyFilledTargets(storeValue, options = {}) {
  const chapterKey = String(options.chapterKey || "").trim();
  const entries = Array.isArray(options.entries) ? options.entries : [];
  const now = Math.max(0, Number(options.now) || 0);
  const store = pendingCore.normalizePendingStore(storeValue);
  const summary = { filled: [], skippedExisting: 0, missing: 0, empty: 0 };
  const chapter = store.chapters.find(item => item.key === chapterKey);
  if (!chapter || entries.length === 0) {
    return { store, ...summary };
  }
  const indexBySourceKey = new Map(chapter.candidates.map((candidate, index) => [candidate.sourceKey, index]));
  const candidates = [...chapter.candidates];
  let changed = false;
  for (const entry of entries) {
    const sourceKey = keys.getSourceKey(entry && (entry.sourceKey || entry.source));
    const index = indexBySourceKey.has(sourceKey) ? indexBySourceKey.get(sourceKey) : -1;
    if (index < 0) {
      summary.missing += 1;
      continue;
    }
    const candidate = candidates[index];
    if (candidate.suggestedTargets.length > 0) {
      summary.skippedExisting += 1;
      continue;
    }
    const target = String(entry && entry.target || "").normalize("NFKC").trim().slice(0, TERM_LIMIT);
    if (!target || keys.getSourceKey(target) === candidate.sourceKey) {
      summary.empty += 1;
      continue;
    }
    candidates[index] = pendingCore.normalizePendingCandidate({
      ...candidate,
      suggestedTargets: [target],
      updatedAt: now
    }) || candidate;
    summary.filled.push({ source: candidate.source, target });
    changed = true;
  }
  if (!changed) {
    return { store, ...summary };
  }
  return {
    store: pendingCore.normalizePendingStore({
      ...store,
      updatedAt: now,
      chapters: store.chapters.map(item => (item.key === chapterKey ? { ...item, candidates } : item))
    }),
    ...summary
  };
}

function normalizeDrafts(raw) {
  return (Array.isArray(raw) ? raw : [])
    .map(item => ({
      source: keys.normalizeSource(item && item.source),
      target: String(item && item.target || "").normalize("NFKC").trim().slice(0, TERM_LIMIT)
    }))
    .filter(item => item.source && item.target);
}

export function installTermTargetBatch(runtime) {
  /** 缺译名的候选（`suggestedTargets` 为空），顺便当作「还剩多少没补」的计数口径。 */
  function emptyTargetCandidates(chapter) {
    if (!chapter) {
      return [];
    }
    return chapter.candidates
      .filter(candidate => candidate.suggestedTargets.length === 0)
      .map(candidate => ({ source: candidate.source, kind: candidate.kind, contexts: candidate.contexts }));
  }

  /** 读最新存档 → 只补空 → 有变化才写。必须在 mutation 队列里调用。 */
  async function applyEntriesNow(chapterKey, entries) {
    const stored = await runtime.storageGet([runtime.STORAGE_KEYS.glossaryPending]);
    const applied = applyFilledTargets(stored[runtime.STORAGE_KEYS.glossaryPending], {
      chapterKey,
      entries,
      now: Date.now()
    });
    if (applied.filled.length > 0) {
      await runtime.storageSet({ [runtime.STORAGE_KEYS.glossaryPending]: applied.store });
    }
    return applied;
  }

  function chapterKeyOf(message) {
    return keys.getChapterKey(String(message.chapterKey || message.pageUrl || "").trim());
  }

  /**
   * 页面手填的值先落盘，再谈批量补全 —— 这样补全的「只补空的」判据才成立，
   * 否则刚填的那几条会被当成空条目重新问一遍，回填后覆盖掉用户输入。
   */
  async function handleSavePendingTargetDrafts(message = {}) {
    const chapterKey = chapterKeyOf(message);
    const entries = normalizeDrafts(message.drafts);
    if (!entries.length) {
      return { ok: true, filled: 0 };
    }
    return runtime.enqueueTermDiscoveryMutation(async () => {
      const applied = await applyEntriesNow(chapterKey, entries);
      return {
        ok: true,
        filled: applied.filled.length,
        skippedExisting: applied.skippedExisting,
        pendingCount: pendingCore.getPendingCount(applied.store)
      };
    });
  }
  runtime.handleSavePendingTargetDrafts = handleSavePendingTargetDrafts;

  /**
   * 批量补译名：一次最多 20 个词，由页面循环调用直到 `remaining` 为 0。
   * LLM 那一段特别慢（90 秒量级），绝不能进 mutation 队列 —— 那条队列和「加入」
   * 按钮共用，卡住就表现为术语库页点不动（见 term-discovery.js 的双队列说明）。
   */
  async function handleExtractTermTargets(message = {}) {
    const chapterKey = chapterKeyOf(message);
    const stored = await runtime.storageGet([runtime.STORAGE_KEYS.glossaryPending]);
    const pendingStore = pendingCore.normalizePendingStore(stored[runtime.STORAGE_KEYS.glossaryPending]);
    const chapter = pendingStore.chapters.find(item => item.key === chapterKey);
    if (!chapter) {
      return { ok: false, error: "这一章还没有候选术语" };
    }
    const items = normalizeBatchItems(
      Array.isArray(message.items) && message.items.length > 0 ? message.items : emptyTargetCandidates(chapter)
    );
    if (!items.length) {
      return { ok: true, filled: [], filledCount: 0, remaining: 0, done: true };
    }
    const configuration = await runtime.loadConfiguration();
    // 调用方不传目标语言时跟着设置页的翻译目标语走，而不是硬写 zh-CN。
    const targetLanguage = String(message.targetLanguage || "").trim().slice(0, 40)
      || String((configuration.translation || {}).targetLanguage || "").trim()
      || "zh-CN";
    const service = runtime.resolveSentenceService(configuration);
    if (!service.llm) {
      return { ok: false, error: service.error };
    }
    const llm = service.llm;
    const body = {
      model: llm.model,
      temperature: 0,
      messages: [{
        role: "system",
        content: "You are a web-novel terminology assistant. Return strict JSON only."
      }, {
        role: "user",
        content: buildTermTargetsPrompt({ items, targetLanguage })
      }],
      ...llm.thinkingFields,
      response_format: {
        type: "json_object"
      }
    };
    const endpoint = runtime.buildOpenAICompatibleEndpoint(llm.baseUrl);
    let content = "";
    try {
      // 思考参数 / json 模式被服务商拒了就按组剥掉重发（见 translation-utils.js）
      const sent = await runtime.sendTranslationBodyWithFallbacks(
        endpoint, llm.apiKey, body, BATCH_TIMEOUT_MS, { includeResponseMeta: true }
      );
      content = String(runtime.extractOpenAIMessageText(sent.envelope && sent.envelope.content) || "");
    } catch (error) {
      return { ok: false, error: runtime.getErrorMessage(error) };
    }
    const entries = parseTermTargets(content, items);
    const applied = await runtime.enqueueTermDiscoveryMutation(() => applyEntriesNow(chapterKey, entries));
    const nextChapter = applied.store.chapters.find(item => item.key === chapterKey);
    return {
      ok: true,
      requested: items.length,
      filled: applied.filled,
      filledCount: applied.filled.length,
      skippedExisting: applied.skippedExisting,
      missing: applied.missing,
      empty: applied.empty,
      // 问了 20 个只回来 15 条时，那 5 个这次没译名，账要能对上。
      unreturned: Math.max(0, items.length - entries.length),
      remaining: emptyTargetCandidates(nextChapter).length,
      pendingCount: pendingCore.getPendingCount(applied.store)
    };
  }
  runtime.handleExtractTermTargets = handleExtractTermTargets;
}

export default Object.freeze({
  MAX_ITEMS_PER_REQUEST,
  BATCH_TIMEOUT_MS,
  normalizeBatchItems,
  buildTermTargetsPrompt,
  parseTermTargets,
  applyFilledTargets
});
