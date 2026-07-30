const STORAGE_KEY = "mt_novel_memory_v1";
const SCHEMA_VERSION = 1;
const MAX_BOOKS = 100;
const MAX_CHECKPOINTS = 160;
const LIST_LIMIT = 120;
const SUMMARY_LIMIT = 6000;

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

function normalizeCheckpoint(value) {
  const chapterId = cleanText(value && value.chapterId, 160);
  if (!chapterId) return null;
  const order = Number(value && value.chapterOrder);
  return {
    chapterId,
    chapterTitle: cleanText(value && value.chapterTitle, 300),
    chapterOrder: Number.isFinite(order) ? order : null,
    revision: Math.max(1, Math.floor(Number(value && value.revision) || 1)),
    updatedAt: Math.max(0, Math.floor(Number(value && value.updatedAt) || 0)),
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
  const leftOrder = Number(left.chapterOrder);
  const rightOrder = Number(right.chapterOrder);
  if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) && leftOrder !== rightOrder) {
    return leftOrder - rightOrder;
  }
  return left.updatedAt - right.updatedAt || left.chapterId.localeCompare(right.chapterId);
}

function getBook(value, key) {
  const normalizedKey = cleanText(key, 180);
  return normalizeStore(value).books.find(book => book.key === normalizedKey) || null;
}

function getContext(value, key, chapter) {
  const book = getBook(value, key);
  if (!book) return { revision: 0, memory: normalizeMemory(null), checkpoint: null };
  const chapterId = cleanText(chapter && chapter.chapterId, 160);
  const order = Number(chapter && chapter.chapterOrder);
  const candidates = book.checkpoints.filter(checkpoint => {
    if (checkpoint.chapterId === chapterId) return false;
    if (Number.isFinite(order) && Number.isFinite(Number(checkpoint.chapterOrder))) {
      return Number(checkpoint.chapterOrder) < order;
    }
    return false;
  });
  const checkpoint = candidates.sort(compareCheckpoints).at(-1) || null;
  return {
    revision: book.revision,
    memory: checkpoint ? checkpoint.memory : normalizeMemory(null),
    checkpoint
  };
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
  const context = getContext(store, key, input);
  const previous = book.checkpoints.find(item => item.chapterId === chapterId);
  const checkpoint = normalizeCheckpoint({
    chapterId,
    chapterTitle: input.chapterTitle,
    chapterOrder: input.chapterOrder,
    revision: (previous && previous.revision || 0) + 1,
    updatedAt: now,
    memory: input.memory ? input.memory : mergeMemory(context.memory, input.memoryDeltas)
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

export default Object.freeze({
  STORAGE_KEY,
  SCHEMA_VERSION,
  normalizeMemory,
  normalizeStore,
  getBook,
  getContext,
  mergeMemory,
  saveCheckpoint,
  clearBook
});
