export function installMessages(runtime) {
  async function handleMessage(message, sender) {
    switch (message.type) {
      case "OPEN_NOVEL_SIDEPANEL": return chrome.sidePanel?.open?.({ windowId: sender.tab?.windowId }).then(() => ({ ok: true }))  // Chrome 116+: open side panel in sender's window
          .catch(error => ({ ok: false, error: error?.message || String(error) })) || { ok: false, error: "Chrome 不支持 sidePanel API" };
      case "FETCH_IMAGE_DATA_URL": return runtime.handleFetchImageDataUrl(message);
      case "CAPTURE_VISIBLE_TARGET_DATA_URL":
        return runtime.handleCaptureVisibleTargetDataUrl(message, sender);
      case "OCR_DATA_URL":
        return runtime.handleOcrDataUrl(message);
      case "TRANSLATE_TEXT_BLOCKS":
        return runtime.handleTranslateTextBlocks(message, sender);
      case "TRANSLATE_NOVEL_CHUNK":
        return runtime.handleTranslateNovelChunk(message, sender);
      case "EXTRACT_TERM_FROM_CONTEXT":
        return runtime.handleExtractTermFromContext(message);
      case "GET_NOVEL_MEMORY":
        return runtime.handleGetNovelMemory(message);
      case "SAVE_NOVEL_MEMORY":
        return runtime.handleSaveNovelMemory(message);
      case "CLEAR_NOVEL_MEMORY":
        return runtime.handleClearNovelMemory(message);
      case "GET_CACHE_STATS":
        return runtime.handleGetCacheStats();
      case "CLEAR_CACHE":
        return runtime.handleClearCache();
      case "CLEAR_DUPLICATE_TRANSLATIONS":
        return runtime.dedupeTranslationCacheRecords();
      case "GET_TRANSLATION_CACHE":
      case "GET_TRANSLATION_CACHE_BATCH":
      case "GET_TRANSLATION_CACHE_BY_HASH":
      case "GET_TRANSLATION_CACHE_BY_TRANSLATION_KEY":
      case "GET_WEBPAGE_TRANSLATION_CACHE_FALLBACKS":
      case "SAVE_TRANSLATION_CACHE":
      case "SAVE_TRANSLATION_CACHE_BATCH":
      case "DELETE_TRANSLATION_CACHE":
      case "CLEAR_TRANSLATION_CACHE_MODE":
        return runtime.handleTranslationCacheMessage(message);
      case "GET_TRANSLATION_CONFIG_FINGERPRINT":
        return runtime.getTranslationConfigFingerprint(message && message.mode).then(fingerprint => ({ ok: true, fingerprint }));
      case "CANCEL_TRANSLATION_TASK":
        return runtime.handleCancelTranslationTask(message);
      case "GET_WEBPAGE_TAB_STATE":
        return runtime.handleGetWebpageTabState(message, sender);
      case "SET_WEBPAGE_TAB_STATE":
        return runtime.handleSetWebpageTabState(message, sender);
      case "CLEAR_WEBPAGE_TAB_STATE":
        return runtime.handleClearWebpageTabState(message, sender);
      case "REPORT_STATUS":
        return runtime.handleReportStatus(message, sender);
      case "GET_TAB_STATUS":
        return runtime.handleGetTabStatus(message);
      case "GET_SETTINGS":
        return {
          ok: true,
          settings: await runtime.loadSettings()
        };
      case "DISCOVER_TERMS":
        return runtime.handleDiscoverTerms(message);
      case "GET_TERM_DISCOVERY_STATUS":
        return runtime.handleGetTermDiscoveryStatus(message);
      case "GET_TERM_DISCOVERY_STATE":
        return runtime.handleGetTermDiscoveryState(message);
      case "SET_TERM_DISCOVERY_ENABLED":
        return runtime.handleSetTermDiscoveryEnabled(message);
      case "CONFIRM_TERM_CANDIDATES":
        return runtime.handleConfirmTermCandidates(message);
      case "IGNORE_TERM_CANDIDATE":
        return runtime.handleIgnoreTermCandidate(message);
      case "IGNORE_TERM_CANDIDATES":
        return runtime.handleIgnoreTermCandidates(message);
      case "RESTORE_IGNORED_TERM":
        return runtime.handleRestoreIgnoredTerm(message);
      case "START_LOCAL_OCR":
        return runtime.handleStartLocalOcr();
      case "STOP_LOCAL_OCR":
        return runtime.handleStopLocalOcr();
      case "PING_LOCAL_OCR":
        return runtime.handlePingLocalOcr();
      default:
        return {
          ok: false,
          error: `Unknown message type: ${message.type}`
        };
    }
  }
  runtime.handleMessage = handleMessage;
  async function handleDiscoverTerms(message) {
    return runtime.enqueueTermDiscoveryMutation(async () => {
      const configuration = await runtime.loadConfiguration();
      const stored = await runtime.storageGet([runtime.STORAGE_KEYS.glossaryPending, runtime.STORAGE_KEYS.glossaryIgnored]);
      if (configuration.runtime.termDiscoveryEnabled === false) {
        return {
          ok: true,
          skipped: true,
          reason: "disabled"
        };
      }
      const pageUrl = String(message.pageUrl || "").trim();
      const targetKey = String(message.targetKey || "").trim();
      // 自动忽略来源（小说名等）先于冷却/去重早退写入，保证提取器离线时也生效。
      const { store, ignored } = await runtime.applyAutoIgnoreSources(stored, message.autoIgnoreSources, pageUrl);
      const blocks = runtime.termDiscoveryCore.getUnprocessedBlocks(store, pageUrl, message.blocks, targetKey);
      if (blocks.length === 0) {
        return {
          ok: true,
          skipped: true,
          reason: "already_processed"
        };
      }
      if (runtime.isTermExtractorCoolingDown()) {
        return {
          ok: true,
          skipped: true,
          reason: "cooldown",
          status: runtime.getTermExtractorStatusSnapshot()
        };
      }
      const baseUrl = runtime.sanitizeLocalOcrBaseUrl(configuration.ocr.localPaddle.baseUrl);
      try {
        const payload = await runtime.requestTermExtractorJson(`${baseUrl}/terms/extract`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            mode: "balanced",
            blocks: blocks.map(block => ({
              id: block.id,
              text: block.originalText
            })),
            user_terms: [...configuration.glossary.entries.map(entry => entry.source), ...store.chapters.flatMap(chapter => chapter.candidates).filter(candidate => candidate.kind === "person").map(candidate => candidate.source)].slice(0, 200)
          })
        });
        runtime.markTermExtractorOnline();
        const nextPending = runtime.termDiscoveryCore.mergeDiscoveryResult({
          store,
          ignored,
          glossary: configuration.glossary,
          pageUrl,
          pageTitle: message.pageTitle,
          targetKey,
          blocks,
          extractedCandidates: payload && payload.candidates
        });
        await runtime.storageSet({
          [runtime.STORAGE_KEYS.glossaryPending]: nextPending
        });
        // 服务端同步待确认候选
        try {
          const serverUrl = await runtime.isGlossaryServerMode();
          if (serverUrl && payload && payload.candidates) {
            for (const candidate of payload.candidates) {
              await runtime.callGlossaryApi(serverUrl, "/glossary/pending", {
                method: "POST",
                body: JSON.stringify({
                  source: candidate.source,
                  kind: candidate.kind || "proper_noun",
                  score: candidate.score || 0,
                  evidence_ids: candidate.evidenceIds || [],
                  chapter_key: pageUrl
                })
              }).catch(() => {});
            }
          }
        } catch (_) {}
        return {
          ok: true,
          added: runtime.termDiscoveryCore.getPendingCount(nextPending) - runtime.termDiscoveryCore.getPendingCount(store),
          pendingCount: runtime.termDiscoveryCore.getPendingCount(nextPending),
          status: runtime.getTermExtractorStatusSnapshot()
        };
      } catch (error) {
        runtime.markTermExtractorOffline(error);
        console.warn("[MangaTranslator] 术语提取器暂时不可用：", runtime.getErrorMessage(error));
        return {
          ok: true,
          skipped: true,
          reason: "offline",
          status: runtime.getTermExtractorStatusSnapshot()
        };
      }
    });
  }
  runtime.handleDiscoverTerms = handleDiscoverTerms;
  async function handleGetTermDiscoveryStatus(message = {}) {
    const [configuration, stored] = await Promise.all([
      runtime.loadConfiguration(),
      runtime.storageGet([runtime.STORAGE_KEYS.glossaryPending])
    ]);
    const enabled = configuration.runtime.termDiscoveryEnabled !== false;
    if (enabled && message.probe === true) {
      await runtime.probeTermExtractor(configuration.ocr.localPaddle.baseUrl);
    }
    return {
      ok: true,
      enabled,
      pendingCount: runtime.termDiscoveryCore.getPendingCount(stored[runtime.STORAGE_KEYS.glossaryPending]),
      status: enabled ? runtime.getTermExtractorStatusSnapshot() : {
        ...runtime.getTermExtractorStatusSnapshot(),
        state: "disabled"
      }
    };
  }
  runtime.handleGetTermDiscoveryStatus = handleGetTermDiscoveryStatus;
  async function handleGetTermDiscoveryState(message = {}) {
    const [configuration, stored] = await Promise.all([
      runtime.loadConfiguration(),
      runtime.storageGet([runtime.STORAGE_KEYS.glossaryPending, runtime.STORAGE_KEYS.glossaryIgnored])
    ]);
    const enabled = configuration.runtime.termDiscoveryEnabled !== false;
    if (enabled && message.probe === true) {
      await runtime.probeTermExtractor(configuration.ocr.localPaddle.baseUrl);
    }
    const pending = runtime.termDiscoveryCore.normalizePendingStore(stored[runtime.STORAGE_KEYS.glossaryPending]);
    return {
      ok: true,
      enabled,
      pending,
      ignored: runtime.termDiscoveryCore.normalizeIgnoredStore(stored[runtime.STORAGE_KEYS.glossaryIgnored]),
      pendingCount: runtime.termDiscoveryCore.getPendingCount(pending),
      status: enabled ? runtime.getTermExtractorStatusSnapshot() : {
        ...runtime.getTermExtractorStatusSnapshot(),
        state: "disabled"
      }
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
  async function handleConfirmTermCandidates(message) {
    return runtime.enqueueTermDiscoveryMutation(async () => {
      const configuration = await runtime.loadConfiguration();
      const requestedEntries = (Array.isArray(message.entries) ? message.entries : []).map(entry => ({
        source: runtime.termDiscoveryCore.normalizeSource(entry && entry.source),
        candidateSource: runtime.termDiscoveryCore.normalizeSource(entry && (entry.candidateSource || entry.source)),
        target: String(entry && entry.target || "").trim().slice(0, runtime.glossaryCore.MAX_TARGET_LENGTH),
        note: String(entry && entry.note || "").trim().slice(0, runtime.glossaryCore.MAX_NOTE_LENGTH)
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
      const entries = [...glossary.entries];
      const targetLanguage = configuration.translation.targetLanguage;
      const indexBySource = new Map(entries.flatMap((entry, index) =>
        entry.scope === "global" && entry.targetLanguage === targetLanguage
          ? [[`${entry.sourceLanguage}>${entry.targetLanguage}:${runtime.termDiscoveryCore.getSourceKey(entry.source)}`, index]]
          : []
      ));
      const confirmedSources = [];
      const pendingSourcesToRemove = [];
      for (const requested of requestedEntries) {
        const resolvedSource = runtime.languages.resolveSourceLanguage(
          configuration.translation.sourceLanguage, requested.source
        );
        const sourceLanguage = resolvedSource === "auto" ? "ko" : resolvedSource;
        const sourceKey = `${sourceLanguage}>${targetLanguage}:${runtime.termDiscoveryCore.getSourceKey(requested.source)}`;
        const entry = runtime.glossaryCore.normalizeGlossaryEntry({
          id: `term-auto-${runtime.hashString(`${requested.source}\u0000${Date.now()}\u0000${confirmedSources.length}`)}`,
          source: requested.source,
          target: requested.target,
          sourceLanguage,
          targetLanguage,
          note: requested.note,
          enabled: true
        });
        if (!entry) {
          continue;
        }
        if (indexBySource.has(sourceKey)) {
          entries[indexBySource.get(sourceKey)] = {
            ...entries[indexBySource.get(sourceKey)],
            ...entry
          };
        } else if (entries.length < runtime.glossaryCore.MAX_ENTRIES) {
          indexBySource.set(sourceKey, entries.length);
          entries.push(entry);
        } else {
          return {
            ok: false,
            error: `术语库最多保存 ${runtime.glossaryCore.MAX_ENTRIES} 条`
          };
        }
        confirmedSources.push(entry.source);
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
        for (const entry of requestedEntries) {
          const resolvedSource = runtime.languages.resolveSourceLanguage(configuration.translation.sourceLanguage, entry.source);
          try {
            await runtime.callGlossaryApi(serverUrl, "/glossary", {
              method: "PUT",
              body: JSON.stringify({
                source: entry.source, target: entry.target, note: entry.note,
                src_lng: resolvedSource === "auto" ? "ko" : resolvedSource, tgt_lng: targetLanguage
              })
            });
          } catch (error) {
            serverSynced = false;
            serverError = runtime.getErrorMessage(error);
            break;
          }
        }
        if (serverSynced) {
          for (const src of pendingSourcesToRemove) {
            await runtime.callGlossaryApi(serverUrl, "/glossary/pending/ignore", {
              method: "POST", body: JSON.stringify({ source: src })
            }).catch(() => {});
          }
        }
      }
      return {
        ok: true,
        added: confirmedSources.length,
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
      // 服务端同步
      try {
        const serverUrl = await runtime.isGlossaryServerMode();
        if (serverUrl && message.scope === "global") {
          await runtime.callGlossaryApi(serverUrl, "/glossary/pending/ignore", {
            method: "POST",
            body: JSON.stringify({
              source: message.source
            })
          }).catch(() => {});
        }
      } catch (_) {}
      return {
        ok: true,
        pendingCount: runtime.termDiscoveryCore.getPendingCount(next.store)
      };
    });
  }
  runtime.handleIgnoreTermCandidate = handleIgnoreTermCandidate;
  runtime.GLOSSARY_API_TIMEOUT_MS = 10000; // Glossary REST API helpers (server-side SQLite storage)
}
