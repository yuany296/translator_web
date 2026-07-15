export function installContent05(runtime) {
  async function runKakaoCanonicalTarget(target, options, cached = false) {
    try {
      let result = cached ? await runtime.kakaoCanonicalPipeline.runCached(target, null, options) : await runtime.kakaoCanonicalPipeline.run(target, options);
      if (result && result.fallbackLegacy === true && runtime.kakaoLegacyPipeline) {
        runtime.tracePipeline("canonical-legacy-fallback", target, {
          reason: result.reason || "non-authoritative-page-payload",
          source: String(result.payload && result.payload.source || "")
        });
        const targetKey = runtime.computeTargetKey(target);
        const scopedTargetKey = runtime.buildTargetSourceCacheKey(targetKey, runtime.getQuickSourceToken(target));
        // Canonical FETCH 已缓存了未经旧截图归一化的 payload；委托旧链路前移除它，
        // 让截图/裁剪模式完整走原有提取与坐标适配流程。
        runtime.state.payloadCacheByTargetKey.delete(scopedTargetKey);
        runtime.state.payloadCacheByTargetKey.delete(runtime.buildKakaoCanonicalPayloadCacheKey(scopedTargetKey, target));
        result = await runtime.kakaoLegacyPipeline.run(target, {
          ...options,
          reason: options && options.reason ? `${options.reason}:canonical-payload-fallback` : "canonical-payload-fallback"
        });
      }
      if (result && result.ok) {
        await runtime.reportStatus("info", "translation done", {
          reason: options && options.reason,
          pageId: result.pageId || "",
          bubbles: Number(result.bubbles || 0),
          cached: result.cached === true || result.reused === true,
          pipeline: "kakao-canonical-v1"
        });
      }
      return result;
    } finally {
      // 无论成功、跳过还是失败，只清理当前目标的 loading；正式气泡不受影响。
      runtime.clearKakaoLoadingOverlay(target);
    }
  }
  runtime.runKakaoCanonicalTarget = runKakaoCanonicalTarget;
  async function translateTarget(target, options) {
    if (runtime.state.invalidated) {
      throw new Error("Extension context invalidated");
    }
    if (!runtime.isSupportedTarget(target) || !target.isConnected) {
      return {
        ok: false,
        skipped: true,
        reason: "target disconnected"
      };
    }
    if (!options.manual && !runtime.state.enabled) {
      return {
        ok: false,
        skipped: true,
        reason: "plugin disabled"
      };
    }
    if (!runtime.passesTargetFilter(target, options.manual, {
      relaxed: options.relaxed === true,
      allowOffscreen: options.allowOffscreen === true
    })) {
      // KakaoPage 自动翻译模式下安排重试：短页被 release 后可能已部分滚出视口，
      // 或因图片未完成加载等原因暂时不通过 filter——重试机制确保不会永久丢失。
      if (runtime.IS_KAKAOPAGE_READER && runtime.state.autoTranslatePageEnabled && options.manual) {
        runtime.scheduleAutoTranslateRetry(target);
      }
      return {
        ok: false,
        skipped: true,
        reason: "filtered as non-manga target"
      };
    }
    if (runtime.state.inflightByTarget.has(target)) {
      const inflightToken = target.dataset.inflightSourceToken;
      const currentToken = runtime.getTargetExecutionToken(target);
      if (inflightToken === currentToken) {
        runtime.tracePipeline("inflight-bypass", target, {
          skipReason: "sameSourceToken"
        });
        return runtime.state.inflightByTarget.get(target);
      }
      // sourceToken 不匹配：DOM 被复用了，清除旧 inflight 状态
      runtime.state.inflightByTarget.delete(target);
      delete target.dataset.inflightSourceToken;
      runtime.tracePipeline("inflight-bypass", target, {
        skipReason: "sourceTokenChanged"
      });
    }
    const executionToken = runtime.getTargetExecutionToken(target);
    const task = (async () => {
      let payload = null;
      let renderPayload = null;
      try {
        const targetKey = runtime.computeTargetKey(target);
        const targetId = runtime.getTargetId(target);
        const sourceToken = runtime.getQuickSourceToken(target);
        const scopedTargetKey = runtime.buildTargetSourceCacheKey(targetKey, sourceToken);
        if (runtime.isScreenshotCaptureMode() && !runtime.getVisibleViewportRect(target)) {
          return {
            ok: false,
            skipped: true,
            reason: runtime.SCREENSHOT_TARGET_NOT_VISIBLE
          };
        }
        const existingRendered = runtime.getExistingRenderedState(targetId);
        if (!options.force && existingRendered && existingRendered.targetKey === targetKey) {
          if (runtime.isBackgroundImageTarget(target) && existingRendered.mode === "embedded") {
            runtime.restoreEmbeddedForTarget(target);
          } else if (existingRendered.mode === "embedded" && !runtime.isEmbeddedRenderStillApplied(existingRendered)) {
            runtime.state.embeddedById.delete(targetId);
          } else if (runtime.isReusableRenderedState(existingRendered, runtime.hasSettledTranslatedMarker(target, targetKey, scopedTargetKey))) {
            runtime.syncOverlayPosition(existingRendered);
            return {
              ok: true,
              reused: true,
              bubbles: existingRendered.bubbleCount
            };
          }
        }
        const refreshedRendered = runtime.getExistingRenderedState(targetId);
        if (!options.force && refreshedRendered && refreshedRendered.targetKey === targetKey) {
          if (runtime.isBackgroundImageTarget(target) && refreshedRendered.mode === "embedded") {
            runtime.restoreEmbeddedForTarget(target);
          } else if (runtime.isReusableRenderedState(refreshedRendered, runtime.hasSettledTranslatedMarker(target, targetKey, scopedTargetKey))) {
            runtime.syncOverlayPosition(refreshedRendered);
            return {
              ok: true,
              reused: true,
              bubbles: refreshedRendered.bubbleCount
            };
          }
        }
        if (!options.force && runtime.hasReusableKakaoPageOcr(target)) {
          // OCR 已经按 pageId + imageRevision 成为 Store 中的权威事实；恢复时只重试
          // canonical 翻译/投影，不能因为没有本地 bubble cache 就重新跑整页 OCR。
          return await runtime.runKakaoCanonicalTarget(target, options, true);
        }
        const localCachedResult = runtime.state.localResultCache.get(scopedTargetKey);
        if (!options.force && localCachedResult) {
          if (runtime.shouldUseKakaoCanonicalPipeline(target) && runtime.kakaoCanonicalPipeline) {
            return await runtime.runKakaoCanonicalTarget(target, options, true);
          }
          if (runtime.IS_KAKAOPAGE_READER && runtime.kakaoLegacyPipeline) {
            return await runtime.kakaoLegacyPipeline.runCached(target, localCachedResult, options);
          }
          const dedupedCachedResult = await runtime.dedupeKakaoResultByPageCoordinates(localCachedResult, target, targetKey);
          runtime.state.localResultCache.set(scopedTargetKey, dedupedCachedResult);
          if (dedupedCachedResult.bubbles.length > 0) {
            if (runtime.shouldUseEmbeddedRender(target)) {
              runtime.renderLoadingOverlay(target, targetKey, "生成嵌入图片中...");
            }
            const cachedPayload = runtime.shouldUseEmbeddedRender(target) ? await runtime.extractTargetPayload(target, scopedTargetKey) : null;
            await runtime.renderTranslationResult(target, targetKey, dedupedCachedResult, cachedPayload);
          } else {
            runtime.clearRenderedTarget(target);
          }
          return {
            ok: true,
            reused: true,
            bubbles: dedupedCachedResult.bubbles.length
          };
        }
        if (runtime.shouldUseKakaoCanonicalPipeline(target) && runtime.kakaoCanonicalPipeline) {
          return await runtime.runKakaoCanonicalTarget(target, options, false);
        }
        if (runtime.IS_KAKAOPAGE_READER && runtime.kakaoLegacyPipeline) {
          return await runtime.kakaoLegacyPipeline.run(target, options);
        }

        // Stale result defense: capture snapshot before translation
        const preTranslateSnapshot = runtime.captureTargetSnapshot(target);
        runtime.renderLoadingOverlay(target, targetKey, "OCR + 翻译中...");
        payload = await runtime.extractTargetPayload(target, scopedTargetKey);
        runtime.updateLoadingOverlayText(target, targetKey, "模型翻译中...");
        renderPayload = payload;
        const response = await runtime.requestTranslationForPayload(payload, runtime.buildOcrRequestKey(targetKey, payload));
        if (!response || !response.ok) {
          throw new Error(response && response.error ? response.error : "Translate request failed");
        }
        const result = runtime.normalizeResult(response.result);
        // Stale result defense: check if target changed during OCR
        if (preTranslateSnapshot && !runtime.isTargetSnapshotStillValid(target, preTranslateSnapshot)) {
          console.warn("[MangaTranslator] Stale result dropped: target changed during OCR, skipping clearRenderedTarget");
          return {
            ok: false,
            skipped: true,
            reason: "target changed during OCR (stale result)"
          };
        }
        const expectedSourceImageId = String(renderPayload && renderPayload.sourceImageId || payload && payload.sourceImageId || "");
        if (!target.isConnected || expectedSourceImageId && runtime.getSourceImageIdForTarget(target) !== expectedSourceImageId) {
          runtime.clearRenderedTarget(target);
          return {
            ok: false,
            skipped: true,
            reason: "source image changed during OCR"
          };
        }
        runtime.releaseUncoveredKakaoShortPages(payload, result, target, "ownerSucceededWithoutShortPageBubble");
        runtime.rememberLocalResult(scopedTargetKey, result);
        console.debug("[MangaTranslator] Received", result.bubbles.length, "bubbles, translated:", result.bubbles.filter(b => b.translated_text && b.translated_text !== b.original_text).length, "of", result.bubbles.length);
        if (result.bubbles.length > 0) {
          runtime.updateLoadingOverlayText(target, targetKey, runtime.shouldUseEmbeddedRender(target) ? "生成嵌入图片中..." : "排版中...");
          await runtime.renderTranslationResult(target, targetKey, result, renderPayload, {
            stream: true
          });
          target.dataset.mtNoTextKey = "";
        } else {
          console.warn("[MangaTranslator] OCR returned no text for target", {
            targetTag: target.tagName.toLowerCase(),
            targetKey: targetKey.slice(0, 80),
            responseOk: response && response.ok,
            resultBubbles: response && response.result && response.result.bubbles ? response.result.bubbles.length : 0,
            resultCleaned: response && response.result && typeof response.result.cleanedImage === "string" ? response.result.cleanedImage.slice(0, 40) + "..." : "none",
            resultKeys: response && response.result ? Object.keys(response.result) : null,
            error: response && response.error || null
          });
          runtime.updateLoadingOverlayText(target, targetKey, "未识别到文本");
          await runtime.sleep(1500);
          runtime.clearRenderedTarget(target);
          target.dataset.mtNoTextKey = targetKey;
        }
        target.dataset.mtLastTranslatedKey = targetKey;
        await runtime.reportStatus("info", "translation done", {
          reason: options.reason,
          bubbles: result.bubbles.length,
          cached: !!response.cached
        });
        return {
          ok: true,
          bubbles: result.bubbles.length,
          cached: !!response.cached
        };
      } catch (error) {
        const reason = runtime.getErrorMessage(error);

        // Owner 翻译失败 → 释放附属短页，允许它们独立翻译
        let attachedShortPageKeys = null;
        if (payload && Array.isArray(payload.attachedShortPageKeys) && payload.attachedShortPageKeys.length > 0) {
          attachedShortPageKeys = payload.attachedShortPageKeys;
        } else if (renderPayload && Array.isArray(renderPayload.attachedShortPageKeys) && renderPayload.attachedShortPageKeys.length > 0) {
          attachedShortPageKeys = renderPayload.attachedShortPageKeys;
        }
        if (attachedShortPageKeys) {
          for (const shortKey of attachedShortPageKeys) {
            const el = runtime.findTargetByScopedKey(shortKey);
            if (el) {
              runtime.state.kakaoStore.releaseShortPage(el, runtime.buildTargetSourceCacheKey(runtime.computeTargetKey(target), runtime.getQuickSourceToken(target)));
              runtime.tracePipeline("skipped", el, {
                skipReason: "ownerFailedReleasingShortPage"
              });
            }
          }
        }
        if (runtime.shouldUseKakaoCanonicalPipeline(target)) {
          // Canonical 管线会保留并标记上一版 provisional projection。
          // 冷缓存重试失败时只清 loading，不能把仍有效的回退译文一起删掉。
          runtime.clearKakaoLoadingOverlay(target);
        } else {
          runtime.clearRenderedTarget(target);
        }
        if (runtime.isScreenshotTargetNotVisibleError(reason)) {
          if (runtime.IS_KAKAOPAGE_READER && runtime.state.autoTranslatePageEnabled) {
            runtime.scheduleAutoTranslateRetry(target);
          }
          return {
            ok: false,
            skipped: true,
            reason
          };
        }
        if (!runtime.CONTEXT_INVALIDATED_RE.test(reason)) {
          await runtime.reportStatus("error", reason, {
            reason: options.reason,
            targetTag: target.tagName.toLowerCase()
          });
        }
        if (runtime.shouldUseKakaoCanonicalPipeline(target) && runtime.state.autoTranslatePageEnabled && target.isConnected) {
          // 冷请求超时或临时网络故障后释放并发槽，但给下一次恢复留出退避窗口，
          // 避免 1.2 秒恢复扫描立即反复轰击翻译接口。
          target.dataset.mtRecoveryReqAt = String(Date.now());
        }
        return {
          ok: false,
          error: reason
        };
      } finally {
        // Owner 翻译结束，检查是否有短页在 inflight 期间被附着到此 owner。
        // 如果有，这些短页的附着标记指向一个不会再被重翻译的 owner 结果，
        // 需要立即释放让它们独立翻译。
        if (runtime.IS_KAKAOPAGE_READER && runtime.state.autoTranslatePageEnabled && !runtime.shouldUseKakaoCanonicalPipeline(target)) {
          runtime.releaseShortPagesAttachedDuringInflight(target);
        }
      }
    })();
    target.dataset.inflightSourceToken = executionToken;
    runtime.state.inflightByTarget.set(target, task);
    void task.finally(() => {
      if (runtime.state.inflightByTarget.get(target) === task) {
        runtime.state.inflightByTarget.delete(target);
      }
      if (target.dataset.inflightSourceToken === executionToken) {
        delete target.dataset.inflightSourceToken;
      }
    });
    return task;
  }
  runtime.translateTarget = translateTarget;
  async function preloadTargetPayload(target) {
    if (runtime.state.invalidated || !runtime.state.enabled) {
      return;
    }
    if (runtime.state.inflightByTarget.has(target)) {
      return;
    }
    if (!runtime.passesTargetFilter(target, false)) {
      return;
    }
    if (runtime.state.preloadInFlightByTarget.has(target)) {
      return runtime.state.preloadInFlightByTarget.get(target);
    }
    if (runtime.isScreenshotCaptureMode()) {
      return;
    }
    const task = (async () => {
      const targetKey = runtime.computeTargetKey(target);
      const scopedTargetKey = runtime.buildTargetSourceCacheKey(targetKey, runtime.getQuickSourceToken(target));
      const canonicalTarget = runtime.shouldUseKakaoCanonicalPipeline(target);
      const payloadCacheKey = canonicalTarget ? runtime.buildKakaoCanonicalPayloadCacheKey(scopedTargetKey, target) : scopedTargetKey;
      if (runtime.state.localResultCache.has(targetKey) || runtime.state.localResultCache.has(scopedTargetKey) || runtime.getPayloadCache(targetKey) || runtime.getPayloadCache(payloadCacheKey)) {
        return;
      }
      await runtime.extractTargetPayload(target, payloadCacheKey, {
        skipKakaoStitch: canonicalTarget
      });
    })().finally(() => {
      runtime.state.preloadInFlightByTarget.delete(target);
    });
    runtime.state.preloadInFlightByTarget.set(target, task);
    return task;
  }
  runtime.preloadTargetPayload = preloadTargetPayload;
}
