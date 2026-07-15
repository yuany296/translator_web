export function installPipeline10(runtime) {
  function requireCanonicalAdapter(adapters, ...names) {
    for (const name of names) {
      if (typeof adapters[name] === "function") return adapters[name];
    }
    throw new Error(`KakaoCanonicalPipeline: missing adapter "${names.join(" or ")}"`);
  }
  runtime.requireCanonicalAdapter = requireCanonicalAdapter;
  function defaultIsAuthoritativePagePayload(payload) {
    if (!payload || typeof payload !== "object") return false;
    const source = String(payload.source || "").trim().toLowerCase();
    const mode = String(payload.captureMode || payload.capture_mode || "").trim().toLowerCase();
    return source !== "visible-tab-crop" && source !== "screenshot" && mode !== "screenshot";
  }
  runtime.defaultIsAuthoritativePagePayload = defaultIsAuthoritativePagePayload;
  function canonicalRevisionKey(id, revision) {
    return `${String(id || "")}@${Math.max(1, Number(revision) || 1)}`;
  }
  runtime.canonicalRevisionKey = canonicalRevisionKey;
  function compareStableIds(left, right) {
    return String(left && left.id || left || "").localeCompare(String(right && right.id || right || ""));
  }
  runtime.compareStableIds = compareStableIds;
  function comparePageRecords(left, right) {
    const leftOrder = Number(left && left.readingOrder);
    const rightOrder = Number(right && right.readingOrder);
    if (Number.isFinite(leftOrder) && Number.isFinite(rightOrder) && leftOrder !== rightOrder) return leftOrder - rightOrder;
    return String(left && left.pageId || "").localeCompare(String(right && right.pageId || ""));
  }
  runtime.comparePageRecords = comparePageRecords;
  function compareCanonicalRecords(left, right) {
    const leftPages = Object.keys(left && left.geometryByPage || {});
    const rightPages = Object.keys(right && right.geometryByPage || {});
    const pageCompare = String(leftPages[0] || "").localeCompare(String(rightPages[0] || ""));
    return pageCompare || runtime.compareStableIds(left, right);
  }
  runtime.compareCanonicalRecords = compareCanonicalRecords;
  function compareProjectionRecords(left, right) {
    const roleOrder = {
      primary: 0,
      standby: 1,
      cover: 2
    };
    const roleCompare = (roleOrder[left && left.role] ?? 9) - (roleOrder[right && right.role] ?? 9);
    return roleCompare || String(left && left.canonicalId || "").localeCompare(String(right && right.canonicalId || ""));
  }
  runtime.compareProjectionRecords = compareProjectionRecords;
  function freezeCanonicalValue(value) {
    if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
    if (Array.isArray(value)) return Object.freeze(value.map(runtime.freezeCanonicalValue));
    const copy = {};
    for (const [key, item] of Object.entries(value)) copy[key] = runtime.freezeCanonicalValue(item);
    return Object.freeze(copy);
  }
  runtime.freezeCanonicalValue = freezeCanonicalValue;
}
