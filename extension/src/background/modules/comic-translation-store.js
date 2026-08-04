export function installComicTranslationStore(runtime) {
  function buildComicDescriptors(items, sourceLanguage, targetLanguage, options = {}) {
    const scopeKey = String(options.scopeKey || "comic:unknown");
    return items.map(item => {
      const normalized = runtime.normalizeTranslationSourceText(item.original_text);
      const sourceHash = runtime.stableHash128(normalized);
      const segmentKey = String(item.id || "");
      const recordKey = `comic:${runtime.stableHash128([
        scopeKey, segmentKey, sourceHash, sourceLanguage, targetLanguage
      ].join("\u0000"))}`;
      return {
        item, recordKey,
        payload: {
          mode: "comic", scopeKey, segmentKey,
          workId: String(options.workId || ""), chapterId: String(options.chapterId || ""),
          pageKey: String(options.pageKey || ""), rawSourceText: item.original_text,
          normalizedSourceText: normalized, rawSourceHash: runtime.stableHash128(item.original_text),
          normalizedSourceHash: sourceHash,
          configuredSourceLanguage: String(options.configuredSourceLanguage || sourceLanguage),
          resolvedSourceLanguage: sourceLanguage, targetLanguage,
          recovery: {
            imageHash: String(options.imageHash || ""), pageIndex: Number(options.pageIndex) || 0,
            blockId: segmentKey
          }
        }
      };
    });
  }
  runtime.buildComicTranslationDescriptors = buildComicDescriptors;

  function addSnapshotsToOutcome(descriptors, snapshots, outcome) {
    const byKey = new Map((snapshots || []).map(snapshot => [snapshot.recordKey, snapshot]));
    descriptors.forEach(descriptor => {
      const snapshot = byKey.get(descriptor.recordKey);
      const translatedText = String(snapshot?.activeVersion?.translatedText || "").trim();
      if (!translatedText) return;
      outcome.set(runtime.canonicalTranslationItemKey(descriptor.item), {
        translatedText, translationFingerprint: String(snapshot.activeVersion?.configFingerprint || ""),
        cached: true, official: true
      });
    });
  }

  async function loadComicTranslations(descriptors) {
    const outcome = new Map();
    const recordKeys = descriptors.map(item => item.recordKey);
    const local = await runtime.getTranslationCacheRecords(recordKeys);
    addSnapshotsToOutcome(descriptors, [...local.values()].filter(record => record?.recordId).map(record => ({
      ...record, recordKey: record.recordKey || record.id,
      activeVersion: {
        translatedText: record.translatedText,
        configFingerprint: record.translationConfigFingerprint
      }
    })), outcome);
    const response = await runtime.syncTranslationService(recordKeys);
    if (!response.ok) return { outcome, online: false, error: response.error };
    const officialKeys = new Set((response.records || []).map(record => record.recordKey));
    for (const recordKey of recordKeys) {
      if (!officialKeys.has(recordKey)) await runtime.deleteTranslationCacheRecord(recordKey);
    }
    const officialOutcome = new Map();
    addSnapshotsToOutcome(descriptors, response.records || [], officialOutcome);
    return { outcome: officialOutcome, online: true };
  }
  runtime.loadOfficialComicTranslations = loadComicTranslations;

  async function commitComicTranslations(descriptors, outcome, fingerprint) {
    const operations = descriptors.flatMap(descriptor => {
      const result = outcome.get(runtime.canonicalTranslationItemKey(descriptor.item));
      if (!result?.translatedText || result.official) return [];
      return [{
        operationId: crypto.randomUUID(), type: "commit_translation",
        recordKey: descriptor.recordKey,
        payload: {
          ...descriptor.payload, translatedText: result.translatedText,
          source: "api", configFingerprint: fingerprint
        }, createdAt: Date.now()
      }];
    });
    const pending = new Set();
    if (!operations.length) return pending;
    try {
      const response = await runtime.submitTranslationOperations(operations);
      const snapshots = (response.results || []).map(item => item.record).filter(Boolean);
      await runtime.saveTranslationServiceSnapshots(snapshots);
    } catch {
      for (const operation of operations) {
        await runtime.queuePendingTranslationOperation(operation);
        pending.add(operation.recordKey);
      }
    }
    return pending;
  }
  runtime.commitOfficialComicTranslations = commitComicTranslations;
}
