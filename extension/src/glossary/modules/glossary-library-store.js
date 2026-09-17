export function installGlossaryLibraryStore(runtime) {
  function libraryStorageKey() {
    return runtime.glossaryCore.STORAGE_KEY;
  }
  /** 重新读取最新术语库状态：库的增删改只改 libraries，避免覆盖并发写入的条目。 */
  async function readGlossaryState() {
    const stored = await runtime.storageGet([libraryStorageKey(), runtime.glossaryCore.LEGACY_STORAGE_KEY]);
    return runtime.glossaryCore.normalizeGlossary(
      stored[libraryStorageKey()] ?? stored[runtime.glossaryCore.LEGACY_STORAGE_KEY]
    );
  }
  runtime.readGlossaryState = readGlossaryState;
  async function writeGlossaryState(next) {
    runtime.glossary = next;
    await runtime.storageSet({ [libraryStorageKey()]: next });
    runtime.renderGlossary();
    runtime.renderLibraryPanel();
    runtime.refreshPendingLibraryControls();
  }
  runtime.writeGlossaryState = writeGlossaryState;
  function setLibraryStatus(message, isError = false) {
    if (!runtime.libraryStatusText) {
      return;
    }
    runtime.libraryStatusText.textContent = message;
    runtime.libraryStatusText.dataset.error = isError ? "true" : "false";
  }
  runtime.setLibraryStatus = setLibraryStatus;
  function libraryLabel(libraryId) {
    const library = runtime.glossaryCore.getLibrary(runtime.glossary, libraryId);
    if (!library) {
      return "";
    }
    return library.enabled === false ? `${library.name}（已停用）` : library.name;
  }
  runtime.libraryLabel = libraryLabel;
  async function pushLibraryToServer(library) {
    const baseUrl = await runtime.resolveServerBaseUrl();
    const resp = await fetch(`${baseUrl}/glossary/libraries`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: library.id, name: library.name, enabled: library.enabled, urls: library.urls, applyUrls: library.applyUrls || []
      })
    });
    if (resp.status === 404) {
      runtime.libraryServerSupported = false;
      throw new Error("本地服务尚未支持多术语库，请重启本地 OCR 服务");
    }
    if (!resp.ok) {
      throw new Error(`本地服务返回 HTTP ${resp.status}`);
    }
    runtime.libraryServerSupported = true;
    return resp.json();
  }
  runtime.pushLibraryToServer = pushLibraryToServer;
  async function deleteLibraryOnServer(libraryId) {
    const baseUrl = await runtime.resolveServerBaseUrl();
    const resp = await fetch(`${baseUrl}/glossary/libraries/${encodeURIComponent(libraryId)}`, { method: "DELETE" });
    if (resp.status === 404) {
      return { ok: false, unsupported: true };
    }
    return { ok: resp.ok };
  }
  runtime.deleteLibraryOnServer = deleteLibraryOnServer;
  async function persistLibraries(libraries, message) {
    const current = await readGlossaryState();
    const next = runtime.glossaryCore.normalizeGlossary({
      ...current,
      revision: current.revision + 1,
      updatedAt: Date.now(),
      libraries
    });
    await writeGlossaryState(next);
    if (message) {
      setLibraryStatus(message, false);
    }
    return next;
  }
  runtime.persistLibraries = persistLibraries;
  /** 新建或更新一个术语库：先写本地，再尽力同步本地服务。 */
  async function saveLibrary(input = {}) {
    const current = await readGlossaryState();
    const id = runtime.glossaryCore.normalizeLibraryId(input.id);
    const existing = id ? current.libraries.find(library => library.id === id) : null;
    const name = runtime.glossaryCore.normalizeLibraryName(input.name, existing ? existing.name : "新术语库");
    const duplicate = current.libraries.find(library => library.id !== (existing ? existing.id : "") &&
      library.name.toLocaleLowerCase() === name.toLocaleLowerCase());
    if (duplicate) {
      return { ok: false, error: `已经有一个叫“${name}”的术语库` };
    }
    const urls = [];
    for (const item of Array.isArray(input.urls) ? input.urls : []) {
      const url = runtime.glossaryCore.normalizeLibraryUrl(item);
      if (url && !urls.includes(url)) {
        urls.push(url);
      }
    }
    const applyUrls = [];
    for (const item of Array.isArray(input.applyUrls) ? input.applyUrls : []) {
      const url = runtime.glossaryCore.normalizeLibraryUrl(item);
      if (url && !applyUrls.includes(url)) {
        applyUrls.push(url);
      }
    }
    const library = runtime.glossaryCore.normalizeLibrary({
      id: existing ? existing.id : id || `library-${runtime.createTermId().slice(5, 17)}`,
      name,
      enabled: input.enabled !== false,
      urls,
      applyUrls,
      createdAt: existing ? existing.createdAt : Date.now(),
      updatedAt: Date.now()
    }, current.libraries.length);
    const libraries = existing
      ? current.libraries.map(item => item.id === library.id ? library : item)
      : [...current.libraries, library];
    const action = existing ? `已更新术语库「${library.name}」` : `已新建术语库「${library.name}」`;
    await persistLibraries(libraries, action);
    try {
      await pushLibraryToServer(library);
    } catch (error) {
      setLibraryStatus(`${action}；服务端未同步（${runtime.getErrorMessage(error)}）`, true);
      return { ok: true, library, serverSynced: false };
    }
    return { ok: true, library, serverSynced: true };
  }
  runtime.saveLibrary = saveLibrary;
  async function setLibraryEnabled(libraryId, enabled) {
    const current = await readGlossaryState();
    const library = current.libraries.find(item => item.id === libraryId);
    if (!library) {
      return { ok: false, error: "未找到该术语库" };
    }
    const next = { ...library, enabled: enabled !== false, updatedAt: Date.now() };
    const action = `「${next.name}」已${next.enabled ? "启用" : "停用"}${next.enabled ? "" : "（该库术语不再参与翻译）"}`;
    await persistLibraries(current.libraries.map(item => item.id === libraryId ? next : item), action);
    try {
      await pushLibraryToServer(next);
    } catch (error) {
      setLibraryStatus(`${action}；服务端未同步（${runtime.getErrorMessage(error)}）`, true);
      return { ok: true, library: next, serverSynced: false };
    }
    return { ok: true, library: next, serverSynced: true };
  }
  runtime.setLibraryEnabled = setLibraryEnabled;
  /** 删除术语库：条目先退回默认库（换新 id，避免服务端主键冲突），再删除库定义。 */
  async function removeLibrary(libraryId) {
    const current = await readGlossaryState();
    const library = current.libraries.find(item => item.id === libraryId);
    if (!library) {
      return { ok: false, error: "未找到该术语库" };
    }
    if (library.id === runtime.glossaryCore.DEFAULT_LIBRARY_ID) {
      return { ok: false, error: "默认术语库不能删除" };
    }
    const moved = current.entries.filter(entry => entry.libraryId === library.id);
    const entries = current.entries.map(entry => entry.libraryId === library.id
      ? { ...entry, id: runtime.createTermId(), libraryId: runtime.glossaryCore.DEFAULT_LIBRARY_ID }
      : entry);
    const libraries = current.libraries.filter(item => item.id !== library.id);
    const next = runtime.glossaryCore.normalizeGlossary({
      ...current, revision: current.revision + 1, updatedAt: Date.now(), libraries, entries
    });
    // 先同步到 runtime，persistEntries 会沿用这份（已删除该库的）库列表，避免删掉的库又被写回。
    runtime.glossary = next;
    await runtime.persistEntries(next.entries, moved.length
      ? `已删除「${library.name}」，${moved.length} 条术语已移到默认术语库`
      : `已删除「${library.name}」`);
    if (runtime.activeLibraryId === library.id) {
      runtime.activeLibraryId = "";
      // 搜索框里可能还留着刚删掉那个库的词：切回总览时一并换掉。
      runtime.syncSearchInput?.();
      runtime.renderGlossary();
      runtime.setStatus(`已删除「${library.name}」${moved.length ? `，${moved.length} 条术语已移到默认术语库` : ""}，现在显示全部 ${runtime.glossary.entries.length} 条术语`, false);
    }
    for (const entry of moved) {
      await runtime.deleteEntryFromServer(entry.id).catch(() => undefined);
    }
    await deleteLibraryOnServer(library.id).catch(() => undefined);
    // 这个库的搜索词也一起丢掉，免得删了库还留着一份「幽灵搜索」。
    runtime.searchQueries?.delete(library.id);
    runtime.renderLibraryPanel();
    return { ok: true, moved: moved.length };
  }
  runtime.removeLibrary = removeLibrary;
  async function focusLibrary(libraryId) {
    runtime.activeLibraryId = runtime.glossaryCore.normalizeLibraryId(libraryId);
    runtime.renderLibraryPanel();
    runtime.renderGlossary();
    // 「正在查看…/显示全部…」这类说明按设计稿删掉了：进库不写状态行，只把上一条残留清掉。
    runtime.setStatus("", false);
  }
  runtime.focusLibrary = focusLibrary;
  async function ensureLibraryByName(name) {
    const current = await readGlossaryState();
    const trimmed = runtime.glossaryCore.normalizeLibraryName(name, "导入的术语库");
    const existing = current.libraries.find(library => library.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase());
    if (existing) {
      return existing;
    }
    const library = runtime.glossaryCore.normalizeLibrary({
      id: `library-${runtime.createTermId().slice(5, 17)}`, name: trimmed, enabled: true, urls: [],
      createdAt: Date.now(), updatedAt: Date.now()
    }, current.libraries.length);
    await persistLibraries([...current.libraries, library], `已新建术语库「${library.name}」`);
    try {
      await pushLibraryToServer(library);
    } catch (_) { /* 离线时保留本地库，恢复服务后再同步 */ }
    return library;
  }
  runtime.ensureLibraryByName = ensureLibraryByName;
  /**
   * 导入时按名字取库：同名直接复用，不存在才新建。
   * 上限必须在这里显式拦下：normalizeLibraries 会把第 51 个库静默丢掉，
   * 那样导入的条目会全部退回默认库，用户却看到「导入成功」。
   */
  async function ensureLibraryForImport(name) {
    const current = await readGlossaryState();
    const trimmed = runtime.glossaryCore.normalizeLibraryName(name, "导入的术语库");
    const existing = current.libraries.find(library => library.name.toLocaleLowerCase() === trimmed.toLocaleLowerCase());
    if (existing) {
      return existing;
    }
    if (current.libraries.length >= runtime.glossaryCore.MAX_LIBRARIES) {
      throw new Error(`术语库最多 ${runtime.glossaryCore.MAX_LIBRARIES} 个，现在已经满了，无法为「${trimmed}」新建；请先删除不用的术语库再导入`);
    }
    return ensureLibraryByName(trimmed);
  }
  runtime.ensureLibraryForImport = ensureLibraryForImport;
  /** 导入文件里带的库定义并入现有库（同名合并，保留本地 id）。 */
  async function mergeImportedLibraries(importedLibraries) {
    const current = await readGlossaryState();
    const libraries = [...current.libraries];
    for (const item of Array.isArray(importedLibraries) ? importedLibraries : []) {
      const name = runtime.glossaryCore.normalizeLibraryName(item && item.name, "");
      if (!name) {
        continue;
      }
      if (libraries.some(library => library.name.toLocaleLowerCase() === name.toLocaleLowerCase())) {
        continue;
      }
      libraries.push(runtime.glossaryCore.normalizeLibrary({
        id: item.id, name, enabled: item.enabled !== false, urls: item.urls || [], applyUrls: item.applyUrls || [],
        createdAt: Date.now(), updatedAt: Date.now()
      }, libraries.length));
    }
    if (libraries.length === current.libraries.length) {
      return current.libraries;
    }
    const next = await persistLibraries(libraries, `已合并 ${libraries.length - current.libraries.length} 个术语库定义`);
    for (const library of next.libraries) {
      if (current.libraries.some(item => item.id === library.id)) {
        continue;
      }
      await pushLibraryToServer(library).catch(() => undefined);
    }
    return next.libraries;
  }
  runtime.mergeImportedLibraries = mergeImportedLibraries;

  /**
   * JSON 备份导入：文件里的库 id 与本机可能不同（两台机器各自导出，或删过重建过）。
   * 按库名把条目归并到本机同名库；认不出来的保持原样（后续会按「悬空库」落回默认库）。
   */
  function realignImportedEntries(entries, fileLibraries, mergedLibraries) {
    const idByName = new Map(mergedLibraries.map(library => [library.name.toLocaleLowerCase(), library.id]));
    const nameById = new Map((Array.isArray(fileLibraries) ? fileLibraries : [])
      .map(library => [library.id, String(library.name || "").trim().toLocaleLowerCase()]));
    const existingIds = new Set(mergedLibraries.map(library => library.id));
    for (const entry of entries) {
      if (existingIds.has(entry.libraryId)) {
        continue;
      }
      const mapped = idByName.get(nameById.get(entry.libraryId) || "");
      if (mapped) {
        entry.libraryId = mapped;
      }
    }
    return entries;
  }
  runtime.realignImportedEntries = realignImportedEntries;
  /** 首次加载后把本地独有的库补齐到服务端（服务端还没有多库支持时静默跳过）。 */
  async function syncLibrariesToServer(libraries) {
    let synced = 0;
    for (const library of Array.isArray(libraries) ? libraries : []) {
      try {
        await pushLibraryToServer(library);
        synced += 1;
      } catch (_) {
        break;
      }
    }
    return synced;
  }
  runtime.syncLibrariesToServer = syncLibrariesToServer;
  async function assignChapterLibrary(chapterKey, libraryId) {
    const response = await runtime.sendRuntimeMessage({
      type: "SET_PENDING_CHAPTER_LIBRARY",
      chapterKey,
      libraryId
    });
    if (!response || !response.ok) {
      throw new Error(response && response.error || "设置章节术语库失败");
    }
    return response;
  }
  runtime.assignChapterLibrary = assignChapterLibrary;

  /**
   * 默认术语库里「别的库已经有的」条目。
   * 用途：先把总表导成 CSV、让 AI 按书拆好再导进各自的库之后，默认库里通常还留着同一批术语，
   * 这个按钮把它们清掉（判定口径与同库去重一致：原文+源语言+目标语言+范围+范围键）。
   */
  function duplicateEntriesInDefaultLibrary() {
    const identity = entry => [
      entry.source, entry.sourceLanguage, entry.targetLanguage, entry.scope, entry.scopeKey
    ].join("\u0000");
    const elsewhere = new Set(runtime.glossary.entries
      .filter(entry => entry.libraryId !== runtime.glossaryCore.DEFAULT_LIBRARY_ID)
      .map(identity));
    return runtime.glossary.entries.filter(entry =>
      entry.libraryId === runtime.glossaryCore.DEFAULT_LIBRARY_ID && elsewhere.has(identity(entry)));
  }
  runtime.duplicateEntriesInDefaultLibrary = duplicateEntriesInDefaultLibrary;

  async function removeDuplicateEntriesFromDefaultLibrary() {
    const duplicates = duplicateEntriesInDefaultLibrary();
    if (!duplicates.length) {
      return { ok: true, removed: 0, failedDeletes: 0 };
    }
    const ids = new Set(duplicates.map(entry => entry.id));
    const result = await runtime.persistEntries(
      runtime.glossary.entries.filter(entry => !ids.has(entry.id)),
      `已从默认术语库删除 ${ids.size} 条与其它库重复的术语`
    );
    return { ok: true, removed: ids.size, failedDeletes: (result && result.failedDeletes) || 0 };
  }
  runtime.removeDuplicateEntriesFromDefaultLibrary = removeDuplicateEntriesFromDefaultLibrary;
}
