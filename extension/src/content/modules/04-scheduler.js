export function installContent04(runtime) {
  function scheduleAggressivePreloadSweep(reason) {
    if (!runtime.state.aggressivePreload || runtime.state.invalidated || !runtime.state.enabled) {
      return;
    }
    if (runtime.state.preloadQueue.length >= runtime.AGGRESSIVE_PRELOAD_MAX_QUEUE) {
      return;
    }
    if (runtime.state.aggressiveSweepTimer) {
      return;
    }
    const run = () => {
      runtime.state.aggressiveSweepTimer = 0;
      runtime.triggerAggressivePreloadSweep(reason);
    };
    if (typeof window.requestIdleCallback === "function") {
      runtime.state.aggressiveSweepTimer = window.requestIdleCallback(() => {
        run();
      }, {
        timeout: 320
      });
      return;
    }
    runtime.state.aggressiveSweepTimer = window.setTimeout(run, 180);
  }
  runtime.scheduleAggressivePreloadSweep = scheduleAggressivePreloadSweep;
  function triggerAggressivePreloadSweep() {
    if (!runtime.state.aggressivePreload || runtime.state.invalidated || !runtime.state.enabled) {
      return;
    }
    if (runtime.state.preloadQueue.length >= runtime.AGGRESSIVE_PRELOAD_MAX_QUEUE) {
      return;
    }
    const now = Date.now();
    if (now - runtime.state.lastAggressivePreloadSweepAt < runtime.AGGRESSIVE_PRELOAD_SWEEP_GAP_MS) {
      return;
    }
    runtime.state.lastAggressivePreloadSweepAt = now;
    const root = runtime.IS_CMOA_SPEED_READER ? document.querySelector("#content") || document.documentElement : document.documentElement;
    const nodes = root ? root.querySelectorAll(runtime.TARGET_SELECTOR) : [];
    const viewportCenterY = window.innerHeight / 2;
    const candidates = Array.from(nodes).filter(target => runtime.isSupportedTarget(target) && target.isConnected).filter(target => !runtime.state.preloadQueuedTargets.has(target) && !runtime.state.preloadInFlightByTarget.has(target)).filter(target => !runtime.state.inflightByTarget.has(target)).filter(target => runtime.passesTargetFilter(target, false)).map(target => {
      const rect = target.getBoundingClientRect();
      return {
        target,
        rect,
        distance: Math.abs(rect.top + rect.height / 2 - viewportCenterY),
        area: runtime.getVisibleArea(rect)
      };
    }).filter(item => item.rect.top < window.innerHeight + 2800 && item.rect.bottom > -2800).sort((left, right) => left.distance - right.distance || right.area - left.area).slice(0, runtime.AGGRESSIVE_PRELOAD_BATCH);
    for (const item of candidates) {
      runtime.queuePreload(item.target, {
        priority: "high"
      });
      if (runtime.state.preloadQueue.length >= runtime.AGGRESSIVE_PRELOAD_MAX_QUEUE) {
        break;
      }
    }
  }
  runtime.triggerAggressivePreloadSweep = triggerAggressivePreloadSweep;
}
