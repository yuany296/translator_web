export function installCanonicalPageOcr(runtime, scope) {
  async function execute(target, identity, options) {
    let pageRecord = null;
    let preserveReadyPhase = false;
    let pageOcrReady = false;
    scope.trace("pipeline-start", target, {
      runId: identity.runId,
      reason: options.reason || ""
    });
    try {
      scope.trace("fetch", target, {
        runId: identity.runId
      });
      scope.loading(target, identity.targetKey, "提取单页图片...");
      if (!scope.isCurrentJob(target, identity)) return scope.cancelJob(target, identity, "", "sourceChanged before fetch");
      const snapshot = typeof scope.adapters.captureTargetSnapshot === "function" ? scope.adapters.captureTargetSnapshot(target) : null;
      const payload = await scope.withCanonicalTimeout(scope.extractTargetPayload(target, identity.scopedTargetKey), scope.extractTimeoutMs, "Page fetch timed out");
      if (!scope.isCurrentJob(target, identity)) return scope.cancelJob(target, identity, "", "sourceChanged after fetch");
      const authoritativePayload = await scope.isAuthoritativePagePayload(payload, target);
      if (!scope.isCurrentJob(target, identity)) {
        return scope.cancelJob(target, identity, "", "sourceChanged during payload admission");
      }
      if (!authoritativePayload) {
        throw new Error("Page capture did not produce an authoritative image payload");
      }
      const pageIdentity = await scope.withCanonicalTimeout(scope.buildPageIdentity(target, payload, {
        ...identity,
        deferBind: true
      }), scope.identityTimeoutMs, "Page identity timed out");
      if (!scope.isCurrentJob(target, identity)) {
        return scope.cancelJob(target, identity, "", "sourceChanged while hashing page bytes");
      }
      runtime.validatePageIdentity(pageIdentity);
      if (!scope.canCommitPageRevision(target, identity, pageIdentity)) {
        return scope.cancelJob(target, identity, pageIdentity.pageId, "page revision superseded before commit");
      }
      if (scope.commitPageIdentity && scope.commitPageIdentity(target, pageIdentity) === false) {
        return scope.cancelJob(target, identity, pageIdentity.pageId, "page identity commit rejected");
      }
      const previousPageHandle = scope.store.getPageHandle(pageIdentity.pageId);
      const previousPageTerminal = scope.store.getPageTerminal(pageIdentity.pageId);
      preserveReadyPhase = !!previousPageHandle && previousPageHandle.imageRevision === pageIdentity.imageRevision && previousPageTerminal && previousPageTerminal.state === "ready" && scope.isReadyPageRecord(previousPageHandle);
      pageOcrReady = preserveReadyPhase;
      pageRecord = scope.store.registerPageHandle({
        ...(preserveReadyPhase ? previousPageHandle : {}),
        ...pageIdentity,
        identity: Object.freeze({
          ...pageIdentity
        }),
        target,
        targetKey: identity.targetKey,
        scopedTargetKey: identity.scopedTargetKey,
        sourceToken: identity.sourceToken,
        runSequence: identity.runSequence,
        payload,
        snapshot,
        edgeSignals: preserveReadyPhase ? previousPageHandle.edgeSignals : null,
        edgeSides: preserveReadyPhase ? previousPageHandle.edgeSides : Object.freeze([]),
        adjacentTargets: preserveReadyPhase ? previousPageHandle.adjacentTargets : Object.freeze([]),
        pageOcrState: preserveReadyPhase ? "ready" : "running"
      });
      if (!preserveReadyPhase) scope.store.setCanonicalPagePhase(pageRecord.pageId, runtime.CanonicalPhase.PAGE_OCR, {
        force: true
      });
      scope.trace("page-ocr", target, {
        pageId: pageRecord.pageId
      });
      scope.loading(target, identity.targetKey, "识别当前页...");
      const response = await scope.store.getOrCreateInflightJob(`canonical-page-ocr:${pageRecord.pageId}:${pageRecord.imageRevision}`, () => scope.withCanonicalTimeout(scope.requestOcrForPayload(payload, runtime.buildOcrMeta("page", [pageRecord])), scope.pageOcrTimeoutMs, "Page OCR timed out"));
      if (!response || !response.ok) {
        throw new runtime.CanonicalPageOcrError(response && response.error ? response.error : "Page OCR failed");
      }
      if (!scope.isCurrentJob(target, identity)) {
        return scope.cancelJob(target, identity, pageRecord.pageId, "sourceChanged during page OCR");
      }
      if (!scope.isCurrentPageRevision(pageRecord)) {
        return scope.cancelJob(target, identity, pageRecord.pageId, "page revision superseded during page OCR");
      }
      scope.loading(target, identity.targetKey, "解析识别结果...");
      const evidence = runtime.normalizeOcrEvidence(response.result, [pageRecord], "page");
      if (!preserveReadyPhase) scope.store.setCanonicalPagePhase(pageRecord.pageId, runtime.CanonicalPhase.OBSERVING);
      scope.trace("observe", target, {
        pageId: pageRecord.pageId
      });
      // 同一页面 revision 的一次重新捕获是原子替换，而不是追加。这样 OCR
      // provider/参数变化或非确定性重识别不会把同一几何实体永久翻译两遍；
      // 不同 imageRevision 的旧证据仍保留并由 ledger 标记 stale_revision。
      scope.store.replacePageRevisionObservations(pageRecord.pageId, pageRecord.imageRevision, evidence.observations, evidence.filteredObservations);
      const edgeSides = runtime.collectPageEdgeSides(pageRecord, evidence.observations, evidence.filteredObservations, evidence.edgeSignals);
      let adjacentTargets = [];
      if (options.isolatedPage !== true) {
        adjacentTargets = runtime.normalizeAdjacentTargets(preserveReadyPhase ? pageRecord.adjacentTargets : []);
        try {
          adjacentTargets = runtime.normalizeAdjacentTargets(await scope.findAdjacentTargets(target, pageRecord));
        } catch (error) {
          // 邻页发现只决定可选 seam，不得让成功的单页 OCR 失败。
          scope.trace("neighbor-discovery-error", target, {
            pageId: pageRecord.pageId,
            error: runtime.getErrorMessage(error)
          });
        }
      }
      if (!scope.isCurrentJob(target, identity) || !scope.isCurrentPageRevision(pageRecord)) {
        return scope.cancelJob(target, identity, pageRecord.pageId, "sourceChanged during neighbor discovery");
      }
      const retainedCleanedImage = evidence.cleanedImage || (pageRecord.cleanedImageRevision === pageRecord.imageRevision ? pageRecord.cleanedImage : null);
      pageRecord = scope.store.registerPageHandle({
        ...pageRecord,
        target,
        payload,
        edgeSignals: evidence.edgeSignals,
        edgeSides: Object.freeze(edgeSides),
        adjacentTargets: Object.freeze(adjacentTargets),
        pageOcrState: "ready",
        ocrDebug: evidence.debug || null,
        cleanedImage: retainedCleanedImage || null,
        cleanedImageRevision: retainedCleanedImage ? pageRecord.imageRevision : "",
        artifactRefreshAttemptedRevision: retainedCleanedImage ? pageRecord.imageRevision : pageRecord.artifactRefreshAttemptedRevision === pageRecord.imageRevision ? pageRecord.artifactRefreshAttemptedRevision : ""
      });
      pageRecord = scope.bindReadyAdjacentPageIds(pageRecord);
      scope.store.markPageTerminal(pageRecord.pageId, "ready", {
        observationCount: evidence.observations.length,
        imageRevision: pageRecord.imageRevision
      });
      pageOcrReady = true;

      // 普通内部 canonical 可以提前翻译；边缘 canonical 必须先等待邻页关系结算。
      if (options.isolatedPage !== true) scope.ensureEdgeWait(pageRecord);
      // 延迟邻页只在双方 page handle 和 terminal 都 ready 后兑现；这样 seam 会在
      // 边缘 canonical 的普通投影放行之前取得所有权。
      if (options.isolatedPage !== true && scope.notifyCanonicalPageReady) {
        try {
          await scope.notifyCanonicalPageReady(target, pageRecord);
        } catch (error) {
          // seam 是可选增量证据，通知异常不能破坏已成功的单页 OCR。
          scope.trace("page-ready-adjacency-error", target, {
            pageId: pageRecord.pageId,
            error: runtime.getErrorMessage(error)
          });
        }
        if (!scope.isCurrentJob(target, identity) || !scope.isCurrentPageRevision(pageRecord)) {
          return scope.cancelJob(target, identity, pageRecord.pageId, "sourceChanged during ready adjacency");
        }
      }
      scope.loading(target, identity.targetKey, "翻译文字中...");
      const pageRefresh = await scope.refreshCanonicalState({
        reason: "page-ocr",
        focusPageIds: [pageRecord.pageId],
        guard: () => scope.isCurrentJob(target, identity) && scope.isCurrentPageRevision(pageRecord)
      });
      if (pageRefresh && pageRefresh.aborted || !scope.isCurrentJob(target, identity) || !scope.isCurrentPageRevision(pageRecord)) {
        return scope.cancelJob(target, identity, pageRecord.pageId, "sourceChanged during page refresh");
      }

      // A seam is an optional evidence request. It can never replace or clear page OCR.
      scope.loading(target, identity.targetKey, "处理跨页...");
      const pairResult = options.isolatedPage === true
        ? { aborted: false, pageIds: [] }
        : await scope.processAdjacentPairs(pageRecord, () =>
          scope.isCurrentJob(target, identity) && scope.isCurrentPageRevision(pageRecord)
        );
      if (pairResult.aborted || !scope.isCurrentJob(target, identity) || !scope.isCurrentPageRevision(pageRecord)) {
        return scope.cancelJob(target, identity, pageRecord.pageId, "sourceChanged during seam processing");
      }
      const pairPageIds = pairResult.pageIds;
      if (options.isolatedPage !== true) scope.releaseCompletedEdgeWaits();
      scope.loading(target, identity.targetKey, "渲染结果...");
      const pairRefresh = await scope.refreshCanonicalState({
        reason: "pair-terminal",
        focusPageIds: Array.from(new Set([pageRecord.pageId, ...pairPageIds])),
        guard: () => scope.isCurrentJob(target, identity) && scope.isCurrentPageRevision(pageRecord)
      });
      if (pairRefresh && pairRefresh.aborted || !scope.isCurrentJob(target, identity) || !scope.isCurrentPageRevision(pageRecord)) {
        return scope.cancelJob(target, identity, pageRecord.pageId, "sourceChanged during pair refresh");
      }

      if (snapshot && typeof scope.adapters.isTargetSnapshotStillValid === "function" && !scope.adapters.isTargetSnapshotStillValid(target, snapshot)) {
        return scope.cancelJob(target, identity, pageRecord.pageId, "target changed before render commit");
      }
      scope.store.setCanonicalPagePhase(pageRecord.pageId, runtime.CanonicalPhase.RENDERED);
      const pageProjections = scope.store.getProjections(pageRecord.pageId);
      scope.trace("pipeline-end", target, {
        runId: identity.runId,
        pageId: pageRecord.pageId,
        observationCount: evidence.observations.length,
        projectionCount: pageProjections.length
      });
      return {
        ok: true,
        pageId: pageRecord.pageId,
        observations: evidence.observations.length,
        bubbles: pageProjections.filter(item => item.activeText).length,
        pendingEdge: !!scope.store.getEdgeWait(pageRecord.pageId),
        cached: !!response.cached
      };
    } catch (error) {
      const reason = runtime.getErrorMessage(error);
      if (!scope.isCurrentJob(target, identity)) {
        return scope.cancelJob(target, identity, pageRecord && pageRecord.pageId || "", `stale error: ${reason}`);
      }
      if (pageRecord && !scope.isCurrentPageRevision(pageRecord)) {
        return scope.cancelJob(target, identity, pageRecord.pageId, `superseded page revision error: ${reason}`);
      }
      const currentPageReady = pageRecord ? scope.isReadyPageRecord(scope.store.getPageHandle(pageRecord.pageId)) : false;
      if (pageRecord && !pageOcrReady && !currentPageReady) {
        scope.store.markPageTerminal(pageRecord.pageId, "failed", {
          reason,
          imageRevision: pageRecord.imageRevision
        });
      }
      if (pageRecord) {
        scope.store.setCanonicalPagePhase(pageRecord.pageId, runtime.CanonicalPhase.RETRY_WAIT);
      }
      // A page failure is local. Existing canonical facts/projections remain intact.
      if (typeof scope.adapters.scheduleAutoTranslateRetry === "function") {
        scope.adapters.scheduleAutoTranslateRetry(target);
      }
      if (typeof scope.adapters.reportPipelineError === "function") {
        await scope.adapters.reportPipelineError(error, target, options);
      }
      scope.trace("page-error", target, {
        runId: identity.runId,
        pageId: pageRecord && pageRecord.pageId,
        error: reason
      });
      return {
        ok: false,
        error: reason,
        pageId: pageRecord && pageRecord.pageId || ""
      };
    } finally {
      scope.store.finishPageJob(identity.jobKey, identity);
      // 安全网：确保任何 exit 路径都清理 loading overlay。正常路径中
      // refreshCanonicalState → renderCanonicalProjections → renderOverlay
      // 已经替换了 loading overlay，此处再次清理是幂等的。
      if (!identity.suppressLoadingClear && scope.activeRunByTarget.get(target) === identity && typeof scope.adapters.clearLoadingOverlay === "function") {
        try {
          scope.adapters.clearLoadingOverlay(target);
        } catch {/* 安全网清理 */}
      }
      if (scope.activeRunByTarget.get(target) === identity) {
        scope.activeRunByTarget.delete(target);
      }
      scope.trace("pipeline-finally", target, {
        runId: identity.runId,
        pageId: pageRecord && pageRecord.pageId || ""
      });
    }
  }
  scope.execute = execute;
  async function processAdjacentPairs(record, guardAllows = () => true) {
    const current = scope.store.getPageHandle(record.pageId) || record;
    const affectedPageIds = [];
    for (const relation of current.adjacentTargets || []) {
      if (!guardAllows()) return {
        pageIds: affectedPageIds,
        aborted: true
      };
      const neighbor = scope.store.getPageHandleForTarget(relation.target);
      if (!neighbor || !neighbor.payload || !scope.isReadyPageRecord(neighbor)) continue;
      if (neighbor.chapterId && current.chapterId && neighbor.chapterId !== current.chapterId) continue;
      const ordered = relation.side === "previous" ? [neighbor, current] : [current, neighbor];
      try {
        await scope.processSeamPair(ordered[0], ordered[1]);
      } catch (error) {
        // Seam 的任何前处理/决策异常都必须隔离为 pair failure。
        const pairKey = runtime.buildCanonicalPairKey(ordered[0], ordered[1]);
        scope.store.markSeamState(pairKey, {
          status: "failed",
          pageIds: [ordered[0].pageId, ordered[1].pageId],
          imageRevisionByPage: runtime.revisionsForPages(ordered),
          error: runtime.getErrorMessage(error)
        });
        scope.trace("seam-error", ordered[0].target, {
          pairKey,
          error: runtime.getErrorMessage(error)
        });
      }
      affectedPageIds.push(neighbor.pageId);
      if (!guardAllows()) return {
        pageIds: affectedPageIds,
        aborted: true
      };
    }
    if (!guardAllows()) return {
      pageIds: affectedPageIds,
      aborted: true
    };
    scope.ensureEdgeWait(current);
    return {
      pageIds: affectedPageIds,
      aborted: false
    };
  }
  scope.processAdjacentPairs = processAdjacentPairs;
  function bindReadyAdjacentPageIds(record) {
    const patch = {};
    const adjacentPageIds = new Set(Array.isArray(record.adjacentPageIds) ? record.adjacentPageIds : []);
    for (const relation of record.adjacentTargets || []) {
      const neighbor = scope.store.getPageHandleForTarget(relation.target);
      if (!neighbor || neighbor.chapterId && record.chapterId && neighbor.chapterId !== record.chapterId) continue;
      adjacentPageIds.add(neighbor.pageId);
      if (relation.side === "previous") patch.previousPageId = neighbor.pageId;else patch.nextPageId = neighbor.pageId;
      const neighborAdjacent = new Set(Array.isArray(neighbor.adjacentPageIds) ? neighbor.adjacentPageIds : []);
      neighborAdjacent.add(record.pageId);
      const reciprocalSide = relation.side === "previous" ? "next" : "previous";
      const reciprocalTargets = runtime.mergeAdjacentTargetRelation(neighbor.adjacentTargets, {
        side: reciprocalSide,
        target: record.target
      });
      scope.store.registerPageHandle({
        ...neighbor,
        ...(relation.side === "previous" ? {
          nextPageId: record.pageId
        } : {
          previousPageId: record.pageId
        }),
        adjacentPageIds: Object.freeze([...neighborAdjacent].sort()),
        adjacentTargets: Object.freeze(reciprocalTargets)
      });
    }
    return scope.store.registerPageHandle({
      ...record,
      ...patch,
      adjacentPageIds: Object.freeze([...adjacentPageIds].sort())
    });
  }
  scope.bindReadyAdjacentPageIds = bindReadyAdjacentPageIds;
}
