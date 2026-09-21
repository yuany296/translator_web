import { installMessages } from "./messages.js";
import { installTermDiscoveryMessages } from "./term-discovery-messages.js";
import { installTermDiscoveryExtract } from "./term-discovery-extract.js";
import { installTermDiscovery } from "./term-discovery.js";
import { installOcrTimings } from "./ocr-timings.js";
import { installOcrPipeline } from "./ocr-pipeline.js";
import { installOcrDispatch } from "./ocr-dispatch.js";
import { installObservationResults } from "./observation-results.js";
import { installSeamGrouping } from "./seam-grouping.js";
import { installSeamHandling } from "./seam-handling.js";
import { installCapture } from "./capture.js";
import { installOcrProvider } from "./ocr-provider.js";
import { installVisionOcr } from "./vision-ocr.js";
import { installOcrClustering } from "./ocr-clustering.js";
import { installOcrStyles } from "./ocr-styles.js";
import { installOcrLines } from "./ocr-lines.js";
import { installOcrRegions } from "./ocr-regions.js";
import { installOcrClusterGeometry } from "./ocr-cluster-geometry.js";
import { installOcrDisplayGeometry } from "./ocr-display-geometry.js";
import { installOcrItemFilter } from "./ocr-item-filter.js";
import { installOcrCandidates } from "./ocr-candidates.js";
import { installBaiduProvider } from "./baidu-provider.js";
import { installBaiduResults } from "./baidu-results.js";
import { installTranslationBlockBatch } from "./translation-block-batch.js";
import { installTranslationCacheLookup } from "./translation-cache-lookup.js";
import { installTranslationProvider } from "./translation-provider.js";
import { installTranslationProviderStream } from "./translation-provider-stream.js";
import { installTranslationHelpers } from "./translation-helpers.js";
import { installTranslationCoalesce } from "./translation-coalesce.js";
import { installTranslationUtils } from "./translation-utils.js";
import { installNovelTranslation } from "./novel-translation.js";
import { installNovelEmphasis } from "./novel-emphasis.js";
import { installTermContextExtract } from "./term-context-extract.js";
import { installTranslationCacheStore } from "./translation-cache-store.js";
import { installTranslationConfig } from "./translation-config.js";
import { installTranslationTaskCancel } from "./translation-task-cancel.js";
import { installWebpageTabController } from "./webpage-tab-controller.js";
import { installTranslationService } from "./translation-service.js";
import { installTranslationStream } from "./translation-stream.js";
import { installComicTranslationStore } from "./comic-translation-store.js";
import { installPlatformCache } from "./platform-cache.js";
import { installPlatformUtils } from "./platform-utils.js";
import { installPlatformStorage } from "./platform-storage.js";
import { installBackgroundState } from "./background-state.js";
import { installBootstrap } from "./bootstrap.js";

export const backgroundPhases = Object.freeze({
  functions: Object.freeze([
    installMessages,
    installTermDiscoveryMessages,
    installTermDiscoveryExtract,
    installTermDiscovery,
    installOcrTimings,
    installOcrPipeline,
    installOcrDispatch,
    installObservationResults,
    installSeamGrouping,
    installSeamHandling,
    installCapture,
    installOcrProvider,
    installVisionOcr,
    installOcrClustering,
    installOcrStyles,
    installOcrLines,
    installOcrRegions,
    installOcrClusterGeometry,
    installOcrDisplayGeometry,
    installOcrItemFilter,
    installOcrCandidates,
    installBaiduProvider,
    installBaiduResults,
    installTranslationBlockBatch,
    installTranslationCacheLookup,
    installTranslationProvider,
    installTranslationProviderStream,
    installTranslationHelpers,
    installTranslationCoalesce,
    installTranslationUtils,
    installNovelTranslation,
    installNovelEmphasis,
    installTermContextExtract,
    installPlatformCache,
    installTranslationCacheStore,
    installTranslationService,
    installTranslationStream,
    installComicTranslationStore,
    installTranslationConfig,
    installTranslationTaskCancel,
    installWebpageTabController,
    installPlatformUtils,
    installPlatformStorage
  ]),
  state: Object.freeze([installBackgroundState]),
  startup: Object.freeze([installBootstrap])
});

/**
 * 完整装配顺序（functions → state → startup）。
 * 由 backgroundPhases 派生，避免两份手写列表各自维护时漏装模块：
 * 曾漏掉 installOcrTimings，导致 messages.js 里的 OCR_DATA_URL 报
 * 「runtime.handleOcrDataUrlWithTimings is not a function」。
 */
export const backgroundInstallers = Object.freeze([
  ...backgroundPhases.functions,
  ...backgroundPhases.state,
  ...backgroundPhases.startup
]);
