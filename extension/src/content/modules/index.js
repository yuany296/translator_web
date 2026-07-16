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
import { installSceneCanonical } from "./scene-canonical.js";
import { installSceneDispatch } from "./scene-dispatch.js";
import { installRendererOverlay } from "./renderer-overlay.js";
import { installRendererEmbed } from "./renderer-embed.js";
import { installRendererCanvas } from "./renderer-canvas.js";
import { installLifecycleBubble } from "./lifecycle-bubble.js";
import { installLifecyclePosition } from "./lifecycle-position.js";
import { installLifecycleFontFit } from "./lifecycle-font-fit.js";
import { installLifecycleOverlayCleanup } from "./lifecycle-overlay-cleanup.js";
import { installLifecycleRestore } from "./lifecycle-restore.js";
import { installControlsUi } from "./controls-ui.js";
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
  installSceneCanonical,
  installSceneDispatch,
  installRendererOverlay,
  installRendererEmbed,
  installRendererCanvas,
  installLifecycleBubble,
  installLifecyclePosition,
  installLifecycleFontFit,
  installLifecycleOverlayCleanup,
  installLifecycleRestore,
  installControlsUi,
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
    installSceneCanonical,
    installSceneDispatch,
    installRendererOverlay,
    installRendererEmbed,
    installRendererCanvas,
    installLifecycleBubble,
    installLifecyclePosition,
    installLifecycleFontFit,
    installLifecycleOverlayCleanup,
    installLifecycleRestore,
    installControlsUi,
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
