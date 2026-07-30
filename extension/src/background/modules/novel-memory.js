export function installNovelMemory(runtime) {
  async function readStore() {
    const stored = await runtime.storageGet([runtime.novelMemoryCore.STORAGE_KEY]);
    return runtime.novelMemoryCore.normalizeStore(stored[runtime.novelMemoryCore.STORAGE_KEY]);
  }

  async function handleGetNovelMemory(message = {}) {
    const store = await readStore();
    const key = String(message.scopeKey || message.key || "").trim();
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
}
