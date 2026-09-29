export function installCanonicalCleanedArtifacts(runtime, scope) {
  // 清理图落地后补一次刷新：请求可能是在别的 pass 里起跑的，本页那一刻已经渲染过
  // 「没有清理图」的版本。按 pageId 去重；刷新后 artifactKey 已命中缓存，不会自激。
  const maskRefreshByPage = new Map();
  function refreshAfterCleanedImage(pageId, pending = null) {
    const key = String(pageId || "");
    if (!key || maskRefreshByPage.has(key)) return maskRefreshByPage.get(key) || null;
    const task = Promise.resolve(pending).then(() => {
      const latest = scope.store.getPageHandle(key);
      if (!latest || !runtime.isDataUrlValue(latest.cleanedImage)) return null;
      return scope.refreshCanonicalState({
        reason: "cleaned-artifact-ready",
        focusPageIds: [key]
      });
    }).catch(error => {
      scope.trace("cleaned-artifact-refresh-error", null, {
        pageId: key,
        error: runtime.getErrorMessage(error)
      });
      return null;
    }).finally(() => maskRefreshByPage.delete(key));
    maskRefreshByPage.set(key, task);
    return task;
  }
  scope.refreshAfterCleanedImage = refreshAfterCleanedImage;
  // 每个 (pageId, artifactKey) 只补一次刷新：清理图可能在"这一页没有渲染"的那一轮
  // 才落地（批次里其它页请求的），此时页面覆盖层已经画好、却没有遮罩图。
  const maskRefreshIssued = new Set();
  function refreshOnceForCleanedImage(pageId, artifactKey) {
    const key = `${pageId}:${artifactKey}`;
    if (maskRefreshIssued.has(key)) return null;
    maskRefreshIssued.add(key);
    return refreshAfterCleanedImage(pageId);
  }
  scope.refreshOnceForCleanedImage = refreshOnceForCleanedImage;
  // 在途的清理图请求迟迟不落地时，那一页就永远停在 inflight：既拿不到图，也不会
  // 重新请求。这里给一个上限，超时按"夭折"处理，清掉尝试标记让下一轮重新发一次。
  const ARTIFACT_SETTLE_TIMEOUT_MS = 20000;
  function watchInflightArtifact(pageId, artifactKey, inflight) {
    return new Promise(resolve => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        resolve(null);
      };
      let timer = null;
      if (typeof scope.setTimer === "function") {
        timer = scope.setTimer(() => {
          const current = scope.store.getPageHandle(pageId);
          if (current && current.artifactRefreshAttemptedKey === artifactKey) {
            scope.store.registerPageHandle({
              ...current,
              artifactRefreshAttemptedKey: ""
            });
          }
          finish();
        }, ARTIFACT_SETTLE_TIMEOUT_MS);
      }
      const clear = () => {
        if (timer && typeof scope.clearTimer === "function") scope.clearTimer(timer);
        finish();
      };
      Promise.resolve(inflight).then(clear, clear);
    });
  }
  scope.watchInflightArtifact = watchInflightArtifact;
  /**
   * 渲染侧驱动补清理图。
   *
   * 覆盖层要画的是 `bg_type=none` 的透明遮罩、手里却没有清理图时，由渲染侧把
   * "它到底盖住了哪几块"直接报回来，这里照单请求一张 inpainted 图。
   *
   * 为什么不走投影计划：计划要先判断"这一页的投影需不需要清理图"，而这一判断
   * 一直和渲染侧实际画出来的东西分叉（实测同一页渲染出 `mt-bg-none` 的透明遮罩、
   * 计划却判成 no-complex-projection）。渲染侧才是唯一确知"我画了透明遮罩"的地方。
   */
  const maskDemandInflight = new Set();
  async function requestMissingPageMask(pageId, boxes) {
    const key = String(pageId || "");
    if (!key) return null;
    const masks = (Array.isArray(boxes) ? boxes : [])
      .map(box => runtime.normalizeCanonicalCleanMaskGeometry(box))
      .filter(Boolean);
    if (masks.length === 0) return null;
    const handle = scope.store.getPageHandle(key);
    if (!handle || !handle.payload) return null;
    const artifactKey = runtime.buildCleanedArtifactKey(handle.imageRevision, masks);
    if (handle.cleanedImageArtifactKey === artifactKey && runtime.isDataUrlValue(handle.cleanedImage)) {
      // 图在手上不代表画在屏上：覆盖层可能是图落地之前渲染的那一版。
      scope.applyCleanedImageToPageOverlays?.(key, handle.cleanedImage);
      return null;
    }
    // 退避：渲染可能很频繁，服务端连续给不出清理图时不能每次渲染都打一次请求。
    if (handle.artifactRefreshRetryKey === artifactKey &&
        Number(handle.artifactRefreshRetryAfter || 0) > scope.now()) return null;
    const inflightKey = `${key}:${artifactKey}`;
    if (maskDemandInflight.has(inflightKey)) return null;
    maskDemandInflight.add(inflightKey);
    scope.store.registerPageHandle({
      ...handle,
      artifactRefreshAttemptedKey: artifactKey,
      artifactRefreshRetryKey: "",
      artifactRefreshRetryAfter: 0,
      artifactRefreshRetryTimer: null
    });
    const releaseAttempt = () => {
      const current = scope.store.getPageHandle(key);
      if (current && current.artifactRefreshAttemptedKey === artifactKey) {
        scope.store.registerPageHandle({
          ...current,
          artifactRefreshAttemptedKey: "",
          artifactRefreshRetryKey: artifactKey,
          artifactRefreshRetryAfter: scope.now() + runtime.KAKAO_CLEANED_ARTIFACT_RETRY_COOLDOWN_MS
        });
      }
    };
    try {
      const response = await scope.requestOcrForPayload(handle.payload, runtime.buildOcrMeta("page", [handle], "", {
        requireCleanedImage: true,
        forceCleanedImageArtifact: true,
        cleanedMasks: masks
      }));
      const cleanedImage = response && response.ok && response.result &&
        (response.result.cleanedImage || response.result.cleaned_image);
      const current = scope.store.getPageHandle(key);
      if (!current || current.imageRevision !== handle.imageRevision) return null;
      if (!runtime.isDataUrlValue(cleanedImage)) {
        releaseAttempt();
        scope.trace("render-mask-demand-empty", handle.target || null, {
          pageId: key,
          masks: masks.length
        });
        return null;
      }
      scope.store.registerPageHandle({
        ...current,
        cleanedImage,
        cleanedImageRevision: current.imageRevision,
        cleanedImageArtifactKey: artifactKey,
        artifactRefreshAttemptedKey: "",
        artifactRefreshRetryKey: "",
        artifactRefreshRetryAfter: 0,
        artifactRefreshRetryTimer: null,
        artifactRefreshFailureKey: "",
        artifactRefreshFailureCount: 0
      });
      // 先当场绑到 DOM 上，再补一次定向刷新（刷新可能被外层 pass 合并掉）。
      scope.applyCleanedImageToPageOverlays?.(key, cleanedImage);
      refreshAfterCleanedImage(key);
    } catch (error) {
      releaseAttempt();
      scope.trace("render-mask-demand-error", handle.target || null, {
        pageId: key,
        error: runtime.getErrorMessage(error)
      });
    } finally {
      maskDemandInflight.delete(inflightKey);
    }
    return null;
  }
  scope.requestMissingPageMask = requestMissingPageMask;
  async function refreshRequiredCleanedArtifacts(projectionsByPage, seamSurfaceIndex = null) {
    const tasks = [];
    // 逐页记录判定结果：复杂背景旁白拿不到 inpainted 遮罩时，页面上的
    // data-mt-mask-report 直接告诉你卡在哪一步（无投影/无 payload/在途/退避/已请求）。
    const report = [];
    const shortId = id => String(id || "").replace(/^page-/, "").slice(0, 8);
    const note = (pageId, reason, extra = null) => {
      if (report.length >= 24) return; // 整章上百片，属性要保持短小可读
      report.push(extra ? { p: shortId(pageId), r: reason, ...extra } : { p: shortId(pageId), r: reason });
    };
    const artifactPlan = runtime.buildCleanedArtifactProjectionPlan(projectionsByPage, seamSurfaceIndex);
    for (const [pageId, projections] of artifactPlan.entries()) {
      if (!runtime.projectionsRequireCleanedImage(projections)) {
        note(pageId, "no-complex-projection");
        continue;
      }
      const handle = scope.store.getPageHandle(pageId);
      if (!handle) {
        note(pageId, "no-handle");
        continue;
      }
      if (!handle.payload) {
        note(pageId, "no-payload");
        continue;
      }
      const cleanedMasks = runtime.buildCanonicalCleanMasks(projections);
      const artifactKey = runtime.buildCleanedArtifactKey(handle.imageRevision, cleanedMasks);
      if (handle.cleanedImageArtifactKey === artifactKey && runtime.isDataUrlValue(handle.cleanedImage)) {
        note(pageId, "cached", { masks: cleanedMasks.length });
        // 有图不代表已经画上：这一页可能是在图落地之前渲染的。先当场绑到 DOM 上，
        // 再补一次定向刷新（每个 artifactKey 只补一次）。
        scope.applyCleanedImageToPageOverlays?.(pageId, handle.cleanedImage);
        refreshOnceForCleanedImage(pageId, artifactKey);
        continue;
      }
      const inflightKey = `canonical-cleaned-artifact:${pageId}:${artifactKey}`;
      if (handle.artifactRefreshAttemptedKey === artifactKey) {
        const inflight = typeof scope.store.getInflightJob === "function" ? scope.store.getInflightJob(inflightKey) : null;
        // 已经有人在请求：不重复请求，但等它落地后补一次刷新（见 refreshAfterCleanedImage）。
        if (inflight) {
          note(pageId, "inflight", { masks: cleanedMasks.length });
          refreshAfterCleanedImage(pageId, watchInflightArtifact(pageId, artifactKey, inflight));
          continue;
        }
        // 标记还在、却既没有在途请求、也没有清理图、也过了退避期 —— 上一次尝试夭折
        // 没释放标记。不自愈就会永久跳过：复杂背景的旁白永远拿不到 inpainted 遮罩。
        if (runtime.isDataUrlValue(handle.cleanedImage) ||
            Number(handle.artifactRefreshRetryAfter || 0) > scope.now()) {
          note(pageId, "attempt-marker", { masks: cleanedMasks.length });
          continue;
        }
      }
      if (handle.artifactRefreshRetryKey === artifactKey && Number(handle.artifactRefreshRetryAfter || 0) > scope.now()) {
        note(pageId, "cooldown", { masks: cleanedMasks.length });
        continue;
      }
      note(pageId, "request", { masks: cleanedMasks.length });
      if (handle.artifactRefreshRetryTimer && typeof scope.clearTimer === "function") {
        scope.clearTimer(handle.artifactRefreshRetryTimer);
      }
      scope.store.registerPageHandle({
        ...handle,
        artifactRefreshAttemptedRevision: handle.imageRevision,
        artifactRefreshAttemptedKey: artifactKey,
        artifactRefreshRetryKey: "",
        artifactRefreshRetryAfter: 0,
        artifactRefreshRetryTimer: null
      });
      const releaseArtifactAttempt = () => {
        const current = scope.store.getPageHandle(handle.pageId);
        if (current && current.imageRevision === handle.imageRevision && current.artifactRefreshAttemptedKey === artifactKey) {
          const failureCount = current.artifactRefreshFailureKey === artifactKey ? Number(current.artifactRefreshFailureCount || 0) + 1 : 1;
          const shouldSchedule = failureCount <= runtime.KAKAO_CLEANED_ARTIFACT_AUTO_RETRY_LIMIT && typeof scope.setTimer === "function";
          let retryTimer = null;
          if (shouldSchedule) {
            retryTimer = scope.setTimer(() => {
              const latest = scope.store.getPageHandle(handle.pageId);
              if (!latest || latest.imageRevision !== handle.imageRevision || latest.artifactRefreshRetryKey !== artifactKey || latest.artifactRefreshRetryTimer !== retryTimer) return;
              scope.store.registerPageHandle({
                ...latest,
                artifactRefreshRetryAfter: 0,
                artifactRefreshRetryTimer: null
              });
              if (!scope.isPageAvailable(handle.pageId)) return;
              void scope.refreshCanonicalState({
                reason: "cleaned-artifact-retry",
                focusPageIds: [handle.pageId]
              }).catch(error => {
                scope.trace("cleaned-artifact-retry-error", handle.target, {
                  pageId: handle.pageId,
                  error: runtime.getErrorMessage(error)
                });
              });
            }, runtime.KAKAO_CLEANED_ARTIFACT_RETRY_COOLDOWN_MS);
          }
          scope.store.registerPageHandle({
            ...current,
            artifactRefreshAttemptedKey: "",
            artifactRefreshRetryKey: artifactKey,
            artifactRefreshRetryAfter: scope.now() + runtime.KAKAO_CLEANED_ARTIFACT_RETRY_COOLDOWN_MS,
            artifactRefreshRetryTimer: retryTimer,
            artifactRefreshFailureKey: artifactKey,
            artifactRefreshFailureCount: failureCount
          });
        }
      };
      const isRetryAttempt = Number(handle.artifactRefreshFailureCount || 0) > 0 ||
        handle.artifactRefreshRetryKey === artifactKey ||
        // 走到自愈分支时标记本来就在：这一版早就渲染过（而且是没有清理图的那一版）。
        handle.artifactRefreshAttemptedKey === artifactKey;
      tasks.push(scope.store.getOrCreateInflightJob(inflightKey, async () => {
        try {
          const response = await scope.requestOcrForPayload(handle.payload, runtime.buildOcrMeta("page", [handle], "", {
            requireCleanedImage: true,
            forceCleanedImageArtifact: true,
            cleanedMasks
          }));
          if (!response || !response.ok) {
            scope.trace("cleaned-artifact-error", handle.target, {
              pageId: handle.pageId,
              error: response && response.error || "artifact refresh failed"
            });
            releaseArtifactAttempt();
            return;
          }
          const cleanedImage = response.result && (response.result.cleanedImage || response.result.cleaned_image);
          if (!runtime.isDataUrlValue(cleanedImage)) {
            scope.trace("cleaned-artifact-error", handle.target, {
              pageId: handle.pageId,
              error: "artifact refresh returned no cleaned image"
            });
            releaseArtifactAttempt();
            return;
          }
          const current = scope.store.getPageHandle(handle.pageId);
          if (!current || current.imageRevision !== handle.imageRevision || current.artifactRefreshAttemptedKey !== artifactKey) return;
          scope.store.registerPageHandle({
            ...current,
            cleanedImage,
            cleanedImageRevision: current.imageRevision,
            cleanedImageArtifactKey: artifactKey,
            artifactRefreshRetryKey: "",
            artifactRefreshRetryAfter: 0,
            artifactRefreshRetryTimer: null,
            artifactRefreshFailureKey: "",
            artifactRefreshFailureCount: 0,
            ocrDebug: response.result && response.result.debug || current.ocrDebug || null
          });
          // 图落地这一刻就把遮罩绑上去：这一版投影多半已经渲染过了（而且是没有
          // 清理图的那一版），等一次未必会发生的重渲染就等于永远不补。
          scope.applyCleanedImageToPageOverlays?.(handle.pageId, cleanedImage);
          // 清理图是"补办"回来的（重试成功 / 上次夭折后自愈）时这一版投影早就渲染过：
          // 必须补一次刷新，否则覆盖层一直停在"没有清理图"的版本上。
          if (isRetryAttempt) refreshAfterCleanedImage(handle.pageId);
        } catch (error) {
          scope.trace("cleaned-artifact-error", handle.target, {
            pageId: handle.pageId,
            error: runtime.getErrorMessage(error)
          });
          releaseArtifactAttempt();
        }
      }));
    }
    tasks.push(...runtime.buildSeamCleanedArtifactPlan(seamSurfaceIndex).map(plan =>
      refreshSeamCleanedArtifact(plan)));
    await Promise.all(tasks);
    scope.store.setCleanedArtifactReport?.(report);
  }
  scope.refreshRequiredCleanedArtifacts = refreshRequiredCleanedArtifacts;

  async function refreshSeamCleanedArtifact(plan) {
    const state = scope.store.getSeamState(plan.pairKey);
    if (!state || state.status !== "completed" || !runtime.isDataUrlValue(state.cleanedImage)) return;
    const records = plan.pageIds.map(pageId => scope.store.getPageHandle(pageId));
    if (records.some(record => !record)) return;
    const artifactKey = runtime.buildCleanedArtifactKey(plan.revisionKey, plan.cleanedMasks);
    if (state.cleanedImageArtifactKey === artifactKey) return;
    if (state.cleanedImageArtifactAttemptedKey === artifactKey) return;
    if (state.cleanedImageArtifactRetryKey === artifactKey &&
        Number(state.cleanedImageArtifactRetryAfter || 0) > scope.now()) return;
    scope.store.markSeamState(plan.pairKey, {
      ...state,
      cleanedImageArtifactAttemptedKey: artifactKey,
      cleanedImageArtifactRetryKey: "",
      cleanedImageArtifactRetryAfter: 0
    });
    const sourcePayload = runtime.buildSeamCleanedArtifactPayload(state);
    try {
      const response = await scope.store.getOrCreateInflightJob(
        `canonical-seam-cleaned-artifact:${plan.pairKey}:${artifactKey}`,
        () => scope.requestOcrForPayload(sourcePayload, runtime.buildOcrMeta("seam", records,
          plan.pairKey, {
            requireCleanedImage: true,
            forceCleanedImageArtifact: true,
            cleanedMasks: plan.cleanedMasks
          }))
      );
      const cleanedImage = response && response.ok && response.result &&
        (response.result.cleanedImage || response.result.cleaned_image);
      const current = scope.store.getSeamState(plan.pairKey);
      if (!current || current.cleanedImageArtifactAttemptedKey !== artifactKey) return;
      if (!runtime.isDataUrlValue(cleanedImage)) {
        releaseSeamArtifactAttempt(current, artifactKey);
        return;
      }
      scope.store.markSeamState(plan.pairKey, {
        ...current,
        cleanedImage,
        cleanedImageToken: String(response.result.cleanedImageToken ||
          response.result.cleaned_image_token || artifactKey),
        cleanedImageArtifactKey: artifactKey,
        cleanedImageArtifactAttemptedKey: "",
        cleanedImageArtifactRetryKey: "",
        cleanedImageArtifactRetryAfter: 0
      });
    } catch (error) {
      const current = scope.store.getSeamState(plan.pairKey);
      if (current && current.cleanedImageArtifactAttemptedKey === artifactKey) {
        releaseSeamArtifactAttempt(current, artifactKey);
      }
      scope.trace("seam-cleaned-artifact-error", records[0]?.target || null, {
        pairKey: plan.pairKey,
        error: runtime.getErrorMessage(error)
      });
    }
  }

  function releaseSeamArtifactAttempt(state, artifactKey) {
    scope.store.markSeamState(state.pairKey, {
      ...state,
      cleanedImageArtifactAttemptedKey: "",
      cleanedImageArtifactRetryKey: artifactKey,
      cleanedImageArtifactRetryAfter: scope.now() +
        runtime.KAKAO_CLEANED_ARTIFACT_RETRY_COOLDOWN_MS
    });
  }
}
