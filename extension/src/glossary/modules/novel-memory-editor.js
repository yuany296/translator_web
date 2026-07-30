export function installNovelMemoryEditor(runtime) {
  const memoryTabBtn = document.getElementById("memoryTabBtn");
  const memoryPanel = document.getElementById("memoryPanel");
  const memoryBookSelect = document.getElementById("memoryBookSelect");
  const memoryJsonInput = document.getElementById("memoryJsonInput");
  const memoryMetaText = document.getElementById("memoryMetaText");
  const memoryStatusText = document.getElementById("memoryStatusText");
  const memorySaveBtn = document.getElementById("memorySaveBtn");
  const memoryExportBtn = document.getElementById("memoryExportBtn");
  const memoryImportBtn = document.getElementById("memoryImportBtn");
  const memoryClearBtn = document.getElementById("memoryClearBtn");
  const memoryFileInput = document.getElementById("memoryFileInput");
  let store = runtime.novelMemoryCore.normalizeStore(null);

  function switchTab(tab) {
    runtime.activeTab = ["official", "pending", "memory"].includes(tab) ? tab : "official";
    const official = runtime.activeTab === "official";
    const pending = runtime.activeTab === "pending";
    runtime.officialPanel.classList.toggle("hidden", !official);
    runtime.pendingPanel.classList.toggle("hidden", !pending);
    memoryPanel.classList.toggle("hidden", runtime.activeTab !== "memory");
    runtime.officialTabBtn.classList.toggle("active", official);
    runtime.pendingTabBtn.classList.toggle("active", pending);
    memoryTabBtn.classList.toggle("active", runtime.activeTab === "memory");
    runtime.addBtn.classList.toggle("hidden", !official);
    if (pending) runtime.loadTermDiscoveryState(true).catch(error => {
      runtime.setPendingStatus(`读取失败：${runtime.getErrorMessage(error)}`, true);
    });
    if (runtime.activeTab === "memory") void loadNovelMemory();
  }
  runtime.switchTab = switchTab;

  async function loadNovelMemory() {
    const response = await runtime.sendRuntimeMessage({ type: "GET_NOVEL_MEMORY" });
    if (!response?.ok) throw new Error(response?.error || "读取小说记忆失败");
    store = runtime.novelMemoryCore.normalizeStore(response.store);
    renderBookOptions();
  }

  function renderBookOptions(preferredKey = "") {
    const selected = preferredKey || memoryBookSelect.value;
    memoryBookSelect.replaceChildren(...store.books.map(book => {
      const option = document.createElement("option");
      option.value = book.key;
      option.textContent = book.title || book.key;
      return option;
    }));
    if (store.books.some(book => book.key === selected)) memoryBookSelect.value = selected;
    renderSelectedBook();
  }

  function getSelectedBook() {
    return store.books.find(book => book.key === memoryBookSelect.value) || null;
  }

  function renderSelectedBook() {
    const book = getSelectedBook();
    const checkpoint = book?.checkpoints?.at(-1) || null;
    memoryJsonInput.disabled = !checkpoint;
    memorySaveBtn.disabled = !checkpoint;
    memoryExportBtn.disabled = !book;
    memoryClearBtn.disabled = !book;
    memoryJsonInput.value = checkpoint ? JSON.stringify(checkpoint.memory, null, 2) : "";
    memoryMetaText.textContent = checkpoint
      ? `${book.title || book.key} · ${checkpoint.chapterTitle || checkpoint.chapterId} · 修订 ${book.revision}`
      : "暂无小说记忆";
  }

  function setStatus(message, error = false) {
    memoryStatusText.textContent = message;
    memoryStatusText.dataset.error = error ? "true" : "false";
  }

  async function saveSelectedMemory() {
    const book = getSelectedBook();
    const checkpoint = book?.checkpoints?.at(-1);
    if (!book || !checkpoint) return;
    try {
      const memory = runtime.novelMemoryCore.normalizeMemory(JSON.parse(memoryJsonInput.value));
      const response = await runtime.sendRuntimeMessage({
        type: "SAVE_NOVEL_MEMORY",
        scopeKey: book.key,
        seriesId: book.seriesId,
        seriesTitle: book.title,
        chapterId: checkpoint.chapterId,
        chapterTitle: checkpoint.chapterTitle,
        chapterOrder: checkpoint.chapterOrder,
        memory
      });
      if (!response?.ok) throw new Error(response?.error || "保存失败");
      setStatus("本书记忆已保存");
      await loadNovelMemory();
    } catch (error) {
      setStatus(`保存失败：${runtime.getErrorMessage(error)}`, true);
    }
  }

  function exportSelectedBook() {
    const book = getSelectedBook();
    if (!book) return;
    runtime.downloadFile(
      `novel-memory-${book.seriesId || "book"}-${runtime.formatDate()}.json`,
      JSON.stringify(book, null, 2),
      "application/json;charset=utf-8"
    );
    setStatus("本书记忆已导出");
  }

  async function importBookFile() {
    const file = memoryFileInput.files?.[0];
    memoryFileInput.value = "";
    if (!file) return;
    try {
      const book = runtime.novelMemoryCore.normalizeStore({
        books: [JSON.parse(await file.text())]
      }).books[0];
      if (!book || !book.checkpoints.length) throw new Error("文件中没有有效的作品记忆");
      for (const checkpoint of book.checkpoints) {
        const response = await runtime.sendRuntimeMessage({
          type: "SAVE_NOVEL_MEMORY",
          scopeKey: book.key,
          seriesId: book.seriesId,
          seriesTitle: book.title,
          chapterId: checkpoint.chapterId,
          chapterTitle: checkpoint.chapterTitle,
          chapterOrder: checkpoint.chapterOrder,
          memory: checkpoint.memory
        });
        if (!response?.ok) throw new Error(response?.error || "导入失败");
      }
      setStatus("本书记忆已导入");
      await loadNovelMemory();
      renderBookOptions(book.key);
    } catch (error) {
      setStatus(`导入失败：${runtime.getErrorMessage(error)}`, true);
    }
  }

  async function clearSelectedBook() {
    const book = getSelectedBook();
    if (!book || !confirm(`确定清空《${book.title || book.key}》的全部小说记忆吗？`)) return;
    const response = await runtime.sendRuntimeMessage({
      type: "CLEAR_NOVEL_MEMORY",
      scopeKey: book.key
    });
    if (!response?.ok) {
      setStatus(response?.error || "清空失败", true);
      return;
    }
    setStatus("本书记忆已清空");
    await loadNovelMemory();
  }

  document.addEventListener("DOMContentLoaded", () => {
    memoryTabBtn.addEventListener("click", () => runtime.switchTab("memory"));
    memoryBookSelect.addEventListener("change", renderSelectedBook);
    memorySaveBtn.addEventListener("click", saveSelectedMemory);
    memoryExportBtn.addEventListener("click", exportSelectedBook);
    memoryImportBtn.addEventListener("click", () => memoryFileInput.click());
    memoryFileInput.addEventListener("change", importBookFile);
    memoryClearBtn.addEventListener("click", clearSelectedBook);
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[runtime.novelMemoryCore.STORAGE_KEY]) void loadNovelMemory();
    });
  });
}
