export function installCanonicalTranslate(runtime, scope) {
  async function refreshCanonicalState({
    reason,
    runId = "",
    focusPageIds = [],
    guard = null
  } = {}) {
    const guardAllows = () => {
      if (typeof guard !== "function") return true;
      try {
        return guard() !== false;
      } catch {
        return false;
      }
    };
    if (!guardAllows()) return {
      aborted: true
    };
    scope.trace("reconcile", null, {
      reason,
      pageIds: focusPageIds
    });
    const reconciliation = await scope.store.runSerializedReconcile(() => {
      if (!guardAllows()) return null;
      for (const pageId of focusPageIds) scope.store.setCanonicalPagePhase(pageId, runtime.CanonicalPhase.RECONCILING);
      const result = runtime.reconcileCanonicalEvidence(scope.store);
      scope.store.setCanonicalSnapshot(result);
      scope.store.setCoverageLedger(result.ledger);
      scope.store.setReconcileDiagnostics(result.diagnostics || {});
      runtime.assertCoverageInvariant(scope.store);
      scope.timingPhase(runId, "reconcile");
      return result;
    });
    if (!reconciliation || !guardAllows()) return {
      aborted: true
    };

    // OCR debug 是识别阶段的诊断结果，不应等待外部翻译接口成功后才出现。
    // 此处只渲染 debug，不把暂时的空 projection 结算为无文字。
    await scope.renderAllCanonicalPages(`${reason}:ocr-debug`, guardAllows, {
      debugOnly: true,
      focusPageIds
    });
    scope.timingPhase(runId, "renderDebug");
    if (!guardAllows()) return {
      aborted: true
    };
    const eligible = reconciliation.canonicals.filter(canonical => canonical.status !== "filtered" && (runtime.edgeTranslateWithoutWaiting === true || !scope.canonicalWaitsForEdge(canonical)));
    scope.trace("translate", null, {
      reason,
      count: eligible.length
    });
    for (const pageId of focusPageIds) scope.store.setCanonicalPagePhase(pageId, runtime.CanonicalPhase.TRANSLATING);
    let translated;
    try {
      // 边缘 canonical 默认仍等邻页 seam：跨页句子只翻译一次、上下文完整。
      // 打开 runtime.edgeTranslateWithoutWaiting 后不再白等（首屏更快，
      // 代价是 seam 之后确实合并的句子会多一次翻译，见 edgeWaitingCanonicalIds）。
      translated = await scope.translateCanonicals(eligible, reason, guardAllows, runId);
      scope.timingPhase(runId, "translate");
    } catch (error) {
      // 新 revision 翻译失败时仍要把上一版唯一可见译文标成 provisional；
      // 错误继续向上抛给重试调度，页面则不会在此期间变成空白。
      if (guardAllows()) {
        try {
          const ordinaryFallbackProjections = scope.buildCanonicalProjections(scope.store);
          const fallbackPlan = runtime.resolveSeamProjectionPlan(runtime.buildSeamRenderSurfaceIndex(scope.store, {
            isPageAvailable: scope.isPageAvailable
          }), handledIds => scope.buildCanonicalProjections(scope.store, handledIds));
          scope.store.setProjections(fallbackPlan.projections);
          await scope.refreshRequiredCleanedArtifacts(fallbackPlan.projections, fallbackPlan.seamSurfaceIndex);
          if (guardAllows()) {
            const refreshedSeamSurfaceIndex = runtime.buildSeamRenderSurfaceIndex(scope.store, {
              isPageAvailable: scope.isPageAvailable
            });
            // 每页是否完整由当前 canonical revision 和 provisional projection 独立判断。
            // 不能用一个失败项把全章其他已完成页面也降级成 pending。
            await scope.renderAllCanonicalPages(`${reason}:translation-fallback`, guardAllows, {
              seamSurfaceIndex: refreshedSeamSurfaceIndex,
              fallbackProjectionsByPage: ordinaryFallbackProjections
            });
          }
        } catch (fallbackError) {
          scope.trace("translation-fallback-render-error", null, {
            error: runtime.getErrorMessage(fallbackError)
          });
        }
      }
      throw error;
    }
    if (translated === false || !guardAllows()) return {
      aborted: true
    };
    scope.trace("project", null, {
      reason
    });
    for (const pageId of focusPageIds) scope.store.setCanonicalPagePhase(pageId, runtime.CanonicalPhase.PROJECTING);
    const edgeWaitingIds = runtime.edgeTranslateWithoutWaiting === true ? edgeWaitingCanonicalIds() : null;
    const ordinaryFallbackProjections = scope.buildCanonicalProjections(scope.store, new Set(), edgeWaitingIds);
    const projectionPlan = runtime.resolveSeamProjectionPlan(runtime.buildSeamRenderSurfaceIndex(scope.store, {
      isPageAvailable: scope.isPageAvailable
    }), handledIds => scope.buildCanonicalProjections(scope.store, handledIds, edgeWaitingIds));
    scope.store.setProjections(projectionPlan.projections);
    // 清理图覆盖"即将渲染的投影"（plan ∪ fallback），否则会出现"渲染画了透明遮罩、
    // 清理计划却认为这一页不需要清理图"的分叉，那一页永远拿不到 inpainted 遮罩。
    await scope.refreshRequiredCleanedArtifacts(runtime.mergeCleanedArtifactProjectionSource(
      projectionPlan.projections, ordinaryFallbackProjections
    ), projectionPlan.seamSurfaceIndex);
    scope.timingPhase(runId, "cleanArtifacts");
    if (!guardAllows()) return {
      aborted: true
    };
    const refreshedSeamSurfaceIndex = runtime.buildSeamRenderSurfaceIndex(scope.store, {
      isPageAvailable: scope.isPageAvailable
    });
    scope.trace("render", null, {
      reason
    });
    for (const pageId of focusPageIds) scope.store.setCanonicalPagePhase(pageId, runtime.CanonicalPhase.RENDERING);
    await scope.renderAllCanonicalPages(reason, guardAllows, {
      seamSurfaceIndex: refreshedSeamSurfaceIndex,
      fallbackProjectionsByPage: ordinaryFallbackProjections
    });
    scope.timingPhase(runId, "render");
    if (!guardAllows()) return {
      aborted: true
    };
    for (const pageId of focusPageIds) scope.store.setCanonicalPagePhase(pageId, runtime.CanonicalPhase.RENDERED);
    return reconciliation;
  }
  scope.refreshCanonicalState = refreshCanonicalState;
  function canonicalWaitsForEdge(canonical) {
    const memberIds = Array.isArray(canonical.memberObservationIds) ? canonical.memberObservationIds : [];
    for (const observationId of memberIds) {
      const observation = scope.store.getObservations().find(item => item.id === observationId);
      if (!observation || observation.sourceType === "seam") continue;
      for (const pageId of observation.pageIds) {
        const record = scope.store.getPageHandle(pageId);
        if (!record || runtime.getObservationEdgeSides(observation, record).length === 0) continue;
        const relevant = scope.relevantAdjacentRelations(record);
        const pairPending = relevant.some(relation => {
          const neighbor = scope.store.getPageHandleForTarget(relation.target);
          if (!neighbor || !scope.isReadyPageRecord(neighbor)) return false;
          const pair = relation.side === "previous" ? [neighbor, record] : [record, neighbor];
          const seam = scope.store.getSeamState(runtime.buildCanonicalPairKey(pair[0], pair[1]));
          return !seam || !["completed", "failed", "skipped", "stale"].includes(seam.status);
        });
        if (pairPending) return true;
        const wait = scope.store.getEdgeWait(pageId);
        if (!wait || wait.timedOut) continue;
        if (runtime.edgeTranslateWithoutWaiting !== true) return true;
        // 实验开关打开时：只有「邻页已经在跑」才值得短暂等待合并结果；
        // 邻页毫无进度（例如分页阅读器根本不会读下一页）时立刻翻译，不再白等到超时。
        const neighborInFlight = relevant.some(relation => {
          const neighbor = scope.store.getPageHandleForTarget(relation.target);
          return !!neighbor && !scope.isReadyPageRecord(neighbor);
        });
        if (neighborInFlight) return true;
      }
    }
    return false;
  }
  scope.canonicalWaitsForEdge = canonicalWaitsForEdge;
  function edgeWaitingCanonicalIds() {
    // 仍在等邻页 seam 的 canonical：译文已经拿到，但跨页合并可能改写它，
    // 所以投影先标 provisional，页面状态保持"未完成"，等 seam 终结后刷新。
    const snapshot = typeof scope.store.getCanonicalSnapshot === "function" ? scope.store.getCanonicalSnapshot() : [];
    const ids = new Set();
    for (const canonical of Array.isArray(snapshot) ? snapshot : []) {
      if (!canonical || canonical.status === "filtered") continue;
      if (scope.canonicalWaitsForEdge(canonical)) ids.add(String(canonical.id || ""));
    }
    return ids;
  }
  scope.edgeWaitingCanonicalIds = edgeWaitingCanonicalIds;
  function recordTranslationTiming(runId, timing) {
    if (!timing || typeof timing !== "object") return;
    scope.timingAdd(runId, "translateLlm", timing.translateMs);
    scope.timingAdd(runId, "translateOfficial", timing.officialLoadMs);
  }
  scope.recordTranslationTiming = recordTranslationTiming;
  /**
   * 只渲染「已经结算的译文」，不发起翻译。
   *
   * 漫画流式翻译（COMIC_TRANSLATION_PARTIAL）每拿到一批行就调这里提前上屏；
   * 走完整 refreshCanonicalState 会被 waitForPendingTranslations 卡到整批结束，
   * 那样流式就没有意义了。清理图等 artifact 留给整批结束后的正式 refresh。
   */
  async function renderSettledTranslations(reason = "partial-translation", guardAllows = () => true) {
    if (guardAllows() === false) return false;
    const edgeWaitingIds = runtime.edgeTranslateWithoutWaiting === true ? edgeWaitingCanonicalIds() : null;
    const fallbackProjections = scope.buildCanonicalProjections(scope.store, new Set(), edgeWaitingIds);
    const projectionPlan = runtime.resolveSeamProjectionPlan(runtime.buildSeamRenderSurfaceIndex(scope.store, {
      isPageAvailable: scope.isPageAvailable
    }), handledIds => scope.buildCanonicalProjections(scope.store, handledIds, edgeWaitingIds));
    scope.store.setProjections(projectionPlan.projections);
    const seamSurfaceIndex = runtime.buildSeamRenderSurfaceIndex(scope.store, {
      isPageAvailable: scope.isPageAvailable
    });
    await scope.renderAllCanonicalPages(reason, guardAllows, {
      seamSurfaceIndex,
      fallbackProjectionsByPage: fallbackProjections
    });
    return true;
  }
  scope.renderSettledTranslations = renderSettledTranslations;
  async function translateCanonicals(canonicals, reason, guardAllows = () => true, runId = "") {
    const candidates = canonicals.map(canonical => ({
      id: canonical.id,
      revision: Number(canonical.revision) || 1,
      original_text: String(canonical.originalText || canonical.original_text || ""),
      non_translate: canonical.nonTranslate === true
    })).filter(item => item.original_text);
    const items = scope.store.claimTranslations(candidates);
    if (items.length === 0) {
      await scope.store.waitForPendingTranslations(candidates);
      const failures = scope.store.getTranslationFailures(candidates);
      if (failures.length > 0) {
        throw new runtime.CanonicalTranslationError(failures.map(failure => failure.error).filter(Boolean).join("; "));
      }
      return guardAllows();
    }
    if (!guardAllows()) {
      scope.store.releaseTranslationClaims(items);
      return false;
    }
    let response;
    try {
      response = await scope.requestCanonicalTranslations(items, {
        sourceLanguage: scope.adapters.sourceLanguage || "auto",
        targetLanguage: scope.adapters.targetLanguage || runtime.KAKAO_CANONICAL_TARGET_LANGUAGE,
        reason,
        // 作为流式增量消息的 taskId：后台每写完一行就能推回本页提前渲染。
        taskId: runId
      });
      scope.recordTranslationTiming(runId, response && response.timing);
      if (!response || response.ok === false) {
        throw new runtime.CanonicalTranslationError(response && response.error || "Canonical translation request failed");
      }
    } catch (error) {
      scope.store.failTranslationClaims(items, error);
      if (!guardAllows()) return false;
      scope.trace("translation-error", null, {
        error: runtime.getErrorMessage(error),
        count: items.length
      });
      throw error;
    }
    const translations = response && response.result && Array.isArray(response.result.translations) ? response.result.translations : response && Array.isArray(response.translations) ? response.translations : [];
    const mayRender = guardAllows();
    const byKey = new Map(translations.map(translation => [runtime.canonicalRevisionKey(translation && translation.id, translation && translation.revision), translation]));
    const missing = [];
    for (const item of items) {
      const translation = byKey.get(runtime.canonicalRevisionKey(item.id, item.revision));
      if (translation && String(translation.translated_text || "").trim()) {
        scope.store.settleTranslation(item, translation);
      } else {
        missing.push(item);
        scope.trace("translation-partial", null, {
          id: item.id,
          revision: item.revision
        });
      }
    }
    if (missing.length > 0) {
      // 批量翻译偶尔只返回部分 id。接缝候选若恰好被漏掉，页面会只剩
      // 单页误识别的小框；对漏项做一次小批次重试，仍缺失才结算失败。
      scope.trace("translation-partial-retry", null, {
        count: missing.length
      });
      let retryResponse;
      try {
        retryResponse = await scope.requestCanonicalTranslations(missing, {
          sourceLanguage: scope.adapters.sourceLanguage || "auto",
          targetLanguage: scope.adapters.targetLanguage || runtime.KAKAO_CANONICAL_TARGET_LANGUAGE,
          reason: `${reason}:partial-retry`
        });
        scope.recordTranslationTiming(runId, retryResponse && retryResponse.timing);
        if (!retryResponse || retryResponse.ok === false) {
          throw new runtime.CanonicalTranslationError(retryResponse && retryResponse.error || "Canonical translation retry failed");
        }
      } catch (error) {
        scope.store.failTranslationClaims(missing, error);
        scope.trace("translation-error", null, {
          error: runtime.getErrorMessage(error),
          count: missing.length
        });
        throw error;
      }
      const retryTranslations = retryResponse && retryResponse.result && Array.isArray(retryResponse.result.translations) ? retryResponse.result.translations : retryResponse && Array.isArray(retryResponse.translations) ? retryResponse.translations : [];
      const retryByKey = new Map(retryTranslations.map(translation => [runtime.canonicalRevisionKey(translation && translation.id, translation && translation.revision), translation]));
      const unresolved = [];
      for (const item of missing) {
        const translation = retryByKey.get(runtime.canonicalRevisionKey(item.id, item.revision));
        if (translation && String(translation.translated_text || translation.translatedText || "").trim()) {
          scope.store.settleTranslation(item, translation);
        } else {
          unresolved.push(item);
        }
      }
      if (unresolved.length > 0) {
        const error = new runtime.CanonicalTranslationError(`Translation response omitted ${unresolved.length} canonical item(s) after retry`);
        scope.store.failTranslationClaims(unresolved, error);
        scope.trace("translation-error", null, {
          error: runtime.getErrorMessage(error),
          count: unresolved.length
        });
        throw error;
      }
    }
    // 翻译事实按 canonical revision 保存；旧作业不能继续 project/render。
    // 若同 URL 重载后的摘要相同，新作业可以复用这次唯一的外部请求结果。
    return mayRender;
  }
  scope.translateCanonicals = translateCanonicals;
  function buildCanonicalProjections(activeStore, handledCanonicalIds = new Set(), edgeWaitingIds = null) {
    const reconciler = runtime.getCanonicalReconciler();
    const pages = activeStore.getPageHandles().map(runtime.canonicalPageDescriptor);
    const previousProjections = activeStore.getAllProjections();
    const translations = new Map();
    const handledIds = handledCanonicalIds instanceof Set ? handledCanonicalIds : new Set(Array.from(handledCanonicalIds || [], String));
    // 仍在等 seam 的 canonical：译文先渲染，但标成 provisional，页面状态保持未完成。
    const waitingIds = edgeWaitingIds instanceof Set ? edgeWaitingIds : new Set();
    const currentCanonicals = activeStore.getCanonicalSnapshot().filter(canonical => !handledIds.has(String(canonical && canonical.id || "")));
    const canonicals = currentCanonicals.filter(canonical => {
      const translation = activeStore.getTranslation(canonical.id, canonical.revision);
      if (!translation || !String(translation.translated_text || translation.translatedText || "").trim()) return false;
      translations.set(runtime.canonicalRevisionKey(canonical.id, canonical.revision), translation);
      return true;
    });
    const availablePageIds = pages.filter(page => scope.isPageAvailable(page.pageId)).map(page => page.pageId);
    let flat = null;
    if (reconciler && typeof reconciler.buildRenderProjections === "function") {
      flat = reconciler.buildRenderProjections({
        pages,
        canonicals,
        availablePageIds,
        translations
      });
    }
    if (!Array.isArray(flat)) {
      flat = runtime.fallbackBuildRenderProjections({
        pages,
        canonicals: canonicals.map(canonical => ({
          ...canonical,
          translation: translations.get(runtime.canonicalRevisionKey(canonical.id, canonical.revision))
        })),
        availablePageIds
      });
    }
    const grouped = new Map();
    const existingCoverKeys = new Set(flat.filter(projection => projection && projection.role === "cover").map(projection => `${String(projection.canonicalId || "")}|${String(projection.pageId || "")}`));
    for (const projection of flat) {
      if (!projection || !projection.pageId) continue;
      if (!grouped.has(projection.pageId)) grouped.set(projection.pageId, []);
      const normalized = Object.freeze({
        ...projection,
        cover: projection.cover !== false,
        translated_text: String(projection.translated_text || projection.translatedText || projection.bubble && projection.bubble.translated_text || projection.translation && projection.translation.translated_text || "")
      });
      grouped.get(projection.pageId).push(normalized);
      // A standby keeps takeover metadata, while a distinct cover projection
      // hides the duplicate source text on the non-primary page.
      const coverKey = `${String(normalized.canonicalId || "")}|${String(normalized.pageId || "")}`;
      if (!existingCoverKeys.has(coverKey)) {
        for (const coverProjection of runtime.buildStandbyCoverProjections(normalized)) {
          grouped.get(projection.pageId).push(coverProjection);
        }
      }
    }
    for (const items of grouped.values()) items.sort(runtime.compareProjectionRecords);
    runtime.appendProvisionalProjectionFallbacks({
      grouped,
      previousProjections,
      currentCanonicals,
      activeStore,
      isPageAvailable: scope.isPageAvailable
    });
    for (const [pageId, items] of grouped) {
      const filtered = items.filter(projection => !handledIds.has(String(projection && projection.canonicalId || "")) && !handledIds.has(String(projection && projection.pendingCanonicalId || "")));
      grouped.set(pageId, waitingIds.size === 0 ? filtered : filtered.map(projection => {
        if (!waitingIds.has(String(projection && projection.canonicalId || ""))) return projection;
        return Object.freeze({
          ...projection,
          provisional: true,
          edgePending: true
        });
      }));
    }
    return grouped;
  }
  scope.buildCanonicalProjections = buildCanonicalProjections;
  function isPageAvailable(pageId) {
    const handle = scope.store.getPageHandle(pageId);
    const target = scope.getTargetForPageId ? scope.getTargetForPageId(pageId) : handle && handle.target;
    return scope.targetIsUsable(target);
  }
  scope.isPageAvailable = isPageAvailable;
}
