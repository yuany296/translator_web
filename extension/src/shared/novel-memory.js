const STORAGE_KEY = "mt_novel_memory_v1";
// v2：每条快照新增 delta（本话自己新增的部分）。旧数据没有 delta 也能读（memory 当基线），所以不需要迁移。
const SCHEMA_VERSION = 2;
const MAX_BOOKS = 100;
const MAX_CHECKPOINTS = 160;
const LIST_LIMIT = 120;
const SUMMARY_LIMIT = 6000;
// 注入提示词时的上限（比存档上限紧得多：存档留全，进提示词只带最有用的部分）
const PROMPT_SUMMARY_LIMIT = 1200;
const PROMPT_LIST_LIMIT = 24;
const PROMPT_MAX_CHARS = 4000;

function cleanText(value, limit = 600) {
  return String(value || "").replace(/\r\n?/gu, "\n").trim().slice(0, limit);
}

function normalizeList(value, limit = LIST_LIMIT) {
  const seen = new Set();
  const result = [];
  for (const raw of Array.isArray(value) ? value : []) {
    const item = typeof raw === "string" ? cleanText(raw) : normalizeRecord(raw);
    const key = typeof item === "string" ? item : JSON.stringify(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    result.push(item);
    if (result.length >= limit) break;
  }
  return result;
}

function normalizeRecord(value) {
  if (!value || typeof value !== "object") return "";
  const record = {};
  for (const key of ["source", "target", "name", "description", "note", "subject", "object", "relation"]) {
    const text = cleanText(value[key], 400);
    if (text) record[key] = text;
  }
  return Object.keys(record).length ? record : "";
}

function normalizeMemory(value) {
  return {
    summary: cleanText(value && value.summary, SUMMARY_LIMIT),
    characters: normalizeList(value && value.characters),
    relationships: normalizeList(value && value.relationships),
    honorifics: normalizeList(value && value.honorifics),
    unresolved: normalizeList(value && value.unresolved)
  };
}

/**
 * 话号解析（唯一规则）：只有有限的正数才算话号。
 * null / 0 / 空串一律当「没认出来」——早先 Number(null)===0 会被当成第 0 话，
 * 在章节序里排在所有真实章节之前，于是被当成「前面的记忆」喂给每一话，回顾时就前后颠倒。
 */
function checkpointOrder(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  const order = Number(value);
  return Number.isFinite(order) && order > 0 ? order : null;
}

function normalizeCheckpoint(value) {
  const chapterId = cleanText(value && value.chapterId, 160);
  if (!chapterId) return null;
  const rawDelta = value && value.delta;
  return {
    chapterId,
    chapterTitle: cleanText(value && value.chapterTitle, 300),
    chapterOrder: checkpointOrder(value && value.chapterOrder),
    revision: Math.max(1, Math.floor(Number(value && value.revision) || 1)),
    updatedAt: Math.max(0, Math.floor(Number(value && value.updatedAt) || 0)),
    // 本话自己新增的部分（「可拆分」就靠它）。旧数据没这个字段 → null：
    // 那时的 memory 就是「当时的累计」，会按基线处理，不会丢也不会重复。
    delta: rawDelta ? normalizeMemory(rawDelta) : null,
    memory: normalizeMemory(value && value.memory)
  };
}

function normalizeBook(value) {
  const key = cleanText(value && value.key, 180);
  if (!key) return null;
  const byChapter = new Map();
  for (const raw of Array.isArray(value.checkpoints) ? value.checkpoints : []) {
    const checkpoint = normalizeCheckpoint(raw);
    if (checkpoint) byChapter.set(checkpoint.chapterId, checkpoint);
  }
  const checkpoints = [...byChapter.values()]
    .sort(compareCheckpoints)
    .slice(-MAX_CHECKPOINTS);
  return {
    key,
    seriesId: cleanText(value.seriesId, 120),
    title: cleanText(value.title, 300),
    revision: Math.max(0, Math.floor(Number(value.revision) || 0)),
    updatedAt: Math.max(0, Math.floor(Number(value.updatedAt) || 0)),
    checkpoints
  };
}

function normalizeStore(value) {
  const books = [];
  for (const raw of value && Array.isArray(value.books) ? value.books : []) {
    const book = normalizeBook(raw);
    if (book) books.push(book);
  }
  books.sort((left, right) => right.updatedAt - left.updatedAt);
  return {
    version: SCHEMA_VERSION,
    updatedAt: Math.max(0, Math.floor(Number(value && value.updatedAt) || 0)),
    books: books.slice(0, MAX_BOOKS)
  };
}

function compareCheckpoints(left, right) {
  const leftOrder = checkpointOrder(left.chapterOrder);
  const rightOrder = checkpointOrder(right.chapterOrder);
  if (leftOrder !== null && rightOrder !== null && leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.updatedAt - right.updatedAt || left.chapterId.localeCompare(right.chapterId);
}

function getBook(value, key) {
  const normalizedKey = cleanText(key, 180);
  return normalizeStore(value).books.find(book => book.key === normalizedKey) || null;
}

/**
 * 到某一话为止的累计记忆：按话号从小到大，把各话「本话新增」叠起来。
 * 旧数据（没有 delta）的 memory 本身就是「当时的累计」→ 直接当基线替换，避免摘要重复叠加。
 */
function cumulativeMemory(book, orderLimit, excludeChapterId = "") {
  const limit = checkpointOrder(orderLimit);
  if (!book || limit === null) {
    return normalizeMemory(null);
  }
  const chapters = book.checkpoints
    .filter(item => item.chapterId !== excludeChapterId)
    .filter(item => {
      const order = checkpointOrder(item.chapterOrder);
      return order !== null && order < limit;
    })
    .sort(compareCheckpoints);
  let state = normalizeMemory(null);
  for (const chapter of chapters) {
    state = chapter.delta ? mergeMemory(state, chapter.delta) : chapter.memory;
  }
  return state;
}

function getContext(value, key, chapter) {
  const book = getBook(value, key);
  if (!book) return { revision: 0, memory: normalizeMemory(null), checkpoint: null };
  const chapterId = cleanText(chapter && chapter.chapterId, 160);
  const order = checkpointOrder(chapter && chapter.chapterOrder);
  const current = normalizeMemory(null);
  // 话号认不出来时宁可不带记忆，也不能把后面的剧情喂给前面。
  if (order === null) {
    return { revision: book.revision, memory: current, checkpoint: null, ownCheckpoint: null };
  }
  const earlier = book.checkpoints
    .filter(item => item.chapterId !== chapterId)
    .filter(item => {
      const candidateOrder = checkpointOrder(item.chapterOrder);
      return candidateOrder !== null && candidateOrder < order;
    })
    .sort(compareCheckpoints);
  const own = book.checkpoints.find(item => item.chapterId === chapterId) || null;
  // 本话自己已有的记忆也带上：同一话不可能是「后面的剧情」，补翻/重翻时才不会把学过的东西丢掉。
  const memory = !own
    ? cumulativeMemory(book, order, chapterId)
    : (own.delta ? mergeMemory(cumulativeMemory(book, order, chapterId), own.delta) : own.memory);
  return {
    revision: book.revision,
    memory,
    checkpoint: earlier.at(-1) || null,
    ownCheckpoint: own
  };
}

/**
 * 注入提示词前按结构裁剪：摘要取尾部（最近剧情），各列表保留最早若干条（主角与主要关系），
 * 再按序列化长度收敛。长篇读久了记忆会越攒越多，这里给注入长度一个硬上限（也更省 token）。
 */
function trimMemoryForPrompt(value) {
  const memory = normalizeMemory(value);
  const trimmed = {
    summary: memory.summary.slice(-PROMPT_SUMMARY_LIMIT),
    characters: memory.characters.slice(0, PROMPT_LIST_LIMIT),
    relationships: memory.relationships.slice(0, PROMPT_LIST_LIMIT),
    honorifics: memory.honorifics.slice(0, PROMPT_LIST_LIMIT),
    unresolved: memory.unresolved.slice(0, PROMPT_LIST_LIMIT)
  };
  const keys = ["characters", "relationships", "honorifics", "unresolved"];
  while (JSON.stringify(trimmed).length > PROMPT_MAX_CHARS) {
    const longest = keys
      .map(key => ({ key, length: JSON.stringify(trimmed[key]).length }))
      .sort((left, right) => right.length - left.length)[0];
    if (!longest || trimmed[longest.key].length === 0) {
      break;
    }
    trimmed[longest.key] = trimmed[longest.key].slice(0, -1);
  }
  return trimmed;
}

function mergeMemory(base, deltas) {
  const normalizedBase = normalizeMemory(base);
  const rows = (Array.isArray(deltas) ? deltas : [deltas]).map(normalizeMemory);
  const summaries = [normalizedBase.summary, ...rows.map(item => item.summary)].filter(Boolean);
  const result = { ...normalizedBase, summary: summaries.join("\n").slice(-SUMMARY_LIMIT) };
  for (const key of ["characters", "relationships", "honorifics", "unresolved"]) {
    result[key] = normalizeList([...(normalizedBase[key] || []), ...rows.flatMap(item => item[key] || [])]);
  }
  return result;
}

function saveCheckpoint(value, input) {
  const store = normalizeStore(value);
  const key = cleanText(input && input.key, 180);
  const chapterId = cleanText(input && input.chapterId, 160);
  if (!key || !chapterId) throw new Error("Novel memory requires book and chapter identifiers");
  const now = Date.now();
  const existing = store.books.find(book => book.key === key);
  const book = existing || normalizeBook({ key, seriesId: input.seriesId, title: input.title });
  const previous = book.checkpoints.find(item => item.chapterId === chapterId) || null;
  // 本话自己的增量 = 这一话之前存过的增量（旧数据没 delta，就退化成它的累计快照当基线）+ 这次新学到的。
  // 这样「补翻/重翻」是叠加而不是覆盖，这一话学过的东西不会被抹掉。
  const ownBase = previous ? (previous.delta || previous.memory) : normalizeMemory(null);
  const delta = input.memory ? null : mergeMemory(ownBase, input.memoryDeltas);
  // 编辑器手写整份记忆时按「这家说的话为准」：只存累计，delta 置空（当作基线）。
  const memory = input.memory
    ? normalizeMemory(input.memory)
    : mergeMemory(cumulativeMemory(book, input.chapterOrder, chapterId), delta);
  const checkpoint = normalizeCheckpoint({
    chapterId,
    chapterTitle: input.chapterTitle,
    chapterOrder: input.chapterOrder,
    revision: (previous && previous.revision || 0) + 1,
    updatedAt: now,
    delta,
    memory
  });
  book.seriesId = cleanText(input.seriesId, 120) || book.seriesId;
  book.title = cleanText(input.title, 300) || book.title;
  book.revision += 1;
  book.updatedAt = now;
  book.checkpoints = [...book.checkpoints.filter(item => item.chapterId !== chapterId), checkpoint]
    .sort(compareCheckpoints).slice(-MAX_CHECKPOINTS);
  store.books = [book, ...store.books.filter(item => item.key !== key)].slice(0, MAX_BOOKS);
  store.updatedAt = now;
  return { store, book, checkpoint };
}

function clearBook(value, key) {
  const store = normalizeStore(value);
  store.books = store.books.filter(book => book.key !== cleanText(key, 180));
  store.updatedAt = Date.now();
  return store;
}

/** 删掉某一话的快照：回顾前面时发现这一话的累计被旧版缺陷污染过，就单独清掉它、重翻重建。 */
function removeCheckpoint(value, key, chapterId) {
  const store = normalizeStore(value);
  const bookKey = cleanText(key, 180);
  const target = cleanText(chapterId, 160);
  const book = store.books.find(item => item.key === bookKey);
  if (!book || !target) {
    return store;
  }
  book.checkpoints = book.checkpoints.filter(item => item.chapterId !== target);
  book.revision += 1;
  book.updatedAt = Date.now();
  store.updatedAt = book.updatedAt;
  return store;
}

export default Object.freeze({
  STORAGE_KEY,
  SCHEMA_VERSION,
  normalizeMemory,
  normalizeStore,
  checkpointOrder,
  cumulativeMemory,
  getBook,
  getContext,
  mergeMemory,
  trimMemoryForPrompt,
  saveCheckpoint,
  removeCheckpoint,
  clearBook
});
