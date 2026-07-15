import { installMessages } from "./messages.js";
import { installTermDiscovery } from "./term-discovery.js";
import { installOcrPipeline } from "./ocr-pipeline.js";
import { installOcrDispatch } from "./ocr-dispatch.js";
import { installObservationResults } from "./observation-results.js";
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
import { installTranslationProvider } from "./translation-provider.js";
import { installTranslationHelpers } from "./translation-helpers.js";
import { installTranslationCoalesce } from "./translation-coalesce.js";
import { installTranslationUtils } from "./translation-utils.js";
import { installPlatformCache } from "./platform-cache.js";
import { installPlatformSettings } from "./platform-settings.js";
import { installPlatformStorage } from "./platform-storage.js";
import { installBackgroundState } from "./background-state.js";
import { installBootstrap } from "./bootstrap.js";

export const backgroundInstallers = Object.freeze([
  installMessages,
  installTermDiscovery,
  installOcrPipeline,
  installOcrDispatch,
  installObservationResults,
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
  installTranslationProvider,
  installTranslationHelpers,
  installTranslationCoalesce,
  installTranslationUtils,
  installPlatformCache,
  installPlatformSettings,
  installPlatformStorage,
  installBackgroundState,
  installBootstrap
]);

export const backgroundPhases = Object.freeze({
  functions: Object.freeze([
    installMessages,
    installTermDiscovery,
    installOcrPipeline,
    installOcrDispatch,
    installObservationResults,
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
    installTranslationProvider,
    installTranslationHelpers,
    installTranslationCoalesce,
    installTranslationUtils,
    installPlatformCache,
    installPlatformSettings,
    installPlatformStorage
  ]),
  state: Object.freeze([installBackgroundState]),
  startup: Object.freeze([installBootstrap])
});
