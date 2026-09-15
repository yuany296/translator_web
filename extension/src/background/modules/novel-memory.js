export function installNovelMemory(runtime) {
  /** 小说记忆总开关（设置页 → 阅读与显示）。关掉后既不读取也不写入：提示词里不再带记忆，更省 token。 */
  function memoryEnabled(configuration) {
    return !configuration || configuration.runtime?.novelMemoryEnabled !== false;
  }

  async function readStore() {
    const stored = await runtime.storageGet([runtime.novelMemoryCore.STORAGE_KEY]);
    return runtime.novelMemoryCore.normalizeStore(stored[runtime.novelMemoryCore.STORAGE_KEY]);
  }

  async function handleGetNovelMemory(message = {}) {
    const store = await readStore();
    const key = String(message.scopeKey || message.key || "").trim();
    if (!(await memoryEnabled(await runtime.loadConfiguration()))) {
      return {
        ok: true,
        disabled: true,
        store,
        book: key ? runtime.novelMemoryCore.getBook(store, key) : null,
        context: { revision: 0, memory: runtime.novelMemoryCore.normalizeMemory(null), checkpoint: null }
      };
    }
    if (!key) return { ok: true, store };
    return {
      ok: true,
      book: runtime.novelMemoryCore.getBook(store, key),
      context: runtime.novelMemoryCore.getContext(store, key, message)
    };
  }
  runtime.handleGetNovelMemory = handleGetNovelMemory;

  async function handleSaveNovelMemory(message = {}) {
    try {
      if (!(await memoryEnabled(await runtime.loadConfiguration()))) {
        return { ok: true, skipped: true, reason: "memory_disabled" };
      }
      const store = await readStore();
      const saved = runtime.novelMemoryCore.saveCheckpoint(store, {
        key: message.scopeKey || message.key,
        seriesId: message.seriesId,
        title: message.seriesTitle,
        chapterId: message.chapterId,
        chapterTitle: message.chapterTitle,
        chapterOrder: message.chapterOrder,
        memory: message.memory,
        memoryDeltas: message.memoryDeltas
      });
      await runtime.storageSet({ [runtime.novelMemoryCore.STORAGE_KEY]: saved.store });
      return {
        ok: true,
        revision: saved.book.revision,
        checkpoint: saved.checkpoint
      };
    } catch (error) {
      return { ok: false, error: runtime.getErrorMessage(error) };
    }
  }
  runtime.handleSaveNovelMemory = handleSaveNovelMemory;

  async function handleClearNovelMemory(message = {}) {
    const store = await readStore();
    const key = String(message.scopeKey || message.key || "").trim();
    const next = key
      ? runtime.novelMemoryCore.clearBook(store, key)
      : runtime.novelMemoryCore.normalizeStore(null);
    await runtime.storageSet({ [runtime.novelMemoryCore.STORAGE_KEY]: next });
    return { ok: true, store: next };
  }
  runtime.handleClearNovelMemory = handleClearNovelMemory;

  /** 只删某一话的快照（回顾时发现这一话的累计混进了后面的内容，就清掉它重翻重建）。 */
  async function handleDeleteNovelMemoryChapter(message = {}) {
    const store = await readStore();
    const next = runtime.novelMemoryCore.removeCheckpoint(
      store, message.scopeKey || message.key, message.chapterId
    );
    await runtime.storageSet({ [runtime.novelMemoryCore.STORAGE_KEY]: next });
    return { ok: true, store: next };
  }
  runtime.handleDeleteNovelMemoryChapter = handleDeleteNovelMemoryChapter;
}
