export function installMessages(runtime) {
  async function handleMessage(message, sender) {
    switch (message.type) {
      case "FETCH_IMAGE_DATA_URL":
        return runtime.handleFetchImageDataUrl(message);
      case "CAPTURE_VISIBLE_TARGET_DATA_URL":
        return runtime.handleCaptureVisibleTargetDataUrl(message, sender);
      case "OCR_DATA_URL":
        return runtime.handleOcrDataUrl(message);
      case "TRANSLATE_TEXT_BLOCKS":
        return runtime.handleTranslateTextBlocks(message);
      case "GET_CACHE_STATS":
        return runtime.handleGetCacheStats();
      case "CLEAR_CACHE":
        return runtime.handleClearCache();
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
      const stored = await runtime.storageGet([
        runtime.STORAGE_KEYS.glossaryPending, runtime.STORAGE_KEYS.glossaryIgnored
      ]);
      if (configuration.runtime.termDiscoveryEnabled === false) {
        return {
          ok: true,
          skipped: true,
          reason: "disabled"
        };
      }
      const pageUrl = String(message.pageUrl || "").trim();
      const targetKey = String(message.targetKey || "").trim();
      const pending = runtime.termDiscoveryCore.normalizePendingStore(stored[runtime.STORAGE_KEYS.glossaryPending]);
      const blocks = runtime.termDiscoveryCore.getUnprocessedBlocks(pending, pageUrl, message.blocks, targetKey);
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
            user_terms: [...configuration.glossary.entries.map(entry => entry.source), ...pending.chapters.flatMap(chapter => chapter.candidates).filter(candidate => candidate.kind === "person").map(candidate => candidate.source)].slice(0, 200)
          })
        });
        runtime.markTermExtractorOnline();
        const nextPending = runtime.termDiscoveryCore.mergeDiscoveryResult({
          store: pending,
          ignored: stored[runtime.STORAGE_KEYS.glossaryIgnored],
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
          added: runtime.termDiscoveryCore.getPendingCount(nextPending) - runtime.termDiscoveryCore.getPendingCount(pending),
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
      const stored = await runtime.storageGet([runtime.STORAGE_KEYS.glossary, runtime.STORAGE_KEYS.glossaryPending]);
      const glossary = runtime.glossaryCore.normalizeGlossary(stored[runtime.STORAGE_KEYS.glossary]);
      const entries = [...glossary.entries];
      const indexBySource = new Map(entries.map((entry, index) => [runtime.termDiscoveryCore.getSourceKey(entry.source), index]));
      const confirmedSources = [];
      const pendingSourcesToRemove = [];
      for (const requested of requestedEntries) {
        const sourceKey = runtime.termDiscoveryCore.getSourceKey(requested.source);
        const entry = runtime.glossaryCore.normalizeGlossaryEntry({
          id: `term-auto-${runtime.hashString(`${requested.source}\u0000${Date.now()}\u0000${confirmedSources.length}`)}`,
          source: requested.source,
          target: requested.target,
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
      // 服务端模式同步
      try {
        const serverUrl = await runtime.isGlossaryServerMode();
        if (serverUrl) {
          for (const entry of requestedEntries) {
            await runtime.callGlossaryApi(serverUrl, "/glossary", {
              method: "PUT",
              body: JSON.stringify({
                source: entry.source,
                target: entry.target,
                note: entry.note
              })
            }).catch(() => {});
          }
          for (const src of pendingSourcesToRemove) {
            await runtime.callGlossaryApi(serverUrl, "/glossary/pending/ignore", {
              method: "POST",
              body: JSON.stringify({
                source: src
              })
            }).catch(() => {});
          }
        }
      } catch (_) {/* 服务端同步失败不影响本地 */}
      return {
        ok: true,
        added: confirmedSources.length,
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

  // Glossary REST API helpers (for server-side storage via SQLite)
  const GLOSSARY_API_TIMEOUT_MS = 10000;
  runtime.GLOSSARY_API_TIMEOUT_MS = GLOSSARY_API_TIMEOUT_MS;
}
