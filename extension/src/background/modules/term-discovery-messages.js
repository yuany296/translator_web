import { resolveExtractionConfig } from "../../config/store.js";

export function installTermDiscoveryMessages(runtime) {
  function sentenceLlmConfig(configuration) {
    return resolveExtractionConfig(configuration, "sentenceExtraction");
  }
  /** 句子级提取是否可用：开关打开 + 选定了带地址的配置，两者缺一都不显示「AI 提取」按钮。 */
  function sentenceServiceReady(configuration) {
    if (configuration.runtime.sentenceExtractionEnabled === false) return false;
    return Boolean(sentenceLlmConfig(configuration).baseUrl);
  }
  /**
   * 整章术语提取：链路拆成「排队准备 → 提取（单独队列）→ 排队合并」，
   * 慢的 LLM 请求不再占用用户操作共用的那条队列（详见 term-discovery-extract.js）。
   */
  async function handleDiscoverTerms(message) {
    return runtime.runTermDiscovery(message);
  }
  runtime.handleDiscoverTerms = handleDiscoverTerms;
  /**
   * 预热本地模型（设置页切到「本地模型」时发一次）。
   * 立刻回话、加载留在后台：这个请求要几十秒，界面不该等它。
   */
  async function handleWarmTermExtractor() {
    const configuration = await runtime.loadConfiguration();
    void runtime.warmTermExtractor(configuration.ocr.localPaddle.baseUrl);
    return { ok: true, warming: true };
  }
  runtime.handleWarmTermExtractor = handleWarmTermExtractor;
  async function handleGetTermDiscoveryStatus(message = {}) {
    const [configuration, stored] = await Promise.all([
      runtime.loadConfiguration(),
      runtime.storageGet([runtime.STORAGE_KEYS.glossaryPending])
    ]);
    const enabled = configuration.runtime.termDiscoveryEnabled !== false;
    if (enabled && message.probe === true) {
      await runtime.probeTermExtractor(configuration.ocr.localPaddle.baseUrl, runtime.termLlmConfig(configuration));
    }
    return {
      ok: true,
      enabled,
      pendingCount: runtime.termDiscoveryCore.getPendingCount(stored[runtime.STORAGE_KEYS.glossaryPending]),
      status: enabled ? runtime.getTermExtractorStatusSnapshot() : {
        ...runtime.getTermExtractorStatusSnapshot(),
        state: "disabled"
      },
      sentenceLlmConfigured: sentenceServiceReady(configuration)
    };
  }
  runtime.handleGetTermDiscoveryStatus = handleGetTermDiscoveryStatus;
  async function handleGetTermDiscoveryState(message = {}) {
    const [configuration, stored] = await Promise.all([
      runtime.loadConfiguration(),
      runtime.storageGet([
        runtime.STORAGE_KEYS.glossaryPending,
        runtime.STORAGE_KEYS.glossaryIgnored,
        runtime.STORAGE_KEYS.termDiscoveryLast
      ])
    ]);
    const enabled = configuration.runtime.termDiscoveryEnabled !== false;
    if (enabled && message.probe === true) {
      await runtime.probeTermExtractor(configuration.ocr.localPaddle.baseUrl, runtime.termLlmConfig(configuration));
    }
    const pending = runtime.termDiscoveryCore.normalizePendingStore(stored[runtime.STORAGE_KEYS.glossaryPending]);
    return {
      ok: true,
      enabled,
      pending,
      libraries: configuration.glossary.libraries,
      ignored: runtime.termDiscoveryCore.normalizeIgnoredStore(stored[runtime.STORAGE_KEYS.glossaryIgnored]),
      lastDiscovery: stored[runtime.STORAGE_KEYS.termDiscoveryLast] || null,
      pendingCount: runtime.termDiscoveryCore.getPendingCount(pending),
      status: enabled ? runtime.getTermExtractorStatusSnapshot() : {
        ...runtime.getTermExtractorStatusSnapshot(),
        state: "disabled"
      },
      sentenceLlmConfigured: sentenceServiceReady(configuration)
    };
  }
  runtime.handleGetTermDiscoveryState = handleGetTermDiscoveryState;
  async function handleSetTermDiscoveryEnabled(message) {
    const enabled = message.enabled !== false;
    const configuration = await runtime.loadConfiguration();
    await runtime.configurationStore.save("runtime", {
      ...configuration.runtime,
      termDiscoveryEnabled: enabled
    });
    return runtime.handleGetTermDiscoveryStatus({
      probe: enabled && message.probe === true
    });
  }
  runtime.handleSetTermDiscoveryEnabled = handleSetTermDiscoveryEnabled;
  /**
   * 一条术语最终进哪个库：显式指定 > 该章节手动指定过的库 > 该章节网址绑定的库 > 默认库。
   *
   * 网址这一档不是锦上添花，而是必须的：术语库页靠候选提取在 pending 里建了章节记录，
   * 才有的 `chapterLibraryId`；从「管理当前章节译文」侧栏直接加术语时这一章可能从未
   * 跑过候选提取，pending 里没有它，只看前两档就一律落进默认库 —— 用户绑了网址的库
   * 却收不到本页新词。优先级与术语库页的 `effectiveLibraryId` 保持一致。
   */
  function resolveEntryLibraryId(libraries, requested, chapterLibraryId, pageUrl) {
    const candidates = [requested, chapterLibraryId];
    for (const candidate of candidates) {
      const id = runtime.glossaryCore.normalizeLibraryId(candidate);
      if (id && libraries.some(library => library.id === id)) {
        return id;
      }
    }
    // matchLibraryByUrl 只认已启用的库，与候选提取时的判定同源。
    const matched = runtime.glossaryCore.matchLibraryByUrl(libraries, pageUrl);
    return matched ? matched.libraryId : runtime.glossaryCore.DEFAULT_LIBRARY_ID;
  }
  runtime.resolveEntryLibraryId = resolveEntryLibraryId;
  async function handleConfirmTermCandidates(message) {
    return runtime.enqueueTermDiscoveryMutation(async () => {
      const configuration = await runtime.loadConfiguration();
      const libraries = configuration.glossary.libraries;
      const requestedEntries = (Array.isArray(message.entries) ? message.entries : []).map(entry => ({
        source: runtime.termDiscoveryCore.normalizeSource(entry && entry.source),
        candidateSource: runtime.termDiscoveryCore.normalizeSource(entry && (entry.candidateSource || entry.source)),
        target: String(entry && entry.target || "").trim().slice(0, runtime.glossaryCore.MAX_TARGET_LENGTH),
        note: String(entry && entry.note || "").trim().slice(0, runtime.glossaryCore.MAX_NOTE_LENGTH),
        chapterKey: String(entry && entry.chapterKey || "").trim(),
        pageUrl: String(entry && entry.pageUrl || "").trim(),
        libraryId: runtime.glossaryCore.normalizeLibraryId(entry && entry.libraryId)
      })).filter(entry => entry.source && entry.target);
      if (requestedEntries.length === 0) {
        return {
          ok: false,
          error: "请至少填写一个候选术语的译名"
        };
      }
      const stored = await runtime.storageGet([
        runtime.STORAGE_KEYS.glossary,
        runtime.STORAGE_KEYS.glossaryLegacy,
        runtime.STORAGE_KEYS.glossaryPending
      ]);
      const glossary = runtime.glossaryCore.normalizeGlossary(
        stored[runtime.STORAGE_KEYS.glossary] ?? stored[runtime.STORAGE_KEYS.glossaryLegacy]
      );
      const pendingStore = runtime.termDiscoveryCore.normalizePendingStore(stored[runtime.STORAGE_KEYS.glossaryPending]);
      const libraryByChapter = new Map(pendingStore.chapters.map(chapter => [chapter.key, chapter.libraryId]));
      const entries = [...glossary.entries];
      const targetLanguage = configuration.translation.targetLanguage;
      const indexBySource = new Map(entries.flatMap((entry, index) =>
        entry.scope === "global" && entry.targetLanguage === targetLanguage
          ? [[`${entry.libraryId}\u0000${entry.sourceLanguage}>${entry.targetLanguage}:${runtime.termDiscoveryCore.getSourceKey(entry.source)}`, index]]
          : []
      ));
      const confirmedSources = [];
      const pendingSourcesToRemove = [];
      const confirmedLibraries = new Set();
      for (const requested of requestedEntries) {
        const resolvedSource = runtime.languages.resolveSourceLanguage(
          configuration.translation.sourceLanguage, requested.source
        );
        const sourceLanguage = resolvedSource === "auto" ? "ko" : resolvedSource;
        const libraryId = resolveEntryLibraryId(libraries, requested.libraryId, libraryByChapter.get(requested.chapterKey), requested.pageUrl);
        const sourceKey = `${libraryId}\u0000${sourceLanguage}>${targetLanguage}:${runtime.termDiscoveryCore.getSourceKey(requested.source)}`;
        const existingIndex = indexBySource.has(sourceKey) ? indexBySource.get(sourceKey) : -1;
        const existingEntry = existingIndex >= 0 ? entries[existingIndex] : null;
        // 已有条目必须保住原来的 id：服务端按 id 删行，每次确认都换一个新 id 的话，
        // 术语库页删的就是服务端不存在的行（旧版服务端还把 404 包成 500），删完刷新又复活。
        const entryId = existingEntry
          ? existingEntry.id
          : `term-auto-${runtime.hashString(`${libraryId}\u0000${requested.source}\u0000${Date.now()}\u0000${confirmedSources.length}`)}`;
        const entry = runtime.glossaryCore.normalizeGlossaryEntry({
          id: entryId,
          source: requested.source,
          target: requested.target,
          sourceLanguage,
          targetLanguage,
          note: requested.note,
          enabled: true,
          libraryId
        }, entries.length, libraries);
        if (!entry) {
          continue;
        }
        if (existingEntry) {
          entries[existingIndex] = { ...existingEntry, ...entry };
        } else if (entries.length < runtime.glossaryCore.MAX_TOTAL_ENTRIES
          && entries.filter(item => item.libraryId === libraryId).length < runtime.glossaryCore.MAX_ENTRIES_PER_LIBRARY) {
          indexBySource.set(sourceKey, entries.length);
          entries.push(entry);
        } else {
          return {
            ok: false,
            error: `术语库「${runtime.glossaryCore.getLibraryName(libraries, libraryId)}」最多保存 ${runtime.glossaryCore.MAX_ENTRIES_PER_LIBRARY} 条`
          };
        }
        confirmedSources.push(entry.source);
        confirmedLibraries.add(libraryId);
        pendingSourcesToRemove.push(requested.candidateSource, entry.source);
      }
      if (confirmedSources.length === 0) {
        return {
          ok: false,
          error: "没有可加入的候选术语"
        };
      }
      const nextGlossary = runtime.glossaryCore.normalizeGlossary({
        version: runtime.glossaryCore.SCHEMA_VERSION,
        revision: glossary.revision + 1,
        updatedAt: Date.now(),
        libraries: glossary.libraries,
        entries
      });
      const nextPending = runtime.termDiscoveryCore.removeSourcesFromPending(stored[runtime.STORAGE_KEYS.glossaryPending], pendingSourcesToRemove);
      await runtime.storageSet({
        [runtime.STORAGE_KEYS.glossary]: nextGlossary,
        [runtime.STORAGE_KEYS.glossaryPending]: nextPending
      });
      // 同步到本地服务：术语库页面优先展示服务端数据，不同步则面板加入的
      // 术语在术语库搜不到。本地写入始终保留（服务离线时页面回退本地存储）。
      let serverSynced = true;
      let serverError = "";
      const serverUrl = String(configuration.ocr.localPaddle.baseUrl || "").trim();
      if (serverUrl) {
        for (const requested of requestedEntries) {
          const resolvedSource = runtime.languages.resolveSourceLanguage(configuration.translation.sourceLanguage, requested.source);
          const libraryId = resolveEntryLibraryId(libraries, requested.libraryId, libraryByChapter.get(requested.chapterKey), requested.pageUrl);
          const storedEntry = nextGlossary.entries.find(item =>
            item.libraryId === libraryId && item.source === requested.source && item.target === requested.target);
          try {
            await runtime.callGlossaryApi(serverUrl, "/glossary", {
              method: "PUT",
              body: JSON.stringify({
                id: storedEntry ? storedEntry.id : "",
                source: requested.source, target: requested.target, note: requested.note,
                src_lng: resolvedSource === "auto" ? "ko" : resolvedSource, tgt_lng: targetLanguage,
                library_id: libraryId,
                library_name: runtime.glossaryCore.getLibraryName(libraries, libraryId)
              })
            });
          } catch (error) {
            serverSynced = false;
            serverError = runtime.getErrorMessage(error);
            break;
          }
        }
        if (serverSynced) {
          for (const source of pendingSourcesToRemove) {
            await runtime.callGlossaryApi(serverUrl, "/glossary/pending/ignore", {
              method: "POST", body: JSON.stringify({ source })
            }).catch(() => {});
          }
        }
      }
      return {
        ok: true,
        added: confirmedSources.length,
        libraryIds: [...confirmedLibraries],
        // 调用方（侧栏）要把「加进哪个库」说出来 —— 这是本次修复的可见证据。
        libraryNames: [...confirmedLibraries].map(id => runtime.glossaryCore.getLibraryName(libraries, id)),
        serverSynced,
        serverError,
        pendingCount: runtime.termDiscoveryCore.getPendingCount(nextPending)
      };
    });
  }
  runtime.handleConfirmTermCandidates = handleConfirmTermCandidates;
  async function handleIgnoreTermCandidate(message) {
    return runtime.enqueueTermDiscoveryMutation(async () => {
      const stored = await runtime.storageGet([runtime.STORAGE_KEYS.glossaryPending, runtime.STORAGE_KEYS.glossaryIgnored]);
      const next = runtime.termDiscoveryCore.ignoreCandidate({
        store: stored[runtime.STORAGE_KEYS.glossaryPending],
        ignored: stored[runtime.STORAGE_KEYS.glossaryIgnored],
        chapterKey: String(message.chapterKey || ""),
        source: message.source,
        scope: message.scope === "global" ? "global" : "chapter"
      });
      await runtime.storageSet({
        [runtime.STORAGE_KEYS.glossaryPending]: next.store,
        [runtime.STORAGE_KEYS.glossaryIgnored]: next.ignored
      });
      return {
        ok: true,
        pendingCount: runtime.termDiscoveryCore.getPendingCount(next.store)
      };
    });
  }
  runtime.handleIgnoreTermCandidate = handleIgnoreTermCandidate;
}
