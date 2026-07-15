export function installReconcilerStore(runtime) {
  function createCanonicalStore() {
    const pages = new Map();
    const pageHandles = new Map();
    const pageObservations = new Map();
    const seamObservations = new Map();
    const filteredByCapture = new Map();
    const translations = new Map();
    const completedSeamPairs = new Set();
    const inflight = new Map();
    let snapshot = runtime.deepFreeze({
      canonicals: [],
      retiredCanonicals: [],
      ledger: {},
      diagnostics: {}
    });
    let projections = [];
    let serial = Promise.resolve();
    function orderedPages() {
      return runtime.sortPages(Array.from(pages.values()));
    }
    function allObservations() {
      return [...Array.from(pageObservations.values()).flat(), ...Array.from(seamObservations.values()).flat()];
    }
    function allFiltered() {
      return Array.from(filteredByCapture.values()).flat();
    }
    function mergeByObservationId(previous, next) {
      return Array.from(new Map([...previous, ...next].map(observation => [observation.id, observation])).values()).sort((left, right) => left.id.localeCompare(right.id));
    }
    function transact(factory) {
      const run = serial.then(() => factory());
      serial = run.catch(() => undefined);
      return run;
    }
    return {
      upsertPage(page) {
        const normalized = runtime.normalizePage(page, pages.size);
        pages.set(normalized.pageId, normalized);
        return normalized;
      },
      getPage(pageId) {
        return pages.get(String(pageId)) || null;
      },
      getPages() {
        return orderedPages();
      },
      bindPageHandle(pageId, handle) {
        pageHandles.set(String(pageId), handle);
      },
      unbindPageHandle(pageId, handle) {
        const id = String(pageId);
        if (!pageHandles.has(id) || handle !== undefined && pageHandles.get(id) !== handle) return false;
        pageHandles.delete(id);
        return true;
      },
      getPageHandle(pageId) {
        return pageHandles.get(String(pageId)) || null;
      },
      setPageObservations(pageId, values, filtered = []) {
        const id = String(pageId);
        pageObservations.set(id, mergeByObservationId(pageObservations.get(id) || [], values.map(runtime.createObservation)));
        const filterKey = `page:${id}`;
        filteredByCapture.set(filterKey, mergeByObservationId(filteredByCapture.get(filterKey) || [], filtered.map(runtime.createObservation)));
      },
      setSeamObservations(pairKey, values, filtered = []) {
        seamObservations.set(String(pairKey), values.map(runtime.createObservation));
        filteredByCapture.set(`seam:${pairKey}`, filtered.map(runtime.createObservation));
        completedSeamPairs.add(String(pairKey));
      },
      hasCompletedSeamPair(pairKey) {
        return completedSeamPairs.has(String(pairKey));
      },
      markSeamPairComplete(pairKey) {
        completedSeamPairs.add(String(pairKey));
      },
      getObservations() {
        return allObservations();
      },
      getFilteredObservations() {
        return allFiltered();
      },
      runSerialized(factory) {
        return transact(() => factory(this));
      },
      reconcile() {
        snapshot = runtime.reconcileObservations({
          pages: orderedPages(),
          observations: allObservations(),
          filteredObservations: allFiltered(),
          previousCanonicals: snapshot.canonicals
        });
        projections = runtime.buildRenderProjections({
          pages: orderedPages(),
          canonicals: snapshot.canonicals,
          availablePageIds: Array.from(pageHandles.keys()),
          translations
        });
        return snapshot;
      },
      getSnapshot() {
        return snapshot;
      },
      setTranslation(id, revision, value) {
        translations.set(`${id}@${revision}`, value);
      },
      getTranslation(id, revision) {
        return translations.get(`${id}@${revision}`) || null;
      },
      rebuildProjections() {
        projections = runtime.buildRenderProjections({
          pages: orderedPages(),
          canonicals: snapshot.canonicals,
          availablePageIds: Array.from(pageHandles.keys()),
          translations
        });
        return projections;
      },
      getProjections(pageId) {
        return projections.filter(projection => !pageId || projection.pageId === pageId);
      },
      getOrCreateInflight(key, factory) {
        const stableKey = String(key);
        if (inflight.has(stableKey)) return inflight.get(stableKey);
        const promise = Promise.resolve().then(factory).finally(() => {
          if (inflight.get(stableKey) === promise) inflight.delete(stableKey);
        });
        inflight.set(stableKey, promise);
        return promise;
      },
      reset() {
        pages.clear();
        pageHandles.clear();
        pageObservations.clear();
        seamObservations.clear();
        filteredByCapture.clear();
        translations.clear();
        completedSeamPairs.clear();
        inflight.clear();
        snapshot = runtime.deepFreeze({
          canonicals: [],
          retiredCanonicals: [],
          ledger: {},
          diagnostics: {}
        });
        projections = [];
        serial = Promise.resolve();
      }
    };
  }
  runtime.createCanonicalStore = createCanonicalStore;
}
