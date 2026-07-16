export function installCanonicalSetup(runtime, scope) {
  if (!scope.adapters) throw new Error("KakaoCanonicalPipeline: adapters required");
  const extractTargetPayload = runtime.requireCanonicalAdapter(scope.adapters, "extractTargetPayload");
  scope.extractTargetPayload = extractTargetPayload;
  const buildPageIdentity = runtime.requireCanonicalAdapter(scope.adapters, "buildPageIdentity", "buildKakaoPageIdentity");
  scope.buildPageIdentity = buildPageIdentity;
  const commitPageIdentity = typeof scope.adapters.commitPageIdentity === "function" ? scope.adapters.commitPageIdentity : null;
  scope.commitPageIdentity = commitPageIdentity;
  const requestOcrForPayload = runtime.requireCanonicalAdapter(scope.adapters, "requestOcrForPayload");
  scope.requestOcrForPayload = requestOcrForPayload;
  const requestCanonicalTranslations = runtime.requireCanonicalAdapter(scope.adapters, "requestCanonicalTranslations");
  scope.requestCanonicalTranslations = requestCanonicalTranslations;
  const renderCanonicalProjections = runtime.requireCanonicalAdapter(scope.adapters, "renderCanonicalProjections");
  scope.renderCanonicalProjections = renderCanonicalProjections;
  const findAdjacentTargets = scope.adapters.findAdjacentPageTargets || scope.adapters.findAdjacentKakaoPageTargets || (() => ({}));
  scope.findAdjacentTargets = findAdjacentTargets;
  const buildSeamPayload = scope.adapters.buildSeamPayload || scope.adapters.buildKakaoSeamPayload || null;
  scope.buildSeamPayload = buildSeamPayload;
  const detectPixelRisk = scope.adapters.detectAdjacentPixelRisk || scope.adapters.detectAdjacentKakaoPixelRisk || null;
  scope.detectPixelRisk = detectPixelRisk;
  const getTargetForPageId = scope.adapters.getTargetForPageId || scope.adapters.getTargetForKakaoPageId || null;
  scope.getTargetForPageId = getTargetForPageId;
  const isAuthoritativePagePayload = typeof scope.adapters.isAuthoritativePagePayload === "function" ? scope.adapters.isAuthoritativePagePayload : runtime.defaultIsAuthoritativePagePayload;
  scope.isAuthoritativePagePayload = isAuthoritativePagePayload;
  // Window 的计时器方法需要以 Window 为 receiver；脱离对象裸调用会在浏览器抛出 Illegal invocation。
  const defaultSetTimer = typeof globalThis.setTimeout === "function" ? globalThis.setTimeout.bind(globalThis) : null;
  const defaultClearTimer = typeof globalThis.clearTimeout === "function" ? globalThis.clearTimeout.bind(globalThis) : null;
  const setTimer = scope.adapters.setTimer || defaultSetTimer;
  scope.setTimer = setTimer;
  const clearTimer = scope.adapters.clearTimer || defaultClearTimer;
  scope.clearTimer = clearTimer;
  const now = typeof scope.adapters.now === "function" ? scope.adapters.now : () => Date.now();
  scope.now = now;
  const getTargetGeneration = typeof scope.adapters.getTargetGeneration === "function" ? scope.adapters.getTargetGeneration : () => 0;
  scope.getTargetGeneration = getTargetGeneration;
  const edgeWaitTimeoutMs = Math.max(0, Number(scope.adapters.edgeWaitTimeoutMs ?? runtime.KAKAO_EDGE_WAIT_TIMEOUT_MS));
  scope.edgeWaitTimeoutMs = edgeWaitTimeoutMs;
  const extractTimeoutMs = Math.max(0, Number(scope.adapters.extractTimeoutMs ?? 30000));
  scope.extractTimeoutMs = extractTimeoutMs;
  const identityTimeoutMs = Math.max(0, Number(scope.adapters.identityTimeoutMs ?? 30000));
  scope.identityTimeoutMs = identityTimeoutMs;
  const pageOcrTimeoutMs = Math.max(0, Number(scope.adapters.pageOcrTimeoutMs ?? 30000));
  scope.pageOcrTimeoutMs = pageOcrTimeoutMs;
  const seamTimeoutMs = Math.max(0, Number(scope.adapters.seamTimeoutMs ?? 30000));
  scope.seamTimeoutMs = seamTimeoutMs;
  const store = scope.adapters.store || runtime.createStore();
  scope.store = store;
  let runSeq = 0;
  scope.runSeq = runSeq;
  let targetHandleSeq = 0;
  scope.targetHandleSeq = targetHandleSeq;
  const targetHandleIds = new WeakMap();
  scope.targetHandleIds = targetHandleIds;
  const activeRunByTarget = new WeakMap();
  scope.activeRunByTarget = activeRunByTarget;
  function getTargetHandleId(target) {
    if (!target || typeof target !== "object" && typeof target !== "function") return "no-target";
    let id = scope.targetHandleIds.get(target);
    if (!id) {
      id = `handle-${++scope.targetHandleSeq}`;
      scope.targetHandleIds.set(target, id);
    }
    return id;
  }
  scope.getTargetHandleId = getTargetHandleId;
  function trace(event, target, details = {}) {
    if (typeof scope.adapters.tracePipeline === "function") {
      scope.adapters.tracePipeline(`canonical:${event}`, target, details);
    }
  }
  scope.trace = trace;
  function loading(target, targetKey, label) {
    if (typeof scope.adapters.renderLoadingOverlay === "function") {
      scope.adapters.renderLoadingOverlay(target, targetKey, label);
    }
  }
  scope.loading = loading;
  function targetIsUsable(target) {
    return !!target && target.isConnected !== false;
  }
  scope.targetIsUsable = targetIsUsable;
  function withCanonicalTimeout(promise, timeoutMs, message) {
    if (!(timeoutMs > 0)) return Promise.resolve(promise);
    const deadlineSetTimer = defaultSetTimer || scope.setTimer;
    const deadlineClearTimer = defaultClearTimer || scope.clearTimer;
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = deadlineSetTimer(() => {
        if (settled) return;
        settled = true;
        reject(new Error(message));
      }, timeoutMs);
      Promise.resolve(promise).then(value => {
        if (settled) return;
        settled = true;
        deadlineClearTimer(timer);
        resolve(value);
      }, error => {
        if (settled) return;
        settled = true;
        deadlineClearTimer(timer);
        reject(error);
      });
    });
  }
  scope.withCanonicalTimeout = withCanonicalTimeout;
  function buildJobIdentity(target) {
    const targetKey = scope.adapters.computeTargetKey(target);
    const sourceToken = scope.adapters.getQuickSourceToken(target);
    const sourceGeneration = String(scope.getTargetGeneration(target));
    const targetHandleId = scope.getTargetHandleId(target);
    const scopedTargetKey = scope.adapters.buildTargetSourceCacheKey(targetKey, sourceToken);
    const runSequence = ++scope.runSeq;
    return {
      targetKey,
      sourceToken,
      sourceGeneration,
      targetHandleId,
      scopedTargetKey,
      jobKey: `canonical-job:${scopedTargetKey}:${targetHandleId}`,
      runSequence,
      runId: `canonical-run-${runSequence}`
    };
  }
  scope.buildJobIdentity = buildJobIdentity;
  function isCurrentJob(target, identity) {
    if (!scope.targetIsUsable(target) || !scope.store.isCurrentPageJob(identity.jobKey, identity)) return false;
    const sourceToken = scope.adapters.getQuickSourceToken(target);
    if (String(sourceToken) !== String(identity.sourceToken)) return false;
    if (String(scope.getTargetGeneration(target)) !== String(identity.sourceGeneration)) return false;
    const targetKey = scope.adapters.computeTargetKey(target);
    return scope.adapters.buildTargetSourceCacheKey(targetKey, sourceToken) === identity.scopedTargetKey;
  }
  scope.isCurrentJob = isCurrentJob;
  function isReadyPageRecord(record) {
    if (!record || record.pageOcrState !== "ready") return false;
    const terminal = scope.store.getPageTerminal(record.pageId);
    if (!terminal || terminal.state !== "ready") return false;
    const terminalRevision = String(terminal.details?.imageRevision || "");
    return !terminalRevision || terminalRevision === String(record.imageRevision || "");
  }
  scope.isReadyPageRecord = isReadyPageRecord;
  function isCurrentPageRevision(record) {
    if (!record || !record.pageId) return false;
    const current = scope.store.getPageHandle(record.pageId);
    return !!current && String(current.imageRevision || "") === String(record.imageRevision || "");
  }
  scope.isCurrentPageRevision = isCurrentPageRevision;
  function canCommitPageRevision(target, identity, pageIdentity) {
    const current = scope.store.getPageHandle(pageIdentity.pageId);
    if (!current || String(current.imageRevision || "") === String(pageIdentity.imageRevision || "")) return true;
    const binding = typeof scope.store.getPageBindingForTarget === "function" ? scope.store.getPageBindingForTarget(target) : null;
    if (binding && binding.pageId === pageIdentity.pageId && String(binding.imageRevision || "") === String(pageIdentity.imageRevision || "") && String(binding.imageRevision || "") !== String(current.imageRevision || "")) {
      return false;
    }
    return Number(current.runSequence || 0) <= Number(identity.runSequence || 0);
  }
  scope.canCommitPageRevision = canCommitPageRevision;
  function cancelJob(target, identity, pageId, reason) {
    const ownsCurrentJob = scope.store.isCurrentPageJob(identity.jobKey, identity);
    if (ownsCurrentJob) {
      const currentHandle = pageId ? scope.store.getPageHandle(pageId) : null;
      if (pageId && currentHandle && currentHandle.target === target && !scope.isReadyPageRecord(currentHandle)) {
        scope.store.setCanonicalPagePhase(pageId, runtime.CanonicalPhase.CANCELLED);
      }
      scope.store.cancelPageJob(identity.jobKey, identity);
    }
    if (ownsCurrentJob && scope.activeRunByTarget.get(target) === identity && typeof scope.adapters.clearLoadingOverlay === "function") {
      try {
        scope.adapters.clearLoadingOverlay(target);
      } catch {/* 清理只是 UI 恢复 */}
    }
    scope.trace("cancelled", target, {
      runId: identity.runId,
      pageId,
      reason
    });
    return {
      ok: false,
      skipped: true,
      reason: `cancelled:${reason}`
    };
  }
  scope.cancelJob = cancelJob;
  function run(target, options = {}) {
    const identity = scope.buildJobIdentity(target);
    return scope.store.getOrCreateInflightJob(`canonical-target:${identity.scopedTargetKey}:${identity.sourceGeneration}:${identity.targetHandleId}`, async () => {
      const previousRun = scope.activeRunByTarget.get(target);
      identity.suppressLoadingClear = !!previousRun && previousRun !== identity;
      scope.activeRunByTarget.set(target, identity);
      scope.store.beginPageJob(identity.jobKey, identity);
      return scope.execute(target, identity, options);
    });
  }
  scope.run = run;
}
