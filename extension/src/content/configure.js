import {
  CONFIG_KEYS, normalizeOcrConfig, normalizeRuntimeConfig, normalizeTranslationConfig
} from "../config/schema.js";
import languages from "../shared/languages.js";
import { detectReaderProfile } from "../readers/profile.js";
import { applyDomTextLayer, renderDomScene } from "../rendering/dom-renderer.js";
import { renderEmbeddedScene } from "../rendering/embedded-renderer.js";
import { buildBubbleTextLayer, buildRenderSceneForBubbles } from "../rendering/scene-builder.js";

function sceneMeasure(runtime) {
  if (!runtime.sceneMeasureContext) {
    runtime.sceneMeasureContext = document.createElement("canvas").getContext("2d");
  }
  return (value, size, weight = 600) => {
    const context = runtime.sceneMeasureContext;
    if (!context) return [...String(value)].length * size;
    context.font = `${weight} ${size}px "Source Han Sans SC", "Noto Sans SC", "Microsoft YaHei", sans-serif`;
    return context.measureText(String(value)).width;
  };
}

function buildProjectionScenes(runtime, input) {
  const pages = runtime.normalizeProjectionPages(input);
  const scenes = new Map();
  for (const [pageId, projections] of pages) {
    const target = runtime.getTargetForKakaoPageId?.(pageId) || null;
    const rect = target?.getBoundingClientRect?.() || {};
    const surface = {
      id: pageId, type: "page",
      width: Math.max(1, Number(rect.width || target?.naturalWidth || 1000)),
      height: Math.max(1, Number(rect.height || target?.naturalHeight || 1000))
    };
    const bubbles = projections.filter((projection) => {
      const role = String(projection.role || "text_primary");
      const coverOnly = role === "cover" || role === "cover_only" || projection.coverOnly === true;
      if (coverOnly) return projection.active !== false;
      if (typeof projection.activeText === "boolean") return projection.activeText;
      return projection.active !== false && role !== "standby" && role !== "text_standby";
    }).map(runtime.projectionToRendererBubble);
    scenes.set(pageId, buildRenderSceneForBubbles({
      id: `page:${pageId}`, surface, bubbles, measure: sceneMeasure(runtime),
      displayMode: runtime.state.displayMode
    }));
  }
  return scenes;
}

