export function installMessages(runtime) {
  async function handleMessage(message, sender) {
    switch (message.type) {
      case "OPEN_NOVEL_SIDEPANEL": return runtime.openNovelManageUi(sender, message && message.itemId);
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
      case "EXTRACT_TERMS_FROM_SENTENCE":
        return runtime.handleExtractTermsFromSentence(message);
      case "GET_LLM_MODELS":
        return runtime.handleGetLlmModels(message);
      case "GET_NOVEL_MEMORY":
        return runtime.handleGetNovelMemory(message);
      case "SAVE_NOVEL_MEMORY":
        return runtime.handleSaveNovelMemory(message);
      case "CLEAR_NOVEL_MEMORY":
        return runtime.handleClearNovelMemory(message);
      case "DELETE_NOVEL_MEMORY_CHAPTER":
        return runtime.handleDeleteNovelMemoryChapter(message);
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
      case "RESET_TERM_DISCOVERY_PROCESSED":
        return runtime.handleResetTermDiscoveryProcessed();
      case "SET_PENDING_CHAPTER_LIBRARY":
        return runtime.handleSetPendingChapterLibrary(message);
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
  runtime.GLOSSARY_API_TIMEOUT_MS = 10000; // Glossary REST API helpers (server-side SQLite storage)
}
