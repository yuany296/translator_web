import { installReaderInit } from "./reader-init.js";
import { installReaderObservers } from "./reader-observers.js";
import { installScheduler } from "./scheduler.js";
import { installRecognitionWorkflow } from "./recognition-workflow.js";
import { installRecognitionPayload } from "./recognition-payload.js";
import { installRecognitionBinding } from "./recognition-binding.js";
import { installRecognitionSeam } from "./recognition-seam.js";
import { installRecognitionStitch } from "./recognition-stitch.js";
import { installRecognitionOverlap } from "./recognition-overlap.js";
import { installCapturePayload } from "./capture-payload.js";
import { installSceneProjection } from "./scene-projection.js";
import { installSceneCrossPage } from "./scene-crosspage.js";
import { installSceneCanonical } from "./scene-canonical.js";
import { installSceneDispatch } from "./scene-dispatch.js";
import { installRendererOverlay } from "./renderer-overlay.js";
import { installRendererCrossPage } from "./renderer-crosspage.js";
import { installRendererEmbed } from "./renderer-embed.js";
import { installRendererCanvas } from "./renderer-canvas.js";
import { installLifecycleBubble } from "./lifecycle-bubble.js";
import { installLifecyclePosition } from "./lifecycle-position.js";
import { installLifecycleFontFit } from "./lifecycle-font-fit.js";
import { installLifecycleOverlayCleanup } from "./lifecycle-overlay-cleanup.js";
import { installLifecycleRestore } from "./lifecycle-restore.js";
import { installNovelReader } from "./novel-reader.js";
import { installNovelRenderer } from "./novel-renderer.js";
import { installNovelImagePanel } from "./novel-image-panel.js";
import { installNovelWorkflow } from "./novel-workflow.js";
import { installNovelStreamClient } from "./novel-stream-client.js";
import { installNovelStreamWorkflow } from "./novel-stream-workflow.js";
import { installNovelImageWorkflow } from "./novel-image-workflow.js";
import { installControlsUi } from "./controls-ui.js";
import { installControlsTriple } from "./controls-triple.js";
import { installFloatingMenu } from "./floating-menu.js";
import { installFloatingPosition } from "./floating-position.js";
import { installNovelProgressPanel } from "./novel-progress-panel.js";
import { installNovelDiagnostics } from "./novel-diagnostics.js";
import { installNovelRevisionPanel } from "./novel-revision-panel.js";
import { installNovelCache } from "./novel-cache.js";
import { installWebpageSession } from "./webpage-session.js";
import { installWebpageTabState } from "./webpage-tab-state.js";
import { installWebpageScheduler } from "./webpage-scheduler.js";
import { installWebpageStartup } from "./webpage-startup.js";
import { installWebpageTranslate } from "./webpage-translate.js";
import { installWebpageObserver } from "./webpage-observer.js";
import { installWebpageLifecycle } from "./webpage-lifecycle.js";
import { installTranslationCacheClient } from "./translation-cache-client.js";
import { installControlsAutotranslate } from "./controls-autotranslate.js";
import { installControlsUtils } from "./controls-utils.js";
import { installTargetFilter } from "./target-filter.js";
import { installTargetResolve } from "./target-resolve.js";
import { installTargetCache } from "./target-cache.js";
import { installPlatformRuntime } from "./platform-runtime.js";
import { installPlatformDom } from "./platform-dom.js";
import { installReaderState } from "./reader-state.js";
import { installReaderApi } from "./reader-api.js";
import { installReaderStartup } from "./reader-startup.js";

export const contentInstallers = Object.freeze([
  installReaderInit,
  installReaderObservers,
  installScheduler,
  installRecognitionWorkflow,
  installRecognitionPayload,
  installRecognitionBinding,
  installRecognitionSeam,
  installRecognitionStitch,
  installRecognitionOverlap,
  installCapturePayload,
  installSceneProjection,
  installSceneCrossPage,
  installSceneCanonical,
  installSceneDispatch,
  installRendererOverlay,
  installRendererCrossPage,
  installRendererEmbed,
  installRendererCanvas,
  installLifecycleBubble,
  installLifecyclePosition,
  installLifecycleFontFit,
  installLifecycleOverlayCleanup,
  installLifecycleRestore,
  installNovelReader,
  installNovelRenderer,
  installNovelImagePanel,
  installNovelWorkflow,
  installNovelStreamClient,
  installNovelStreamWorkflow,
  installNovelImageWorkflow,
  installControlsUi,
  installControlsTriple,
  installFloatingMenu,
  installFloatingPosition,
  installNovelProgressPanel,
  installNovelDiagnostics,
  installNovelRevisionPanel,
  installNovelCache,
  installWebpageSession,
  installWebpageTabState,
  installWebpageScheduler,
  installWebpageStartup,
  installWebpageTranslate,
  installWebpageObserver,
  installWebpageLifecycle,
  installTranslationCacheClient,
  installControlsAutotranslate,
  installControlsUtils,
  installTargetFilter,
  installTargetResolve,
  installTargetCache,
  installPlatformRuntime,
  installPlatformDom,
  installReaderState,
  installReaderApi,
  installReaderStartup
]);

export const contentPhases = Object.freeze({
  functions: Object.freeze([
    installReaderInit,
    installReaderObservers,
    installScheduler,
    installRecognitionWorkflow,
    installRecognitionPayload,
    installRecognitionBinding,
    installRecognitionSeam,
    installRecognitionStitch,
    installRecognitionOverlap,
    installCapturePayload,
    installSceneProjection,
    installSceneCrossPage,
    installSceneCanonical,
    installSceneDispatch,
    installRendererOverlay,
    installRendererCrossPage,
    installRendererEmbed,
    installRendererCanvas,
    installLifecycleBubble,
    installLifecyclePosition,
    installLifecycleFontFit,
    installLifecycleOverlayCleanup,
    installLifecycleRestore,
    installNovelReader,
    installNovelRenderer,
    installNovelImagePanel,
    installNovelWorkflow,
    installNovelStreamClient,
    installNovelStreamWorkflow,
    installNovelImageWorkflow,
    installControlsUi,
    installControlsTriple,
    installFloatingMenu,
    installFloatingPosition,
    installNovelProgressPanel,
    installNovelDiagnostics,
    installNovelRevisionPanel,
    installNovelCache,
    installWebpageSession,
    installWebpageTabState,
    installWebpageScheduler,
    installWebpageStartup,
    installWebpageTranslate,
    installWebpageObserver,
    installWebpageLifecycle,
    installTranslationCacheClient,
    installControlsAutotranslate,
    installControlsUtils,
    installTargetFilter,
    installTargetResolve,
    installTargetCache,
    installPlatformRuntime,
    installPlatformDom
  ]),
  state: Object.freeze([installReaderState, installReaderApi]),
  startup: Object.freeze([installReaderStartup])
});
