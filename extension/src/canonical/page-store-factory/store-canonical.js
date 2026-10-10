export function installStoreCanonical(runtime, scope) {
  Object.assign(scope.result, {
    markSeamState(pairKey, state) {
      const key = String(pairKey || "");
      const frozen = runtime.freezeCanonicalValue({
        ...(state || {}),
        pairKey: key
      });
      scope.seamStates.set(key, frozen);
      return frozen;
    },
    getSeamState(pairKey) {
      return scope.seamStates.get(String(pairKey || "")) || null;
    },
    getSeamStates() {
      return [...scope.seamStates.values()].sort((a, b) => String(a.pairKey).localeCompare(String(b.pairKey)));
    },
    async runSerializedReconcile(fn) {
      scope.reconcileTxnSeq += 1;
      const seq = scope.reconcileTxnSeq;
      const operation = scope.reconcileLock.catch(() => undefined).then(() => fn({
        seq,
        store: this
      }));
      scope.reconcileLock = operation.then(() => undefined, () => undefined);
      return operation;
    },
    setCanonicalSnapshot(snapshot) {
      scope.canonicalSnapshots.clear();
      scope.retiredCanonicalSnapshots.clear();
      const canonicals = Array.isArray(snapshot) ? snapshot : Array.isArray(snapshot && snapshot.canonicals) ? snapshot.canonicals : [];
      for (const canonical of canonicals) {
        if (canonical && canonical.id) scope.canonicalSnapshots.set(String(canonical.id), runtime.freezeCanonical(canonical));
      }
      const retired = Array.isArray(snapshot && snapshot.retiredCanonicals) ? snapshot.retiredCanonicals : [];
      for (const canonical of retired) {
        if (canonical && canonical.id) scope.retiredCanonicalSnapshots.set(String(canonical.id), runtime.freezeCanonical(canonical));
      }
    },
    getCanonicalSnapshot() {
      return [...scope.canonicalSnapshots.values()].sort(runtime.compareCanonicalRecords);
    },
    getRetiredCanonicals() {
      return [...scope.retiredCanonicalSnapshots.values()].sort(runtime.compareCanonicalRecords);
    },
    setReconcileDiagnostics(value) {
      scope.reconcileDiagnostics = runtime.freezeCanonicalValue(value || {});
    },
    getReconcileDiagnostics() {
      return scope.reconcileDiagnostics;
    },
    setCoverageLedger(ledger) {
      scope.coverageLedger.clear();
      const entries = ledger instanceof Map ? [...ledger.entries()] : Array.isArray(ledger) ? ledger.map(item => [item && (item.observationId || item.id), item]) : Object.entries(ledger || {});
      for (const [observationId, value] of entries) {
        if (observationId && value) scope.coverageLedger.set(String(observationId), Object.freeze({
          ...value,
          observationId: String(observationId)
        }));
      }
    },
    getCoverageLedger() {
      return new Map([...scope.coverageLedger.entries()].sort(([a], [b]) => a.localeCompare(b)));
    },
    setProjections(projections) {
      scope.projectionsByPage.clear();
      const entries = projections instanceof Map ? [...projections.entries()] : Object.entries(projections || {});
      for (const [pageId, items] of entries) {
        scope.projectionsByPage.set(String(pageId), Object.freeze((Array.isArray(items) ? items : []).map(item => Object.freeze({
          ...item
        }))));
      }
    },
    getProjections(pageId) {
      return [...(scope.projectionsByPage.get(String(pageId || "")) || [])];
    },
    getAllProjections() {
      return new Map([...scope.projectionsByPage.entries()].map(([pageId, items]) => [pageId, [...items]]));
    },
    getTranslation(canonicalId, revision) {
      return scope.translationsByCanonicalRevision.get(runtime.canonicalRevisionKey(canonicalId, revision)) || null;
    },
    getTranslationFailures(items) {
      const failures = [];
      for (const item of Array.isArray(items) ? items : []) {
        const failure = scope.translationErrorsByCanonicalRevision.get(runtime.canonicalRevisionKey(item && item.id, item && item.revision));
        if (failure) failures.push(failure);
      }
      return failures;
    },
    claimTranslations(items) {
      const claimed = [];
      for (const item of Array.isArray(items) ? items : []) {
        const key = runtime.canonicalRevisionKey(item && item.id, item && item.revision);
        if (!item || !item.id || scope.translationsByCanonicalRevision.has(key) || scope.pendingTranslationKeys.has(key) || scope.attemptedTranslationKeys.has(key)) continue;
        scope.pendingTranslationKeys.add(key);
        scope.attemptedTranslationKeys.add(key);
        if (!scope.pendingTranslationWaiters.has(key)) {
          let resolveWaiter;
          const promise = new Promise(resolve => {
            resolveWaiter = resolve;
          });
          scope.pendingTranslationWaiters.set(key, {
            promise,
            resolve: resolveWaiter
          });
        }
        claimed.push(item);
      }
      return claimed;
    },
    async waitForPendingTranslations(items) {
      const waits = [];
      for (const item of Array.isArray(items) ? items : []) {
        const waiter = scope.pendingTranslationWaiters.get(runtime.canonicalRevisionKey(item && item.id, item && item.revision));
        if (waiter) waits.push(waiter.promise);
      }
      if (waits.length > 0) await Promise.all(waits);
    },
    settleTranslation(item, translation) {
      const key = runtime.canonicalRevisionKey(item && item.id, item && item.revision);
      scope.pendingTranslationKeys.delete(key);
      const waiter = scope.pendingTranslationWaiters.get(key);
      scope.pendingTranslationWaiters.delete(key);
      if (!item || !item.id || !translation) {
        if (waiter) waiter.resolve(false);
        return false;
      }
      const current = scope.canonicalSnapshots.get(String(item.id));
      if (!current || Number(current.revision) !== Number(item.revision)) {
        if (waiter) waiter.resolve(false);
        return false;
      }
      scope.translationsByCanonicalRevision.set(key, Object.freeze({
        ...translation,
        id: String(item.id),
        revision: Number(item.revision) || 1
      }));
      scope.translationErrorsByCanonicalRevision.delete(key);
      if (waiter) waiter.resolve(true);
      return true;
    },
    failTranslationClaims(items, error) {
      const message = runtime.getErrorMessage(error) || "Canonical translation failed";
      for (const item of Array.isArray(items) ? items : []) {
        const key = runtime.canonicalRevisionKey(item && item.id, item && item.revision);
        scope.pendingTranslationKeys.delete(key);
        scope.attemptedTranslationKeys.delete(key);
        const waiter = scope.pendingTranslationWaiters.get(key);
        scope.pendingTranslationWaiters.delete(key);
        scope.translationErrorsByCanonicalRevision.set(key, Object.freeze({
          id: String(item && item.id || ""),
          revision: Math.max(1, Number(item && item.revision) || 1),
          error: message
        }));
        if (waiter) waiter.resolve(false);
      }
    },
    releaseTranslationClaims(items) {
      for (const item of Array.isArray(items) ? items : []) {
        const key = runtime.canonicalRevisionKey(item && item.id, item && item.revision);
        scope.pendingTranslationKeys.delete(key);
        scope.attemptedTranslationKeys.delete(key);
        const waiter = scope.pendingTranslationWaiters.get(key);
        scope.pendingTranslationWaiters.delete(key);
        if (waiter) waiter.resolve(false);
      }
    },
    setEdgeWait(pageId, value) {
      scope.edgeWaitStates.set(String(pageId || ""), {
        ...(value || {})
      });
    },
    getEdgeWait(pageId) {
      const value = scope.edgeWaitStates.get(String(pageId || ""));
      return value ? {
        ...value
      } : null;
    },
    clearEdgeWait(pageId, clearTimer) {
      const key = String(pageId || "");
      const value = scope.edgeWaitStates.get(key) || null;
      scope.edgeWaitStates.delete(key);
      if (value && value.timer && typeof clearTimer === "function") clearTimer(value.timer);
      return value ? {
        ...value
      } : null;
    },
    getOrCreateInflightJob(jobKey, factory) {
      const existing = scope.inflightJobs.get(jobKey);
      if (existing) return existing;
      const promise = factory().finally(() => {
        if (scope.inflightJobs.get(jobKey) === promise) {
          scope.inflightJobs.delete(jobKey);
        }
      });
      scope.inflightJobs.set(jobKey, promise);
      return promise;
    },
    getInflightJob(jobKey) {
      return scope.inflightJobs.get(String(jobKey || "")) || null;
    },
    /** 最近一次清理图计划的判定结果（诊断用：复杂背景旁白有没有拿到 inpainted 遮罩）。 */
    setCleanedArtifactReport(report) {
      scope.cleanedArtifactReport = Array.isArray(report) ? Object.freeze(report.map(item => Object.freeze({ ...item }))) : Object.freeze([]);
    },
    getCleanedArtifactReport() {
      return Array.isArray(scope.cleanedArtifactReport) ? scope.cleanedArtifactReport : [];
    },
    /* ---- 工具 ---- */

    /**
     * 丢弃所有已结算的译文，但保留 OCR 观测与 canonical —— 供「切换翻译模式」使用
     * （provider ↔ ocrOnly）。
     *
     * 为什么必须丢掉而不是留着复用：ocrOnly 模式下的译文是**直通值**（translated_text
     * 就是原文，指纹 passthrough_*）。若把它们留在库里，切回 provider 时
     * `claimTranslations` 会因为 `attemptedTranslationKeys` 命中而直接跳过，
     * 页面就会永远显示日文原文、再也不会请求真正的翻译。
     * 反向同理：留着旧译文会让「已切换到不翻译」的页面继续显示旧译文，前后不一致。
     *
     * `projectionsByPage` 一并清掉，因为 projection 里烘进了 translated_text，
     * 不清就会拿旧值重画。观测/canonical/页句柄都不动，所以不需要重新 OCR。
     */
    dropTranslations() {
      scope.translationsByCanonicalRevision.clear();
      scope.translationErrorsByCanonicalRevision.clear();
      scope.pendingTranslationKeys.clear();
      for (const waiter of scope.pendingTranslationWaiters.values()) waiter.resolve(false);
      scope.pendingTranslationWaiters.clear();
      scope.attemptedTranslationKeys.clear();
      scope.edgeWaitStates.clear();
      scope.projectionsByPage.clear();
    },

    /** 重置所有状态（用于测试或扩展热重载） */
    reset() {
      scope.globalOcrEntries.clear();
      scope.pageJobPhase.clear();
      scope.inflightJobs.clear();
      scope.currentJobs.clear();
      scope.shortPageAttachments = new WeakMap();
      scope.retryStates.clear();
      scope.dedupeLock = Promise.resolve();
      scope.pageHandles.clear();
      scope.pageHandleByTarget = new WeakMap();
      scope.canonicalPagePhases.clear();
      scope.pageTerminalStates.clear();
      scope.observations.clear();
      scope.observationIdsByPage.clear();
      scope.filteredObservations.clear();
      scope.seamStates.clear();
      scope.canonicalSnapshots.clear();
      scope.retiredCanonicalSnapshots.clear();
      scope.reconcileDiagnostics = Object.freeze({});
      scope.coverageLedger.clear();
      scope.projectionsByPage.clear();
      scope.translationsByCanonicalRevision.clear();
      scope.translationErrorsByCanonicalRevision.clear();
      scope.pendingTranslationKeys.clear();
      for (const waiter of scope.pendingTranslationWaiters.values()) waiter.resolve(false);
      scope.pendingTranslationWaiters.clear();
      scope.attemptedTranslationKeys.clear();
      scope.edgeWaitStates.clear();
      scope.reconcileTxnSeq = 0;
      scope.reconcileLock = Promise.resolve();
    }
  });
}
