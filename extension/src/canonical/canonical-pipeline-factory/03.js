export function installCreateCanonicalPipeline03(runtime, scope) {
  async function runSeamCrossPageRender(pageA, pageB) {
    return;
    if (typeof scope.buildSeamPayload !== "function") return;
    const pairKey = runtime.buildCanonicalPairKey(pageA, pageB);
    const bandHeight = runtime.calculateCanonicalSeamHeight(pageA.width, pageB.width);
    let seamPayload;
    try {
      seamPayload = await scope.buildSeamPayload(pageA, pageB, {
        height: bandHeight,
        bandHeight
      });
    } catch (_error) {
      scope.trace("seam-cross-build-error", pageA.target || null, {
        pairKey,
        error: runtime.getErrorMessage(_error)
      });
      return;
    }
    if (!seamPayload) return;
    let response;
    try {
      response = await scope.requestOcrForPayload(seamPayload, runtime.buildOcrMeta("seam", [pageA, pageB], pairKey, {
        requireCleanedImage: false
      }));
    } catch (_error) {
      scope.trace("seam-cross-ocr-error", pageA.target || null, {
        pairKey,
        error: runtime.getErrorMessage(_error)
      });
      return;
    }
    if (!response || !response.ok) return;
    let rawObservations = (response.result && response.result.observations || []).filter(function (obs) {
      return String(obs.originalText || obs.original_text || "").trim();
    });
    if (rawObservations.length === 0) return;

    // 翻译 seam OCR 的原文
    let translatedObservations = rawObservations;
    if (typeof scope.requestCanonicalTranslations === "function") {
      try {
        const items = rawObservations.map(function (obs, idx) {
          return {
            id: "seam-cross-" + pairKey + "-" + idx,
            revision: 1,
            original_text: obs.originalText || obs.original_text || ""
          };
        });
        const tResp = await scope.requestCanonicalTranslations(items, {
          sourceLanguage: scope.adapters.sourceLanguage || "auto",
          targetLanguage: scope.adapters.targetLanguage || "zh-CN",
          reason: "seam-cross-page"
        });
        if (tResp && tResp.ok) {
          const tMap = new Map();
          const tList = tResp.result && tResp.result.translations || tResp.translations || [];
          tList.forEach(function (t) {
            tMap.set(String(t.id || ""), t);
          });
          translatedObservations = rawObservations.map(function (obs, idx) {
            var t = tMap.get("seam-cross-" + pairKey + "-" + idx);
            var translated = t && String(t.translated_text || t.translatedText || "").trim();
            return translated ? Object.assign({}, obs, {
              translatedText: translated,
              originalText: obs.originalText || obs.original_text
            }) : obs;
          });
        }
      } catch (_error) {
        scope.trace("seam-cross-translate-error", pageA.target || null, {
          pairKey,
          error: runtime.getErrorMessage(_error)
        });
      }
    }
    const payloadGeometry = runtime.captureSeamPayloadGeometry(seamPayload, [pageA, pageB]);
    if (typeof scope.adapters.renderSeamCrossPage !== "function") return;
    try {
      scope.adapters.renderSeamCrossPage({
        pageA,
        pageB,
        pairKey,
        canvasWidth: payloadGeometry.canvasWidth,
        canvasHeight: payloadGeometry.canvasHeight,
        segments: payloadGeometry.segments,
        observations: translatedObservations,
        debug: response.result && response.result.debug || null
      });
    } catch (_error) {
      scope.trace("seam-cross-render-error", pageA.target || null, {
        pairKey,
        error: runtime.getErrorMessage(_error)
      });
    }
  }
  scope.runSeamCrossPageRender = runSeamCrossPageRender;
  async function processSeamPair(pageA, pageB) {
    const pairKey = runtime.buildCanonicalPairKey(pageA, pageB);
    const existingState = scope.store.getSeamState(pairKey);
    if (existingState && existingState.status !== "running") return existingState;
    return scope.store.getOrCreateInflightJob(`canonical-seam:${pairKey}`, async () => {
      const currentState = scope.store.getSeamState(pairKey);
      if (currentState && currentState.status !== "running") return currentState;
      let overlapRisk = null;
      try {
        overlapRisk = scope.detectPixelRisk ? await scope.detectPixelRisk(pageA, pageB) : null;
      } catch (error) {
        scope.trace("pixel-risk-error", pageA.target, {
          pairKey,
          error: runtime.getErrorMessage(error)
        });
      }
      const evidenceDecision = scope.evaluateSeamEvidence(pageA, pageB, overlapRisk, scope.store);
      if (!evidenceDecision.shouldRun || !scope.buildSeamPayload) {
        return scope.store.markSeamState(pairKey, {
          status: "skipped",
          pageIds: [pageA.pageId, pageB.pageId],
          imageRevisionByPage: runtime.revisionsForPages([pageA, pageB]),
          reasons: evidenceDecision.reasons
        });
      }
      scope.store.markSeamState(pairKey, {
        status: "running",
        pageIds: [pageA.pageId, pageB.pageId],
        imageRevisionByPage: runtime.revisionsForPages([pageA, pageB]),
        reasons: evidenceDecision.reasons
      });
      scope.store.setCanonicalPagePhase(pageA.pageId, runtime.CanonicalPhase.SEAM_OCR);
      scope.store.setCanonicalPagePhase(pageB.pageId, runtime.CanonicalPhase.SEAM_OCR);
      scope.trace("seam-ocr", pageA.target, {
        pairKey
      });
      try {
        const seamPayload = await scope.withCanonicalTimeout(scope.buildSeamPayload(pageA, pageB, {
          height: evidenceDecision.bandHeight,
          bandHeight: evidenceDecision.bandHeight,
          overlap: overlapRisk
        }), scope.seamTimeoutMs, "Seam payload timed out");
        if (!seamPayload) throw new Error("Seam payload unavailable");
        const payloadGeometry = runtime.captureSeamPayloadGeometry(seamPayload, [pageA, pageB]);
        const response = await scope.requestOcrForPayload(seamPayload, runtime.buildOcrMeta("seam", [pageA, pageB], pairKey, {
          requireCleanedImage: true,
          forceCleanedImageArtifact: true
        }));
        if (!response || !response.ok) throw new Error(response && response.error || "Seam OCR failed");
        if (!scope.pageRevisionsStillMatch([pageA, pageB])) {
          return scope.store.markSeamState(pairKey, {
            status: "stale",
            pageIds: [pageA.pageId, pageB.pageId],
            imageRevisionByPage: runtime.revisionsForPages([pageA, pageB])
          });
        }
        const seamEvidence = runtime.normalizeOcrEvidence(response.result, [pageA, pageB], "seam");
        scope.store.upsertObservations(seamEvidence.observations);
        scope.store.upsertObservations(seamEvidence.filteredObservations, {
          filtered: true
        });
        const terminal = scope.store.markSeamState(pairKey, {
          status: "completed",
          pageIds: [pageA.pageId, pageB.pageId],
          imageRevisionByPage: runtime.revisionsForPages([pageA, pageB]),
          reasons: evidenceDecision.reasons,
          observationIds: seamEvidence.observations.map(item => item.id),
          observations: seamEvidence.observations,
          filteredObservations: seamEvidence.filteredObservations,
          coordinateSpace: payloadGeometry.coordinateSpace,
          canvasWidth: payloadGeometry.canvasWidth,
          canvasHeight: payloadGeometry.canvasHeight,
          pageSpans: payloadGeometry.pageSpans,
          segments: payloadGeometry.segments,
          seam: payloadGeometry.seam,
          payloadGeometry,
          cleanedImage: seamEvidence.cleanedImage || null,
          cleanedImageToken: seamEvidence.cleanedImageToken || "",
          debug: seamEvidence.debug || null
        });
        scope.trace("seam-complete", pageA.target, {
          pairKey,
          observations: seamEvidence.observations.length
        });
        scope.publishCompletedSeamEvidence(terminal);
        return terminal;
      } catch (error) {
        // Explicit isolation: page observations remain authoritative and are reconciled normally.
        const terminal = scope.store.markSeamState(pairKey, {
          status: "failed",
          pageIds: [pageA.pageId, pageB.pageId],
          imageRevisionByPage: runtime.revisionsForPages([pageA, pageB]),
          reasons: evidenceDecision.reasons,
          error: runtime.getErrorMessage(error)
        });
        scope.trace("seam-error", pageA.target, {
          pairKey,
          error: terminal.error
        });
        return terminal;
      }
    });
  }
  scope.processSeamPair = processSeamPair;
  function publishCompletedSeamEvidence(terminal) {
    if (!terminal || terminal.status !== "completed") return;
    const pageIds = Array.isArray(terminal.pageIds) ? terminal.pageIds.filter(Boolean) : [];
    scope.releaseCompletedEdgeWaits();
    // Seam 是独立的增量证据生产者。即使发起它的 DOM job 随后失效，
    // revision 仍匹配的完成证据也必须触发新的 canonical snapshot。
    Promise.resolve().then(() => scope.refreshCanonicalState({
      reason: "seam-evidence-complete",
      focusPageIds: pageIds
    })).catch(error => {
      scope.trace("seam-refresh-error", null, {
        error: runtime.getErrorMessage(error),
        pageIds
      });
    });
  }
  scope.publishCompletedSeamEvidence = publishCompletedSeamEvidence;
  function evaluateSeamEvidence(pageA, pageB, overlapRisk, activeStore) {
    const reconciler = runtime.getCanonicalReconciler();
    const records = [pageA, pageB];
    const observations = runtime.dedupeObservationsById(activeStore.getObservationsForPage(pageA.pageId, {
      includeFiltered: false
    }).concat(activeStore.getObservationsForPage(pageB.pageId, {
      includeFiltered: false
    }))).filter(item => runtime.observationMatchesPageRevisions(item, records));
    const filtered = activeStore.getFilteredObservations().filter(item => item.pageIds.some(pageId => pageId === pageA.pageId || pageId === pageB.pageId) && runtime.observationMatchesPageRevisions(item, records));
    if (reconciler && typeof reconciler.evaluateSeamEvidence === "function") {
      return reconciler.evaluateSeamEvidence({
        pageA: runtime.canonicalPageDescriptor(pageA),
        pageB: runtime.canonicalPageDescriptor(pageB),
        observations,
        filteredObservations: filtered,
        edgeSignals: {
          [pageA.pageId]: pageA.edgeSignals,
          [pageB.pageId]: pageB.edgeSignals
        },
        overlapRisk: overlapRisk ? {
          ...overlapRisk,
          detected: overlapRisk.detected === true || overlapRisk.accepted === true || overlapRisk.risk === true,
          ratio: Number(overlapRisk.ratio ?? overlapRisk.overlapRatio) || 0
        } : null
      });
    }
    const reasons = [];
    if ((pageA.edgeSides || []).includes("bottom") || (pageB.edgeSides || []).includes("top")) reasons.push("edge_observation");
    if (runtime.isCanonicalShortPage(pageA) || runtime.isCanonicalShortPage(pageB)) reasons.push("short_page");
    if (overlapRisk) reasons.push("pixel_overlap");
    return {
      shouldRun: reasons.length > 0,
      reasons,
      pairKey: runtime.buildCanonicalPairKey(pageA, pageB),
      bandHeight: runtime.calculateCanonicalSeamHeight(pageA.width, pageB.width)
    };
  }
  scope.evaluateSeamEvidence = evaluateSeamEvidence;
  function ensureEdgeWait(record) {
    if (!record || !(record.edgeSides || []).length) return;
    const relevant = scope.relevantAdjacentRelations(record);
    if (relevant.length > 0 && relevant.every(relation => scope.relationIsTerminal(record, relation))) {
      scope.store.clearEdgeWait(record.pageId, scope.clearTimer);
      return;
    }
    const existingWait = scope.store.getEdgeWait(record.pageId);
    if (existingWait && existingWait.imageRevision === record.imageRevision) return;
    if (existingWait) scope.store.clearEdgeWait(record.pageId, scope.clearTimer);
    const deadline = scope.now() + scope.edgeWaitTimeoutMs;
    const waitState = {
      deadline,
      timedOut: false,
      timer: null,
      imageRevision: record.imageRevision
    };
    if (typeof scope.setTimer === "function") {
      waitState.timer = scope.setTimer(() => {
        const current = scope.store.getEdgeWait(record.pageId);
        const currentRecord = scope.store.getPageHandle(record.pageId);
        if (!current || !currentRecord || current.imageRevision !== record.imageRevision || current.imageRevision !== currentRecord.imageRevision) return;
        scope.store.setEdgeWait(record.pageId, {
          ...current,
          timer: null,
          timedOut: true
        });
        scope.trace("edge-timeout", record.target, {
          pageId: record.pageId
        });
        void scope.refreshCanonicalState({
          reason: "edge-timeout",
          focusPageIds: [record.pageId]
        });
      }, scope.edgeWaitTimeoutMs);
    }
    scope.store.setEdgeWait(record.pageId, waitState);
  }
  scope.ensureEdgeWait = ensureEdgeWait;
  function releaseCompletedEdgeWaits() {
    for (const record of scope.store.getPageHandles()) {
      const wait = scope.store.getEdgeWait(record.pageId);
      if (!wait || wait.timedOut) continue;
      const relevant = scope.relevantAdjacentRelations(record);
      if (relevant.length > 0 && relevant.every(relation => scope.relationIsTerminal(record, relation))) {
        scope.store.clearEdgeWait(record.pageId, scope.clearTimer);
      }
    }
  }
  scope.releaseCompletedEdgeWaits = releaseCompletedEdgeWaits;
  function relevantAdjacentRelations(record) {
    return (record.adjacentTargets || []).filter(relation => relation.side === "previous" && (record.edgeSides || []).includes("top") || relation.side === "next" && (record.edgeSides || []).includes("bottom"));
  }
  scope.relevantAdjacentRelations = relevantAdjacentRelations;
  function relationIsTerminal(record, relation) {
    const neighbor = scope.store.getPageHandleForTarget(relation.target);
    if (!neighbor) return false;
    const pair = relation.side === "previous" ? [neighbor, record] : [record, neighbor];
    const state = scope.store.getSeamState(runtime.buildCanonicalPairKey(pair[0], pair[1]));
    return !!state && ["completed", "failed", "skipped", "stale"].includes(state.status);
  }
  scope.relationIsTerminal = relationIsTerminal;
}
