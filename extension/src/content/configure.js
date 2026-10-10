import {
  CONFIG_KEYS, normalizeOcrConfig, normalizeRuntimeConfig, normalizeTranslationConfig
} from "../config/schema.js";
import languages from "../shared/languages.js";
import { detectReaderProfile } from "../readers/profile.js";
import { isCoverProjection } from "../shared/projection-role.js";
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

/**
 * 把最近一次清理图判定结果写到 <html data-mt-mask-report>。
 *
 * 复杂背景（旁白/嵌字）的遮罩只有一个来源：inpainted 清理图。它拿不到时页面是透明的，
 * 光看 DOM 分不出"卡在哪一步"——这里把逐页原因（no-complex-projection / no-payload /
 * inflight / cooldown / request / cached，以及算出来的掩膜数）留在 DOM 上，
 * 主世界控制台和隔离世界都能读。
 */
function publishMaskReport(runtime) {
  try {
    const store = runtime.state && runtime.state.kakaoStore;
    const report = store && typeof store.getCleanedArtifactReport === "function"
      ? store.getCleanedArtifactReport() : [];
    const root = globalThis.document && globalThis.document.documentElement;
    if (root && root.dataset) root.dataset.mtMaskReport = JSON.stringify(report);
  } catch {
    // 诊断属性只是便利设施，失败不影响渲染
  }
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
      // 遮罩判据只有一份定义（shared/projection-role.js）：以前这里与 scene-canonical
      // 各写一遍，两处一旦分叉，同一块内容会既被当遮罩又被选去做文字渲染。
      if (isCoverProjection(projection)) return projection.active !== false;
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
  // 分片长条阅读器能力（KakaoPage / RIDI）：必须在 state 阶段安装 reader-state 之前定好，
  // 那里的并发槽位常量在安装期就据此取值。
  runtime.IS_STRIP_TILE_READER = runtime.readerProfile.tiledStrip === true;
  // 分片长条（canonical）链路的**唯一**判定：只看目标本身能不能翻译
  // （`<img>` / `<canvas>` / 背景图容器，且不是扩展自己画的覆盖层，见 isSupportedTarget）。
  //
  // 这里曾经存在第二份"严格版"实现（另外要求 IS_STRIP_TILE_READER + 直接采集 +
  // 覆盖层渲染），装在 recognition-payload 的 functions 阶段，必然被这一份覆盖，
  // 已删除。现行行为**不**按采集/渲染模式收窄；若要恢复那三道闸门，属于有意的行为变更。
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
    publishMaskReport(runtime);
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
    runtime.state.pretranslateAheadCount = config.pretranslateAheadCount;
    // 手动模式只接受点击翻译；即使此前页面处于自动翻译状态，加载后也不恢复。
    if (config.pretranslateMode === "manual") {
      runtime.state.autoTranslatePageEnabled = false;
    }
    runtime.state.floatingSide = config.floatingSide;
    runtime.state.floatingYRatio = config.floatingYRatio;
    runtime.state.novelStreamBatchSize = config.novelStreamBatchSize;
    runtime.state.novelStreamConcurrency = config.novelStreamConcurrency;
    runtime.state.novelChunkChars = config.novelChunkChars;
    runtime.state.novelRepairConcurrency = config.novelRepairConcurrency;
    runtime.state.webpageBatchItems = config.webpageBatchItems;
    runtime.state.webpageBatchChars = config.webpageBatchChars;
    runtime.state.webpageConcurrency = config.webpageConcurrency;
    // 触边 canonical 的等待策略（默认等邻页 seam 合并后再翻译）。
    runtime.edgeTranslateWithoutWaiting = config.edgeTranslateWithoutWaiting === true;
    // 漫画流式渲染（默认关闭：整批返回后一次上屏）。
    runtime.comicStreamingEnabled = config.comicStreamingEnabled === true;
    runtime.state.displayMode = config.displayMode;
    runtime.state.webpageDisplayMode = config.displayMode;
    runtime.state.novelDisplayMode = config.displayMode;
    runtime.state.translationMode = config.translationMode;
    runtime.state.coverPadding = config.overwriteCoverPadding;
    runtime.state.sourceLanguage = translation.sourceLanguage;
    runtime.state.targetLanguage = translation.targetLanguage;
    runtime.state.ocrLanguage = languages.translationLanguageToOcrLanguage(translation.sourceLanguage);
    runtime.ENABLE_PIPELINE_TRACE = ocr.localPaddle.debug === true;
    return { ...config, translation };
  };
  runtime.getConfiguredSourceLanguage = () => runtime.state.sourceLanguage || "auto";
  runtime.getTargetLanguage = () => runtime.state.targetLanguage || "zh-CN";
  // 翻译模式的唯一判据：本页的临时选择优先于全局默认。请求侧（recognition-seam /
  // recognition-stitch）与渲染侧（scene-dispatch 强制 overlay）都只读这两个函数，
  // 不要各自去读 state.translationMode。
  runtime.getEffectiveTranslationMode = () => runtime.state.translationModeOverride
    || runtime.state.translationMode || "provider";
  runtime.isOcrOnlyTranslation = () => runtime.getEffectiveTranslationMode() === "ocrOnly";
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
    const translationModeChanged = config.translationMode !== runtime.state.translationMode;
    // 在设置页改全局翻译模式是一次显式意图：本页的临时选择让位给新默认值。
    if (translationModeChanged) runtime.state.translationModeOverride = null;
    Object.assign(runtime.state, { enabled: config.enabled, showFloatingBall: config.showBall,
      captureMode: config.captureMode, renderMode: config.renderMode,
      pretranslateMode: config.pretranslateMode, floatingSide: config.floatingSide,
      floatingYRatio: config.floatingYRatio, displayMode: config.displayMode,
      coverPadding: config.overwriteCoverPadding,
      novelStreamBatchSize: config.novelStreamBatchSize,
      novelStreamConcurrency: config.novelStreamConcurrency,
      novelChunkChars: config.novelChunkChars,
      novelRepairConcurrency: config.novelRepairConcurrency,
      webpageBatchItems: config.webpageBatchItems,
      webpageBatchChars: config.webpageBatchChars,
      webpageConcurrency: config.webpageConcurrency,
      webpageDisplayMode: config.displayMode, novelDisplayMode: config.displayMode,
      translationMode: config.translationMode });
    // 切换到手动翻译时停止一切自动预翻译：关闭本页自动翻译、清空自动入队任务。
    // 自动模式间的切换（领先/连续）保留用户的悬浮球自动翻译状态。
    if (config.pretranslateMode === "manual") {
      runtime.state.autoTranslatePageEnabled = false;
      runtime.clearAutoTranslateRetryTimers?.();
      runtime.dropAutoQueuedItems?.();
    }
    runtime.updateFloatingBallState?.();
    runtime.refreshWebpageDisplayMode?.();
    runtime.setNovelTranslationVisibility?.(runtime.getNovelState?.().showTranslation !== false);
    if (captureChanged) runtime.state.payloadCacheByTargetKey.clear();
    if (captureChanged || renderChanged || displayChanged) runtime.clearAllRenderedTargets();
    // 翻译模式变了：已经 settle 的译文（可能是直通值）必须丢掉，否则切回翻译会一直复用直通值。
    if (translationModeChanged) runtime.invalidateComicTranslations?.();
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
  runtime.api.__test.createBubbleNode = runtime.createBubbleNode;
  runtime.api.__test.createBubbleCoverClipNode = runtime.createBubbleCoverClipNode;
  runtime.api.__test.buildBubbleCoverProjection = runtime.buildBubbleCoverProjection;
  runtime.api.__test.resolveBubbleCoverGeometry = runtime.resolveBubbleCoverGeometry;
  runtime.api.__test.prepareBubbleMeasureProbe = runtime.prepareBubbleMeasureProbe;
}
