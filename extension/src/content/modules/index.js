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
import { installRendererMask } from "./renderer-mask.js";
import { installRendererCover } from "./renderer-cover.js";
import { installCrossPageCover } from "./crosspage-cover.js";
import { installRendererCrossPage } from "./renderer-crosspage.js";
import { installCrossPageLifecycle } from "./crosspage-lifecycle.js";
import { installRendererEmbed } from "./renderer-embed.js";
import { installRendererCanvas } from "./renderer-canvas.js";
import { installLifecycleBubble } from "./lifecycle-bubble.js";
import { installLifecycleCover } from "./lifecycle-cover.js";
import { installLifecyclePosition } from "./lifecycle-position.js";
import { installLifecycleFontFit } from "./lifecycle-font-fit.js";
import { installLifecycleOverlayCleanup } from "./lifecycle-overlay-cleanup.js";
import { installLifecycleRestore } from "./lifecycle-restore.js";
import { installNovelReader } from "./novel-reader.js";
import { installNovelEmphasisAlign } from "./novel-emphasis-align.js";
import { installNovelRenderer } from "./novel-renderer.js";
import { installNovelImagePanel } from "./novel-image-panel.js";
import { installNovelWorkflow } from "./novel-workflow.js";
import { installNovelProgressiveWorkflow } from "./novel-progressive-workflow.js";
import { installNovelTermDiscovery } from "./novel-term-discovery.js";
import { installNovelStreamClient } from "./novel-stream-client.js";
import { installNovelStreamWorkflow } from "./novel-stream-workflow.js";
import { installNovelImageWorkflow } from "./novel-image-workflow.js";
import { installFloatingFeedback } from "./floating-feedback.js";
import { installNovelActionFeedback } from "./novel-action-feedback.js";
import { installNovelFocusClick } from "./novel-focus-click.js";
import { installControlsUi } from "./controls-ui.js";
import { installOverlayHost } from "./overlay-host.js";
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
import { installWebpageNodeLoading } from "./webpage-node-loading.js";
import { installWebpageObserver } from "./webpage-observer.js";
import { installWebpageLifecycle } from "./webpage-lifecycle.js";
import { installTranslationCacheClient } from "./translation-cache-client.js";
import { installCanonicalPartialTranslations } from "./canonical-partial.js";
import { installControlsAutotranslate } from "./controls-autotranslate.js";
import { installControlsUtils } from "./controls-utils.js";
import { installTargetFilter } from "./target-filter.js";
import { installTargetIdentity } from "./target-identity.js";
import { installTargetResolve } from "./target-resolve.js";
import { installTargetCache } from "./target-cache.js";
import { installPlatformRuntime } from "./platform-runtime.js";
import { installPlatformDom } from "./platform-dom.js";
import { installDiagnosticsOverlay } from "./diagnostics-overlay.js";
import { installReaderState } from "./reader-state.js";
import { installReaderApi } from "./reader-api.js";
import { installReaderStartup } from "./reader-startup.js";

export const contentPhases = Object.freeze({
  functions: Object.freeze([
    installTargetIdentity,
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
    // 清理图是异步落到页上的：装配它，canonical 层才能在 artifact 落地时
    // 立刻把遮罩绑到已存在的覆盖层上，而不是等一次未必会发生的重渲染。
    installRendererMask,
    installRendererCover,
    installCrossPageCover,
    installRendererCrossPage,
    installCrossPageLifecycle,
    installRendererEmbed,
    installRendererCanvas,
    installLifecycleBubble,
    installLifecycleCover,
    installLifecyclePosition,
    installLifecycleFontFit,
    installLifecycleOverlayCleanup,
    installLifecycleRestore,
    installNovelReader,
    installNovelRenderer,
    installNovelImagePanel,
  installNovelWorkflow,
  installNovelProgressiveWorkflow,
    installNovelTermDiscovery,
    installNovelStreamClient,
    installNovelStreamWorkflow,
    installNovelImageWorkflow,
    installFloatingFeedback,
    installNovelActionFeedback,
    // 必须早于 controls-ui：后者的 ensureOverlayLayer 会优先委托给它，
    // 缺了这一步覆盖层又会退回挂在 documentElement 上（不随内容滚动 → 逐帧追赶 + 多一条滚动条）。
    installOverlayHost,
    installControlsUi,
    installControlsTriple,
    installNovelFocusClick,
    installFloatingMenu,
    installFloatingPosition,
    installNovelProgressPanel,
    installNovelDiagnostics,
    installNovelRevisionPanel,
    installNovelCache,
    installNovelEmphasisAlign,
    installWebpageSession,
    installWebpageTabState,
    installWebpageScheduler,
    installWebpageStartup,
    installWebpageTranslate,
    installWebpageNodeLoading,
    installWebpageObserver,
    installWebpageLifecycle,
    installTranslationCacheClient,
  installCanonicalPartialTranslations,
    installControlsAutotranslate,
    installControlsUtils,
    installTargetFilter,
    installTargetResolve,
    installTargetCache,
    installPlatformRuntime,
    installPlatformDom,
    installDiagnosticsOverlay
  ]),
  state: Object.freeze([installReaderState, installReaderApi]),
  startup: Object.freeze([installReaderStartup])
});
