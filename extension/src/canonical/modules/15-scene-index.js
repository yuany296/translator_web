export function installPipeline15(runtime) {
  function buildCleanedArtifactKey(imageRevision, masks) {
    return `${String(imageRevision || "")}:canonical-mask-v1:${runtime.buildCleanedMaskFingerprint(masks)}`;
  }
  runtime.buildCleanedArtifactKey = buildCleanedArtifactKey;
  function collectCrossPageCanonicalIds(projectionsByPage, canonicals = []) {
    const pageIdsByCanonical = new Map();
    for (const [fallbackPageId, projections] of projectionsByPage instanceof Map ? projectionsByPage.entries() : []) {
      for (const projection of Array.isArray(projections) ? projections : []) {
        const canonicalId = String(projection && projection.canonicalId || "");
        const pageId = String(projection && projection.pageId || fallbackPageId || "");
        if (!canonicalId || !pageId) continue;
        if (!pageIdsByCanonical.has(canonicalId)) pageIdsByCanonical.set(canonicalId, new Set());
        pageIdsByCanonical.get(canonicalId).add(pageId);
      }
    }
    const result = new Set([...pageIdsByCanonical.entries()].filter(([, pageIds]) => pageIds.size > 1).map(([canonicalId]) => canonicalId));
    for (const canonical of Array.isArray(canonicals) ? canonicals : []) {
      if (canonical && Object.keys(canonical.geometryByPage || {}).length > 1) {
        result.add(String(canonical.id || ""));
      }
    }
    result.delete("");
    return result;
  }
  runtime.collectCrossPageCanonicalIds = collectCrossPageCanonicalIds;
  function isDataUrlValue(value) {
    return /^data:[^,]+,/i.test(String(value || ""));
  }
  runtime.isDataUrlValue = isDataUrlValue;
  function appendProvisionalProjectionFallbacks({
    grouped,
    previousProjections,
    currentCanonicals,
    activeStore,
    isPageAvailable
  }) {
    const previous = [...(previousProjections instanceof Map ? previousProjections.values() : [])].flat();
    const claimedPreviousCanonicalIds = new Set();
    for (const canonical of [...(currentCanonicals || [])].sort(runtime.compareCanonicalRecords)) {
      if (activeStore.getTranslation(canonical.id, canonical.revision)) continue;
      const lineageIds = [canonical.id, canonical.supersedesId].filter(Boolean).map(String);
      const previousId = lineageIds.find(id => !claimedPreviousCanonicalIds.has(id) && previous.some(projection => String(projection.canonicalId || "") === id));
      if (!previousId) continue;
      const candidates = previous.filter(projection => String(projection.canonicalId || "") === previousId);
      const translationText = String(candidates.find(projection => String(projection.translated_text || projection.translatedText || "").trim())?.translated_text || candidates.find(projection => String(projection.translatedText || "").trim())?.translatedText || "");
      if (!translationText) continue;
      claimedPreviousCanonicalIds.add(previousId);
      const textCandidates = candidates.filter(projection => projection.role !== "cover" && projection.coverOnly !== true);
      const preferredPageId = String(textCandidates[0] && textCandidates[0].preferredPrimaryPageId || textCandidates.find(projection => projection.activeText)?.pageId || "");
      const activePageId = preferredPageId && isPageAvailable(preferredPageId) ? preferredPageId : String(textCandidates.find(projection => isPageAvailable(projection.pageId))?.pageId || "");
      for (const projection of candidates) {
        const isCover = projection.role === "cover" || projection.coverOnly === true;
        const activeText = !isCover && !!activePageId && String(projection.pageId) === activePageId;
        const clone = Object.freeze({
          ...projection,
          provisional: true,
          pendingCanonicalId: canonical.id,
          pendingCanonicalRevision: canonical.revision,
          active: isCover ? projection.active !== false : activeText,
          activeText,
          translated_text: activeText ? translationText : "",
          translatedText: activeText ? translationText : "",
          bubble: projection.bubble ? Object.freeze({
            ...projection.bubble,
            translated_text: activeText ? translationText : "",
            projection_active: isCover ? projection.active !== false : activeText
          }) : projection.bubble
        });
        if (!grouped.has(clone.pageId)) grouped.set(clone.pageId, []);
        grouped.get(clone.pageId).push(clone);
      }
    }
    for (const items of grouped.values()) items.sort(runtime.compareProjectionRecords);
  }

  /* =================================================================
   * 内部工具函数（独立于 adapters）
   * ================================================================= */
  runtime.appendProvisionalProjectionFallbacks = appendProvisionalProjectionFallbacks;
  function normalizeResult(result) {
    if (!result || typeof result !== "object") return {
      bubbles: []
    };
    if (!Array.isArray(result.bubbles)) return {
      ...result,
      bubbles: []
    };
    return result;
  }
  runtime.normalizeResult = normalizeResult;
  function buildOcrRequestKey(targetKey, payload) {
    const mode = String(payload && payload.ocrMode || "single");
    const sourceToken = String(payload && payload.sourceToken || "");
    const reason = String(payload && (payload.fallbackReason || payload.stitchRejectionReason) || "");
    const stitchKey = String(payload && payload.stitchKey || "");
    return [String(targetKey || ""), `src:${runtime.hashFnv1a(sourceToken)}`, `mode:${mode}`, reason ? `reason:${runtime.hashFnv1a(reason)}` : "", stitchKey ? `stitch:${runtime.hashFnv1a(stitchKey)}` : ""].filter(Boolean).join("|");
  }
  runtime.buildOcrRequestKey = buildOcrRequestKey;
  function hashFnv1a(text) {
    const t = String(text || "");
    let hash = 2166136261;
    for (let i = 0; i < t.length; i += 1) {
      hash ^= t.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
  }
  runtime.hashFnv1a = hashFnv1a;
  function buildSingleFallbackPayload(singlePayload, stitchedPayload, fallbackReason) {
    const reason = String(fallbackReason || "stitched result rejected").trim();
    return {
      ...singlePayload,
      ocrMode: "single-fallback",
      sourceToken: String(stitchedPayload && stitchedPayload.sourceToken || singlePayload && singlePayload.sourceToken || ""),
      fallbackReason: reason,
      stitchAdmission: "fallback"
    };
  }
  runtime.buildSingleFallbackPayload = buildSingleFallbackPayload;
  function getErrorMessage(error) {
    if (!error) return "unknown error";
    if (typeof error === "string") return error;
    if (error.message) return error.message;
    return String(error);
  }
  runtime.getErrorMessage = getErrorMessage;
  function isScreenshotTargetNotVisibleError(reason) {
    return reason === "Target is not visible enough for screenshot capture";
  }
  runtime.isScreenshotTargetNotVisibleError = isScreenshotTargetNotVisibleError;
  function hasAttachedShortPageBubble(result) {
    return !!(result && Array.isArray(result.bubbles) && result.bubbles.some(b => b && b.stitch_attached_short_page === true));
  }
  runtime.hasAttachedShortPageBubble = hasAttachedShortPageBubble;
  function extractAttachedShortPageKeys(renderPayload) {
    if (renderPayload && Array.isArray(renderPayload.attachedShortPageKeys)) {
      return renderPayload.attachedShortPageKeys.filter(Boolean);
    }
    return [];
  }

  /**
   * 跨图去重（内部使用 Store 的串行化事务）
   */
  runtime.extractAttachedShortPageKeys = extractAttachedShortPageKeys;
}
