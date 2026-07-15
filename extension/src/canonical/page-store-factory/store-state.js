export function installStoreState(runtime, scope) {
  /** @type {Map<string, Array<{box, text, translatedText, completeness, targetKey}>>} */
  const globalOcrEntries = new Map();

  /** @type {Map<string, string>}  pageJobPhase: targetKey → phase */
  scope.globalOcrEntries = globalOcrEntries;
  const pageJobPhase = new Map();

  /** @type {Map<string, Promise>} 合并中的重复请求 */
  scope.pageJobPhase = pageJobPhase;
  const inflightJobs = new Map();

  /** 当前页面作业身份，避免依赖 DOM dataset 充当并发锁。 */
  scope.inflightJobs = inflightJobs;
  const currentJobs = new Map();

  /** 短页附着关系仅由 Store 管理。 */
  scope.currentJobs = currentJobs;
  let shortPageAttachments = new WeakMap();

  /** 页面重试计时器及计数。 */
  scope.shortPageAttachments = shortPageAttachments;
  const retryStates = new Map();

  /** @type {number} 去重事务序列号，用于调试 */
  scope.retryStates = retryStates;
  let dedupeTxnSeq = 0;

  /** 串行化去重锁 */
  scope.dedupeTxnSeq = dedupeTxnSeq;
  let dedupeLock = Promise.resolve();

  /* Canonical pipeline semantic state. DOM handles are only bindings. */
  scope.dedupeLock = dedupeLock;
  const pageHandles = new Map();
  scope.pageHandles = pageHandles;
  let pageHandleByTarget = new WeakMap();
  scope.pageHandleByTarget = pageHandleByTarget;
  const canonicalPagePhases = new Map();
  scope.canonicalPagePhases = canonicalPagePhases;
  const pageTerminalStates = new Map();
  scope.pageTerminalStates = pageTerminalStates;
  const observations = new Map();
  scope.observations = observations;
  const observationIdsByPage = new Map();
  scope.observationIdsByPage = observationIdsByPage;
  const filteredObservations = new Map();
  scope.filteredObservations = filteredObservations;
  const seamStates = new Map();
  scope.seamStates = seamStates;
  const canonicalSnapshots = new Map();
  scope.canonicalSnapshots = canonicalSnapshots;
  const retiredCanonicalSnapshots = new Map();
  scope.retiredCanonicalSnapshots = retiredCanonicalSnapshots;
  let reconcileDiagnostics = Object.freeze({});
  scope.reconcileDiagnostics = reconcileDiagnostics;
  const coverageLedger = new Map();
  scope.coverageLedger = coverageLedger;
  const projectionsByPage = new Map();
  scope.projectionsByPage = projectionsByPage;
  const translationsByCanonicalRevision = new Map();
  scope.translationsByCanonicalRevision = translationsByCanonicalRevision;
  const translationErrorsByCanonicalRevision = new Map();
  scope.translationErrorsByCanonicalRevision = translationErrorsByCanonicalRevision;
  const pendingTranslationKeys = new Set();
  scope.pendingTranslationKeys = pendingTranslationKeys;
  const pendingTranslationWaiters = new Map();
  scope.pendingTranslationWaiters = pendingTranslationWaiters;
  const attemptedTranslationKeys = new Set();
  scope.attemptedTranslationKeys = attemptedTranslationKeys;
  const edgeWaitStates = new Map();
  scope.edgeWaitStates = edgeWaitStates;
  let reconcileTxnSeq = 0;
  scope.reconcileTxnSeq = reconcileTxnSeq;
  let reconcileLock = Promise.resolve();
  scope.reconcileLock = reconcileLock;
  const entrySource = Symbol("kakaoStoreEntrySource");
  scope.entrySource = entrySource;
  const snapshotEntry = entry => {
    const snapshot = {
      ...entry,
      box: entry && entry.box ? Object.freeze({
        ...entry.box
      }) : entry && entry.box
    };
    Object.defineProperty(snapshot, scope.entrySource, {
      value: entry && entry[scope.entrySource] || entry,
      enumerable: false
    });
    return Object.freeze(snapshot);
  };
  scope.snapshotEntry = snapshotEntry;
  scope.result = {};
}
