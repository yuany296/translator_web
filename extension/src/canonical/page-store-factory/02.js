export function installCreateStore02(runtime, scope) {
  Object.assign(scope.result, {
    /* ---- 全局去重条目 ---- */

    /** 获取当前全部去重条目快照（不可变副本） */
    getGlobalEntries() {
      const all = [];
      for (const entries of scope.globalOcrEntries.values()) {
        for (const entry of entries) {
          all.push(scope.snapshotEntry(entry));
        }
      }
      return all;
    },
    /** 取指定 targetKey 的条目 */
    getEntriesForKey(targetKey) {
      const entries = scope.globalOcrEntries.get(targetKey);
      return entries ? entries.map(scope.snapshotEntry) : [];
    },
    /** 设置指定 targetKey 的条目（替换） */
    setEntriesForKey(targetKey, entries) {
      scope.globalOcrEntries.set(targetKey, Array.isArray(entries) ? entries.map(scope.snapshotEntry) : []);
    },
    /** 删除指定 targetKey 的所有条目 */
    deleteEntriesForKey(targetKey) {
      scope.globalOcrEntries.delete(targetKey);
    },
    /** 从指定 targetKey 的条目列表中移除特定条目引用 */
    removeEntryFromKey(targetKey, entryToRemove) {
      const entries = scope.globalOcrEntries.get(targetKey);
      if (!entries) return;
      const filtered = entries.filter(entry => entry !== entryToRemove && entry[scope.entrySource] !== entryToRemove && entry[scope.entrySource] !== (entryToRemove && entryToRemove[scope.entrySource]) && !(entryToRemove && entry.bubble && entry.bubble === entryToRemove.bubble));
      if (filtered.length === 0) {
        scope.globalOcrEntries.delete(targetKey);
      } else {
        scope.globalOcrEntries.set(targetKey, filtered);
      }
    },
    /** 串行去重：所有去重操作排成一个队列，避免并发页面的竞态 */
    async runSerializedDedupe(fn) {
      scope.dedupeTxnSeq += 1;
      const seq = scope.dedupeTxnSeq;
      const operation = scope.dedupeLock.catch(() => undefined).then(() => fn({
        seq,
        store: this,
        globalOcrEntries: scope.globalOcrEntries
      }));
      scope.dedupeLock = operation.then(() => undefined, () => undefined);
      return operation;
    },
    /* ---- 页面 FSM 状态 ---- */

    getPagePhase(targetKey) {
      return scope.pageJobPhase.get(targetKey) || runtime.PagePhase.WAITING;
    },
    /**
     * 推进 FSM 状态，返回 true 表示转换成功，false 表示非法转换
     * @param {string} targetKey
     * @param {string} toPhase
     * @returns {boolean}
     */
    transitionPagePhase(targetKey, toPhase) {
      const from = this.getPagePhase(targetKey);
      if (!runtime.canTransition(from, toPhase)) {
        console.warn(`[KakaoPipeline] Illegal FSM transition: ${from} → ${toPhase} for ${targetKey.slice(0, 80)}`);
        return false;
      }
      scope.pageJobPhase.set(targetKey, toPhase);
      return true;
    },
    /** 只有当前 phase 匹配时才推进，防止迟到操作覆盖后续状态 */
    transitionIfCurrentPhase(targetKey, expectedFrom, toPhase) {
      const current = this.getPagePhase(targetKey);
      if (current !== expectedFrom) {
        return false;
      }
      return this.transitionPagePhase(targetKey, toPhase);
    },
    resetPagePhase(targetKey) {
      scope.pageJobPhase.set(targetKey, runtime.PagePhase.WAITING);
    },
    deletePagePhase(targetKey) {
      scope.pageJobPhase.delete(targetKey);
    },
    /** 检查页面是否在活动状态 */
    isPageActive(targetKey) {
      return runtime.isActivePhase(this.getPagePhase(targetKey));
    },
    beginPageJob(targetKey, identity) {
      scope.currentJobs.set(targetKey, Object.freeze({
        runId: String(identity && identity.runId || ""),
        sourceToken: String(identity && identity.sourceToken || "")
      }));
    },
    isCurrentPageJob(targetKey, identity) {
      const current = scope.currentJobs.get(targetKey);
      return !!current && current.runId === String(identity && identity.runId || "") && current.sourceToken === String(identity && identity.sourceToken || "");
    },
    finishPageJob(targetKey, identity) {
      if (!this.isCurrentPageJob(targetKey, identity)) {
        return false;
      }
      scope.currentJobs.delete(targetKey);
      return true;
    },
    cancelPageJob(targetKey, identity = null) {
      if (identity && !this.isCurrentPageJob(targetKey, identity)) {
        return false;
      }
      scope.currentJobs.delete(targetKey);
      const phase = this.getPagePhase(targetKey);
      if (runtime.canTransition(phase, runtime.PagePhase.CANCELLED)) {
        scope.pageJobPhase.set(targetKey, runtime.PagePhase.CANCELLED);
      }
      return true;
    },
    getShortPageAttachment(target) {
      const value = scope.shortPageAttachments.get(target);
      return value ? {
        ...value
      } : null;
    },
    attachShortPage(target, ownerKey, attachedAt = Date.now()) {
      const previous = scope.shortPageAttachments.get(target) || {};
      scope.shortPageAttachments.set(target, {
        ownerKey: String(ownerKey || ""),
        attachedAt: Number(attachedAt || 0),
        detachedOwnerKey: String(previous.detachedOwnerKey || ""),
        detachedAt: Number(previous.detachedAt || 0)
      });
    },
    releaseShortPage(target, ownerKey = "", detachedAt = Date.now()) {
      const previous = scope.shortPageAttachments.get(target) || {};
      scope.shortPageAttachments.set(target, {
        ownerKey: "",
        attachedAt: 0,
        detachedOwnerKey: String(ownerKey || previous.ownerKey || ""),
        detachedAt: Number(detachedAt || 0)
      });
    },
    clearShortPage(target) {
      scope.shortPageAttachments.delete(target);
    },
    getRetryState(target) {
      const value = scope.retryStates.get(target);
      return value ? {
        ...value
      } : null;
    },
    setRetryState(target, value) {
      scope.retryStates.set(target, {
        timer: value && value.timer,
        attempts: Number(value && value.attempts || 0),
        retries: Number(value && value.retries || 0)
      });
    },
    clearRetryState(target) {
      const value = scope.retryStates.get(target) || null;
      scope.retryStates.delete(target);
      return value ? {
        ...value
      } : null;
    },
    clearRetryStates(clearTimer) {
      for (const value of scope.retryStates.values()) {
        if (value.timer && typeof clearTimer === "function") {
          clearTimer(value.timer);
        }
      }
      scope.retryStates.clear();
    },
    /* ---- 请求合并 ---- */

    /** 合并重复的 inflight 请求 */
    registerPageHandle(record) {
      if (!record || !record.pageId) throw new Error("KakaoPipeline: page handle requires pageId");
      const pageId = String(record.pageId);
      const previous = scope.pageHandles.get(pageId) || null;
      const next = Object.freeze({
        ...(previous || {}),
        ...record,
        pageId,
        imageRevision: String(record.imageRevision || "")
      });
      scope.pageHandles.set(pageId, next);
      if (record.target && (typeof record.target === "object" || typeof record.target === "function")) {
        scope.pageHandleByTarget.set(record.target, Object.freeze({
          pageId,
          imageRevision: String(record.imageRevision || "")
        }));
      }
      return next;
    },
    getPageHandle(pageId) {
      return scope.pageHandles.get(String(pageId || "")) || null;
    },
    getPageRecord(pageId) {
      return scope.pageHandles.get(String(pageId || "")) || null;
    },
    getPageHandleForTarget(target) {
      const binding = target && scope.pageHandleByTarget.get(target);
      if (!binding) return null;
      const current = scope.pageHandles.get(binding.pageId) || null;
      if (!current || String(current.imageRevision || "") !== String(binding.imageRevision || "")) return null;
      return current;
    },
    getPageBindingForTarget(target) {
      const binding = target && scope.pageHandleByTarget.get(target);
      return binding ? {
        ...binding
      } : null;
    },
    getPageHandles() {
      return [...scope.pageHandles.values()].sort(runtime.comparePageRecords);
    },
    unbindPageTarget(target) {
      if (!target) return false;
      const binding = scope.pageHandleByTarget.get(target);
      scope.pageHandleByTarget.delete(target);
      if (!binding) return false;
      const current = scope.pageHandles.get(binding.pageId);
      if (current && current.target === target) scope.pageHandles.set(binding.pageId, Object.freeze({
        ...current,
        target: null
      }));
      return true;
    },
    setCanonicalPagePhase(pageId, phase, options = {}) {
      const key = String(pageId || "");
      const next = String(phase || runtime.CanonicalPhase.WAITING);
      const current = scope.canonicalPagePhases.get(key) || runtime.CanonicalPhase.WAITING;
      // 已完成的同 revision clone 不得把共享页面状态倒退到中间阶段。
      if (current === runtime.CanonicalPhase.RENDERED && next !== runtime.CanonicalPhase.RENDERED && options.force !== true) {
        return false;
      }
      scope.canonicalPagePhases.set(key, next);
      return true;
    },
    getCanonicalPagePhase(pageId) {
      return scope.canonicalPagePhases.get(String(pageId || "")) || runtime.CanonicalPhase.WAITING;
    },
    markPageTerminal(pageId, state, details = null) {
      scope.pageTerminalStates.set(String(pageId || ""), Object.freeze({
        state: String(state || "ready"),
        details: details || null
      }));
    },
    getPageTerminal(pageId) {
      return scope.pageTerminalStates.get(String(pageId || "")) || null;
    },
    upsertObservations(items, options = {}) {
      const ids = [];
      for (const item of Array.isArray(items) ? items : []) {
        if (!item || !item.id) continue;
        const frozen = runtime.freezeObservation(item);
        scope.observations.set(frozen.id, frozen);
        ids.push(frozen.id);
        for (const pageId of frozen.pageIds) {
          if (!scope.observationIdsByPage.has(pageId)) scope.observationIdsByPage.set(pageId, new Set());
          scope.observationIdsByPage.get(pageId).add(frozen.id);
        }
        if (options.filtered === true) scope.filteredObservations.set(frozen.id, frozen);else scope.filteredObservations.delete(frozen.id);
      }
      return ids;
    },
    replacePageRevisionObservations(pageId, imageRevision, items, filteredItems = []) {
      const stablePageId = String(pageId || "");
      const stableRevision = String(imageRevision || "");
      const indexedIds = [...(scope.observationIdsByPage.get(stablePageId) || [])];
      for (const observationId of indexedIds) {
        const existing = scope.observations.get(observationId);
        if (!existing || existing.sourceType !== "page" || existing.pageIds.length !== 1 || existing.pageIds[0] !== stablePageId || String(existing.imageRevisionByPage[stablePageId] || "") !== stableRevision) {
          continue;
        }
        scope.observations.delete(observationId);
        scope.filteredObservations.delete(observationId);
        scope.observationIdsByPage.get(stablePageId)?.delete(observationId);
      }
      if (scope.observationIdsByPage.get(stablePageId)?.size === 0) {
        scope.observationIdsByPage.delete(stablePageId);
      }
      const activeIds = this.upsertObservations(items);
      const filteredIds = this.upsertObservations(filteredItems, {
        filtered: true
      });
      return {
        activeIds,
        filteredIds
      };
    },
    getObservations() {
      return [...scope.observations.values()].sort(runtime.compareStableIds);
    },
    getObservationsForPage(pageId, options = {}) {
      const ids = scope.observationIdsByPage.get(String(pageId || ""));
      if (!ids) return [];
      const includeFiltered = options.includeFiltered !== false;
      return [...ids].map(id => scope.observations.get(id)).filter(item => item && (includeFiltered || !scope.filteredObservations.has(item.id))).sort(runtime.compareStableIds);
    },
    getFilteredObservations() {
      return [...scope.filteredObservations.values()].sort(runtime.compareStableIds);
    }
  });
}
