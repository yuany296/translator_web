export function installCrossPageLifecycle(runtime) {
  function syncCrossPageOverlayGeometry() {
    for (const entry of runtime.state.crossPageOverlaysByRenderKey.values()) {
      if (!runtime.syncCrossPageSurfaceEntry(entry)) runtime.removeCrossPageSurfaceEntry(entry);
    }
  }
  runtime.syncCrossPageOverlayGeometry = syncCrossPageOverlayGeometry;

  function scheduleCrossPageGeometryRefresh() {
    if (runtime.state.invalidated || runtime.state.crossPageGeometryRaf) return;
    runtime.state.crossPageGeometryRaf = window.requestAnimationFrame(() => {
      runtime.state.crossPageGeometryRaf = 0;
      runtime.syncCrossPageOverlayGeometry();
    });
  }
  runtime.scheduleCrossPageGeometryRefresh = scheduleCrossPageGeometryRefresh;

  function removeCrossPageOverlaysForTarget(target) {
    for (const entry of [...runtime.state.crossPageOverlaysByRenderKey.values()]) {
      if (entry.targets.includes(target)) runtime.removeCrossPageSurfaceEntry(entry);
    }
  }
  runtime.removeCrossPageOverlaysForTarget = removeCrossPageOverlaysForTarget;

  function clearCrossPageOverlays() {
    for (const entry of [...runtime.state.crossPageOverlaysByRenderKey.values()]) runtime.removeCrossPageSurfaceEntry(entry);
    if (runtime.state.crossPageGeometryRaf) window.cancelAnimationFrame(runtime.state.crossPageGeometryRaf);
    runtime.state.crossPageGeometryRaf = 0;
  }
  runtime.clearCrossPageOverlays = clearCrossPageOverlays;

  function setSeamSourceModeForOverlays(_overlays, renderKey, showSource) {
    const entry = runtime.state.crossPageOverlaysByRenderKey.get(String(renderKey || ""));
    if (entry) entry.bubbles.forEach(item => item.overlay.classList.toggle("mt-show-source", showSource));
  }
  runtime.setSeamSourceModeForOverlays = setSeamSourceModeForOverlays;

  function toggleSeamSourceMode(renderKey) {
    const key = String(renderKey || "");
    if (!key) return;
    const showSource = runtime.state.seamSourceModeByRenderKey.get(key) !== true;
    runtime.state.seamSourceModeByRenderKey.set(key, showSource);
    runtime.setSeamSourceModeForOverlays(null, key, showSource);
  }
  runtime.toggleSeamSourceMode = toggleSeamSourceMode;
}
