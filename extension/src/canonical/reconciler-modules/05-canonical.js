export function installReconciler05(runtime) {
  function applyCanonicalHistory(drafts, previousCanonicals, pageIndex, pageById) {
    const previous = (Array.isArray(previousCanonicals) ? previousCanonicals : []).filter(canonical => canonical && canonical.id).map(canonical => ({
      ...canonical
    }));
    const unusedPrevious = new Set(previous.map(canonical => canonical.id));
    const exactDraftIds = new Set(drafts.map(draft => String(draft && draft.id || "")).filter(Boolean));
    const retired = [];
    const output = [];
    for (const draft of drafts) {
      let matched = previous.find(canonical => unusedPrevious.has(canonical.id) && canonical.id === draft.id) || null;
      if (!matched) {
        matched = previous
        // 只要当前批次仍有同 ID 的直接后继，就为它保留历史 ID。
        // 否则先排序的相邻 seam 可能凭几何相似度抢走页面 canonical 的 ID，
        // 后续 Map 落库会静默覆盖其中一个完整语义项。
        .filter(canonical => unusedPrevious.has(canonical.id) && !exactDraftIds.has(canonical.id)).map(canonical => ({
          canonical,
          memberOverlap: canonical.memberObservationIds?.filter(id => draft.memberObservationIds.includes(id)).length || 0,
          geometry: runtime.canonicalGeometrySimilarity(draft, canonical, pageById)
        })).filter(candidate => candidate.memberOverlap > 0 || candidate.geometry >= 0.58).sort((left, right) => right.memberOverlap - left.memberOverlap || right.geometry - left.geometry || left.canonical.id.localeCompare(right.canonical.id))[0]?.canonical || null;
      }
      const evidenceGeneration = Math.max(1, Number(draft.evidenceGeneration) || 1);
      if (!matched) {
        const {
          evidenceGeneration: _generation,
          ...publicDraft
        } = draft;
        output.push(runtime.deepFreeze({
          ...publicDraft,
          revision: evidenceGeneration
        }));
        continue;
      }
      unusedPrevious.delete(matched.id);
      const draftEarliest = runtime.earliestPageIndexForCanonical(draft, pageIndex);
      const previousEarliest = runtime.earliestPageIndexForCanonical(matched, pageIndex);
      const earlierAnchorArrived = draftEarliest < previousEarliest;
      const stableId = earlierAnchorArrived ? draft.id : matched.id;
      const {
        evidenceGeneration: _generation,
        ...publicDraft
      } = draft;
      const nextDraft = {
        ...publicDraft,
        id: stableId
      };
      const unchanged = !earlierAnchorArrived && runtime.canonicalSignature(nextDraft) === runtime.canonicalSignature(matched);
      nextDraft.revision = unchanged ? Math.max(evidenceGeneration, Math.max(1, Number(matched.revision) || 1)) : Math.max(evidenceGeneration, Math.max(1, Number(matched.revision) || 1) + 1);
      if (earlierAnchorArrived) {
        retired.push(runtime.deepFreeze({
          ...matched,
          retiredById: nextDraft.id,
          published: true
        }));
      }
      output.push(runtime.deepFreeze(nextDraft));
    }
    for (const canonical of previous) {
      if (unusedPrevious.has(canonical.id)) {
        const successor = output.find(candidate => candidate.supersedesId === canonical.id) || null;
        retired.push(runtime.deepFreeze({
          ...canonical,
          retiredById: successor?.id || null,
          published: true
        }));
      }
    }
    return {
      canonicals: output,
      retiredCanonicals: retired
    };
  }
  runtime.applyCanonicalHistory = applyCanonicalHistory;
  function assertCoverageInvariants({
    observations = [],
    canonicals = [],
    ledger = {}
  } = {}) {
    const errors = [];
    const ids = observations.map(observation => observation.id);
    const canonicalIds = canonicals.map(canonical => String(canonical && canonical.id || "")).filter(Boolean);
    if (new Set(canonicalIds).size !== canonicalIds.length) errors.push("duplicate_canonical_id");
    for (const id of ids) {
      const resolution = ledger[id];
      if (!resolution) errors.push(`unresolved:${id}`);else if (!["standalone", "consumed", "filtered"].includes(resolution.resolution)) errors.push(`invalid:${id}`);
    }
    for (const id of Object.keys(ledger)) {
      if (!ids.includes(id)) errors.push(`unknown:${id}`);
    }
    const memberships = new Map();
    for (const canonical of canonicals) {
      for (const id of canonical.memberObservationIds || []) {
        memberships.set(id, (memberships.get(id) || 0) + 1);
      }
    }
    for (const [id, count] of memberships) {
      if (count > 1) errors.push(`multiple_active_canonicals:${id}`);
      if (ledger[id]?.resolution === "filtered") errors.push(`filtered_is_active:${id}`);
    }
    for (const id of ids) {
      const resolution = ledger[id];
      if (resolution?.resolution !== "filtered" && (memberships.get(id) || 0) !== 1) {
        errors.push(`active_membership:${id}:${memberships.get(id) || 0}`);
      }
      if (resolution?.resolution === "filtered" && !resolution.filterReason) errors.push(`missing_filter_reason:${id}`);
    }
    if (errors.length) {
      const error = new Error(`Coverage invariants failed: ${errors.join(", ")}`);
      error.code = "KAKAO_COVERAGE_INVARIANT";
      error.details = errors;
      throw error;
    }
    return true;
  }
  runtime.assertCoverageInvariants = assertCoverageInvariants;
}