export function prepareContentRuntime(runtime) {
  runtime.readerProfile = detectReaderProfile();
  runtime.TARGET_SELECTOR = runtime.readerProfile.targetSelector;
  runtime.RUNTIME_FEATURE_VERSION = "reader-canonical-scene-v2";
  runtime.shouldUseKakaoCanonicalPipeline = (target) => Boolean(
    target && runtime.isSupportedTarget(target)
  );
  runtime.buildRenderSceneForBubbles = (input) => buildRenderSceneForBubbles({
    ...input, measure: input.measure || sceneMeasure(runtime),
    displayMode: input.displayMode || runtime.state.displayMode
  });
  runtime.buildBubbleTextLayer = (bubble, surface) => buildBubbleTextLayer(bubble, surface, {
    measure: sceneMeasure(runtime), displayMode: runtime.state.displayMode
  });
  runtime.renderDomScene = renderDomScene;
  runtime.renderEmbeddedScene = renderEmbeddedScene;
  runtime.applyDomTextLayer = applyDomTextLayer;

  const renderCanonical = runtime.renderCanonicalProjections;
  runtime.renderCanonicalProjections = (input = {}) => {
    runtime.renderScenesByPage = buildProjectionScenes(runtime, input);
    return renderCanonical(input);
  };

  runtime.loadLocalSettings = async () => {
    const stored = await runtime.storageGet([CONFIG_KEYS.runtime, CONFIG_KEYS.ocr, CONFIG_KEYS.translation]);
    const config = normalizeRuntimeConfig(stored[CONFIG_KEYS.runtime]);
    const ocr = normalizeOcrConfig(stored[CONFIG_KEYS.ocr]);
    const translation = normalizeTranslationConfig(stored[CONFIG_KEYS.translation]);
    runtime.state.enabled = config.enabled;
    runtime.state.showFloatingBall = config.showBall;
    runtime.state.captureMode = config.captureMode;
    runtime.state.renderMode = config.renderMode;
    runtime.state.pretranslateMode = config.pretranslateMode;
    runtime.state.floatingSide = config.floatingSide;
    runtime.state.floatingYRatio = config.floatingYRatio;
    runtime.state.displayMode = config.displayMode;
    runtime.state.webpageDisplayMode = config.displayMode;
    runtime.state.novelDisplayMode = config.displayMode;
    runtime.state.sourceLanguage = translation.sourceLanguage;
    runtime.state.targetLanguage = translation.targetLanguage;
    runtime.state.ocrLanguage = languages.translationLanguageToOcrLanguage(translation.sourceLanguage);
    runtime.ENABLE_PIPELINE_TRACE = ocr.localPaddle.debug === true;
    return { ...config, translation };
  };
  runtime.getConfiguredSourceLanguage = () => runtime.state.sourceLanguage || "auto";
  runtime.getTargetLanguage = () => runtime.state.targetLanguage || "zh-CN";
  runtime.resolveSourceLanguage = (value, recognized = "") => languages.resolveSourceLanguage(
    runtime.getConfiguredSourceLanguage(), value, recognized
  );
  runtime.updateRuntimeConfiguration = async (patch) => {
    const stored = await runtime.storageGet([CONFIG_KEYS.runtime]);
    const current = normalizeRuntimeConfig(stored[CONFIG_KEYS.runtime]);
    const next = normalizeRuntimeConfig({ ...current, ...patch });
    await runtime.storageSet({ [CONFIG_KEYS.runtime]: next });
    return next;
  };
  runtime.bindStorageListener = () => chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    const runtimeChange = changes[CONFIG_KEYS.runtime];
    const ocrChange = changes[CONFIG_KEYS.ocr];
    const translationChange = changes[CONFIG_KEYS.translation];
    if (!runtimeChange && !ocrChange && !translationChange) return;
    if (ocrChange) {
      const ocr = normalizeOcrConfig(ocrChange.newValue);
      runtime.ENABLE_PIPELINE_TRACE = ocr.localPaddle.debug === true;
      if (!runtime.ENABLE_PIPELINE_TRACE) globalThis.__MT_PIPELINE_TRACE__ = [];
    }
    if (translationChange) {
      const translation = normalizeTranslationConfig(translationChange.newValue);
      const languageChanged = translation.sourceLanguage !== runtime.state.sourceLanguage
        || translation.targetLanguage !== runtime.state.targetLanguage;
      runtime.state.sourceLanguage = translation.sourceLanguage;
      runtime.state.targetLanguage = translation.targetLanguage;
      runtime.state.ocrLanguage = languages.translationLanguageToOcrLanguage(translation.sourceLanguage);
      if (languageChanged) {
        runtime.restoreWebpageTranslation?.();
        runtime.restoreAllNovelText?.();
        runtime.clearAllRenderedTargets?.();
        const novel = runtime.getNovelState?.();
        if (novel?.taskId) {
          runtime.cancelNovelTranslationStream?.(novel.taskId);
          void runtime.sendRuntimeMessage({ type: "CANCEL_TRANSLATION_TASK", taskId: novel.taskId }).catch(() => {});
          novel.taskId = "";
          novel.textStatus = "idle";
          novel.translations.clear();
        }
        const webpage = runtime.getWebpageState?.();
        if (webpage) {
          webpage.cacheCheckedKey = "";
          webpage.pageKey = runtime.normalizeTranslationCacheUrl();
        }
        void runtime.analyzeWebpageCacheStatus?.();
      }
    }
    if (!runtimeChange) {
      runtime.updateFloatingBallState?.();
      return;
    }
    const config = normalizeRuntimeConfig(runtimeChange.newValue);
    const captureChanged = config.captureMode !== runtime.state.captureMode;
    const renderChanged = config.renderMode !== runtime.state.renderMode;
    const displayChanged = config.displayMode !== runtime.state.displayMode;
    Object.assign(runtime.state, { enabled: config.enabled, showFloatingBall: config.showBall,
      captureMode: config.captureMode, renderMode: config.renderMode,
      pretranslateMode: config.pretranslateMode, floatingSide: config.floatingSide,
      floatingYRatio: config.floatingYRatio, displayMode: config.displayMode,
      webpageDisplayMode: config.displayMode, novelDisplayMode: config.displayMode });
    runtime.refreshWebpageDisplayMode?.();
    runtime.setNovelTranslationVisibility?.(runtime.getNovelState?.().showTranslation !== false);
    if (captureChanged) runtime.state.payloadCacheByTargetKey.clear();
    if (captureChanged || renderChanged || displayChanged) runtime.clearAllRenderedTargets();
    if (!config.enabled) runtime.state.autoTranslatePageEnabled = false;
    runtime.ensureExtensionUiMounted();
    if (config.enabled) {
      runtime.rescan();
      if (runtime.shouldSchedulePagePretranslation()) runtime.scheduleAheadPretranslation("setting-change");
    }
    else runtime.clearAllRenderedTargets();
  });
}

export function completeContentRuntime(runtime) {
  runtime.api.readerProfile = runtime.readerProfile;
  runtime.api.__test.shouldUseKakaoCanonicalPipeline = runtime.shouldUseKakaoCanonicalPipeline;
  runtime.api.__test.getRenderScenes = () => runtime.renderScenesByPage || new Map();
}
