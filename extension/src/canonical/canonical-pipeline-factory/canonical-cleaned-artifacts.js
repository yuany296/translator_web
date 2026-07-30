export function installCanonicalCleanedArtifacts(runtime, scope) {
  async function refreshRequiredCleanedArtifacts(projectionsByPage, seamSurfaceIndex = null) {
    const tasks = [];
    const artifactPlan = runtime.buildCleanedArtifactProjectionPlan(projectionsByPage, seamSurfaceIndex);
    for (const [pageId, projections] of artifactPlan.entries()) {
      if (!runtime.projectionsRequireCleanedImage(projections)) continue;
      const handle = scope.store.getPageHandle(pageId);
      if (!handle || !handle.payload) continue;
      const cleanedMasks = runtime.buildCanonicalCleanMasks(projections);
      const artifactKey = runtime.buildCleanedArtifactKey(handle.imageRevision, cleanedMasks);
      if (handle.cleanedImageArtifactKey === artifactKey && runtime.isDataUrlValue(handle.cleanedImage)) continue;
      if (handle.artifactRefreshAttemptedKey === artifactKey) continue;
      if (handle.artifactRefreshRetryKey === artifactKey && Number(handle.artifactRefreshRetryAfter || 0) > scope.now()) continue;
      if (handle.artifactRefreshRetryTimer && typeof scope.clearTimer === "function") {
        scope.clearTimer(handle.artifactRefreshRetryTimer);
      }
      scope.store.registerPageHandle({
        ...handle,
        artifactRefreshAttemptedRevision: handle.imageRevision,
        artifactRefreshAttemptedKey: artifactKey,
        artifactRefreshRetryKey: "",
        artifactRefreshRetryAfter: 0,
        artifactRefreshRetryTimer: null
      });
      const releaseArtifactAttempt = () => {
        const current = scope.store.getPageHandle(handle.pageId);
        if (current && current.imageRevision === handle.imageRevision && current.artifactRefreshAttemptedKey === artifactKey) {
          const failureCount = current.artifactRefreshFailureKey === artifactKey ? Number(current.artifactRefreshFailureCount || 0) + 1 : 1;
          const shouldSchedule = failureCount <= runtime.KAKAO_CLEANED_ARTIFACT_AUTO_RETRY_LIMIT && typeof scope.setTimer === "function";
          let retryTimer = null;
          if (shouldSchedule) {
            retryTimer = scope.setTimer(() => {
              const latest = scope.store.getPageHandle(handle.pageId);
              if (!latest || latest.imageRevision !== handle.imageRevision || latest.artifactRefreshRetryKey !== artifactKey || latest.artifactRefreshRetryTimer !== retryTimer) return;
              scope.store.registerPageHandle({
                ...latest,
                artifactRefreshRetryAfter: 0,
                artifactRefreshRetryTimer: null
              });
              if (!scope.isPageAvailable(handle.pageId)) return;
              void scope.refreshCanonicalState({
                reason: "cleaned-artifact-retry",
                focusPageIds: [handle.pageId]
              }).catch(error => {
                scope.trace("cleaned-artifact-retry-error", handle.target, {
                  pageId: handle.pageId,
                  error: runtime.getErrorMessage(error)
                });
              });
            }, runtime.KAKAO_CLEANED_ARTIFACT_RETRY_COOLDOWN_MS);
          }
          scope.store.registerPageHandle({
            ...current,
            artifactRefreshAttemptedKey: "",
            artifactRefreshRetryKey: artifactKey,
            artifactRefreshRetryAfter: scope.now() + runtime.KAKAO_CLEANED_ARTIFACT_RETRY_COOLDOWN_MS,
            artifactRefreshRetryTimer: retryTimer,
            artifactRefreshFailureKey: artifactKey,
            artifactRefreshFailureCount: failureCount
          });
        }
      };
      tasks.push(scope.store.getOrCreateInflightJob(`canonical-cleaned-artifact:${handle.pageId}:${artifactKey}`, async () => {
        try {
          const response = await scope.requestOcrForPayload(handle.payload, runtime.buildOcrMeta("page", [handle], "", {
            requireCleanedImage: true,
            forceCleanedImageArtifact: true,
            cleanedMasks
          }));
          if (!response || !response.ok) {
            scope.trace("cleaned-artifact-error", handle.target, {
              pageId: handle.pageId,
              error: response && response.error || "artifact refresh failed"
            });
            releaseArtifactAttempt();
            return;
          }
          const cleanedImage = response.result && (response.result.cleanedImage || response.result.cleaned_image);
          if (!runtime.isDataUrlValue(cleanedImage)) {
            scope.trace("cleaned-artifact-error", handle.target, {
              pageId: handle.pageId,
              error: "artifact refresh returned no cleaned image"
            });
            releaseArtifactAttempt();
            return;
          }
          const current = scope.store.getPageHandle(handle.pageId);
          if (!current || current.imageRevision !== handle.imageRevision || current.artifactRefreshAttemptedKey !== artifactKey) return;
          scope.store.registerPageHandle({
            ...current,
            cleanedImage,
            cleanedImageRevision: current.imageRevision,
            cleanedImageArtifactKey: artifactKey,
            artifactRefreshRetryKey: "",
            artifactRefreshRetryAfter: 0,
            artifactRefreshRetryTimer: null,
            artifactRefreshFailureKey: "",
            artifactRefreshFailureCount: 0,
            ocrDebug: response.result && response.result.debug || current.ocrDebug || null
          });
        } catch (error) {
          scope.trace("cleaned-artifact-error", handle.target, {
            pageId: handle.pageId,
            error: runtime.getErrorMessage(error)
          });
          releaseArtifactAttempt();
        }
      }));
    }
    tasks.push(...runtime.buildSeamCleanedArtifactPlan(seamSurfaceIndex).map(plan =>
      refreshSeamCleanedArtifact(plan)));
    await Promise.all(tasks);
  }
  scope.refreshRequiredCleanedArtifacts = refreshRequiredCleanedArtifacts;

  async function refreshSeamCleanedArtifact(plan) {
    const state = scope.store.getSeamState(plan.pairKey);
    if (!state || state.status !== "completed" || !runtime.isDataUrlValue(state.cleanedImage)) return;
    const records = plan.pageIds.map(pageId => scope.store.getPageHandle(pageId));
    if (records.some(record => !record)) return;
    const artifactKey = runtime.buildCleanedArtifactKey(plan.revisionKey, plan.cleanedMasks);
    if (state.cleanedImageArtifactKey === artifactKey) return;
    if (state.cleanedImageArtifactAttemptedKey === artifactKey) return;
    if (state.cleanedImageArtifactRetryKey === artifactKey &&
        Number(state.cleanedImageArtifactRetryAfter || 0) > scope.now()) return;
    scope.store.markSeamState(plan.pairKey, {
      ...state,
      cleanedImageArtifactAttemptedKey: artifactKey,
      cleanedImageArtifactRetryKey: "",
      cleanedImageArtifactRetryAfter: 0
    });
    const sourcePayload = runtime.buildSeamCleanedArtifactPayload(state);
    try {
      const response = await scope.store.getOrCreateInflightJob(
        `canonical-seam-cleaned-artifact:${plan.pairKey}:${artifactKey}`,
        () => scope.requestOcrForPayload(sourcePayload, runtime.buildOcrMeta("seam", records,
          plan.pairKey, {
            requireCleanedImage: true,
            forceCleanedImageArtifact: true,
            cleanedMasks: plan.cleanedMasks
          }))
      );
      const cleanedImage = response && response.ok && response.result &&
        (response.result.cleanedImage || response.result.cleaned_image);
      const current = scope.store.getSeamState(plan.pairKey);
      if (!current || current.cleanedImageArtifactAttemptedKey !== artifactKey) return;
      if (!runtime.isDataUrlValue(cleanedImage)) {
        releaseSeamArtifactAttempt(current, artifactKey);
        return;
      }
      scope.store.markSeamState(plan.pairKey, {
        ...current,
        cleanedImage,
        cleanedImageToken: String(response.result.cleanedImageToken ||
          response.result.cleaned_image_token || artifactKey),
        cleanedImageArtifactKey: artifactKey,
        cleanedImageArtifactAttemptedKey: "",
        cleanedImageArtifactRetryKey: "",
        cleanedImageArtifactRetryAfter: 0
      });
    } catch (error) {
      const current = scope.store.getSeamState(plan.pairKey);
      if (current && current.cleanedImageArtifactAttemptedKey === artifactKey) {
        releaseSeamArtifactAttempt(current, artifactKey);
      }
      scope.trace("seam-cleaned-artifact-error", records[0]?.target || null, {
        pairKey: plan.pairKey,
        error: runtime.getErrorMessage(error)
      });
    }
  }

  function releaseSeamArtifactAttempt(state, artifactKey) {
    scope.store.markSeamState(state.pairKey, {
      ...state,
      cleanedImageArtifactAttemptedKey: "",
      cleanedImageArtifactRetryKey: artifactKey,
      cleanedImageArtifactRetryAfter: scope.now() +
        runtime.KAKAO_CLEANED_ARTIFACT_RETRY_COOLDOWN_MS
    });
  }
}
