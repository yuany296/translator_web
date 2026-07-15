import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Background module renames: oldFileName → newFileName, oldFunc → newFunc
const backgroundRenames = [
  ["01-messages.js", "messages.js", "installBackground01", "installMessages"],
  ["02-messages.js", "term-discovery.js", "installBackground02", "installTermDiscovery"],
  ["03-observations.js", "ocr-pipeline.js", "installBackground03", "installOcrPipeline"],
  ["04-observations.js", "ocr-dispatch.js", "installBackground04", "installOcrDispatch"],
  ["05-observations.js", "observation-results.js", "installBackground05", "installObservationResults"],
  ["06-observations.js", "seam-handling.js", "installBackground06", "installSeamHandling"],
  ["07-capture.js", "capture.js", "installBackground07", "installCapture"],
  ["10-ocr-provider.js", "ocr-provider.js", "installBackground10", "installOcrProvider"],
  ["11-ocr-provider.js", "vision-ocr.js", "installBackground11", "installVisionOcr"],
  ["12-ocr-grouping.js", "ocr-clustering.js", "installBackground12", "installOcrClustering"],
  ["13-ocr-grouping.js", "ocr-styles.js", "installBackground13", "installOcrStyles"],
  ["14-ocr-grouping.js", "ocr-lines.js", "installBackground14", "installOcrLines"],
  ["15-ocr-grouping.js", "ocr-regions.js", "installBackground15", "installOcrRegions"],
  ["16-ocr-geometry.js", "ocr-cluster-geometry.js", "installBackground16", "installOcrClusterGeometry"],
  ["17-ocr-geometry.js", "ocr-display-geometry.js", "installBackground17", "installOcrDisplayGeometry"],
  ["18-ocr-geometry.js", "ocr-item-filter.js", "installBackground18", "installOcrItemFilter"],
  ["19-ocr-geometry.js", "ocr-candidates.js", "installBackground19", "installOcrCandidates"],
  ["20-baidu.js", "baidu-provider.js", "installBackground20", "installBaiduProvider"],
  ["21-baidu.js", "baidu-results.js", "installBackground21", "installBaiduResults"],
  ["22-translation.js", "translation-provider.js", "installBackground22", "installTranslationProvider"],
  ["23-translation.js", "translation-helpers.js", "installBackground23", "installTranslationHelpers"],
  ["24-translation.js", "translation-coalesce.js", "installBackground24", "installTranslationCoalesce"],
  ["25-translation.js", "translation-utils.js", "installBackground25", "installTranslationUtils"],
  ["26-platform.js", "platform-cache.js", "installBackground26", "installPlatformCache"],
  ["27-platform.js", "platform-settings.js", "installBackground27", "installPlatformSettings"],
  ["28-platform.js", "platform-storage.js", "installBackground28", "installPlatformStorage"],
  ["29-bootstrap.js", "background-state.js", "installBackground29", "installBackgroundState"],
  ["30-bootstrap.js", "bootstrap.js", "installBackground30", "installBootstrap"],
  ["31-messages.js", "messages-constants.js", "installBackground31", "installMessagesConstants"],
];

const target = process.argv[2] || "background";

const configs = {
  background: {
    dir: "extension/src/background/modules",
    renames: backgroundRenames,
  },
  content: {
    dir: "extension/src/content/modules",
    renames: [
      ["01-reader-runtime.js", "reader-init.js", "installContent01", "installReaderInit"],
      ["02-reader-runtime.js", "reader-observers.js", "installContent02", "installReaderObservers"],
      ["03-scheduler.js", "scheduler.js", "installContent03", "installScheduler"],
      ["04-scheduler.js", "preload-sweep.js", "installContent04", "installPreloadSweep"],
      ["05-recognition.js", "recognition-workflow.js", "installContent05", "installRecognitionWorkflow"],
      ["06-recognition.js", "recognition-payload.js", "installContent06", "installRecognitionPayload"],
      ["07-recognition.js", "recognition-binding.js", "installContent07", "installRecognitionBinding"],
      ["08-recognition.js", "recognition-seam.js", "installContent08", "installRecognitionSeam"],
      ["09-recognition.js", "recognition-stitch.js", "installContent09", "installRecognitionStitch"],
      ["10-recognition.js", "recognition-overlap.js", "installContent10", "installRecognitionOverlap"],
      ["11-capture.js", "capture-payload.js", "installContent11", "installCapturePayload"],
      ["12-capture.js", "capture-helpers.js", "installContent12", "installCaptureHelpers"],
      ["13-scene.js", "scene-projection.js", "installContent13", "installSceneProjection"],
      ["14-scene.js", "scene-crosspage.js", "installContent14", "installSceneCrosspage"],
      ["15-scene.js", "scene-dispatch.js", "installContent15", "installSceneDispatch"],
      ["16-renderer.js", "renderer-overlay.js", "installContent16", "installRendererOverlay"],
      ["17-renderer.js", "renderer-embed.js", "installContent17", "installRendererEmbed"],
      ["18-renderer.js", "renderer-canvas.js", "installContent18", "installRendererCanvas"],
      ["19-lifecycle.js", "lifecycle-bubble.js", "installContent19", "installLifecycleBubble"],
      ["20-lifecycle.js", "lifecycle-position.js", "installContent20", "installLifecyclePosition"],
      ["21-lifecycle.js", "lifecycle-font-fit.js", "installContent21", "installLifecycleFontFit"],
      ["22-lifecycle.js", "lifecycle-restore.js", "installContent22", "installLifecycleRestore"],
      ["23-reader-controls.js", "controls-ui.js", "installContent23", "installControlsUi"],
      ["24-reader-controls.js", "controls-autotranslate.js", "installContent24", "installControlsAutotranslate"],
      ["25-reader-controls.js", "controls-utils.js", "installContent25", "installControlsUtils"],
      ["26-target-discovery.js", "target-filter.js", "installContent26", "installTargetFilter"],
      ["27-target-discovery.js", "target-resolve.js", "installContent27", "installTargetResolve"],
      ["28-target-discovery.js", "target-cache.js", "installContent28", "installTargetCache"],
      ["29-platform.js", "platform-runtime.js", "installContent29", "installPlatformRuntime"],
      ["30-platform.js", "platform-dom.js", "installContent30", "installPlatformDom"],
      ["31-reader-runtime.js", "reader-state.js", "installContent31", "installReaderState"],
      ["32-reader-runtime.js", "reader-store.js", "installContent32", "installReaderStore"],
      ["33-reader-runtime.js", "reader-api.js", "installContent33", "installReaderApi"],
      ["34-reader-runtime.js", "reader-startup.js", "installContent34", "installReaderStartup"],
      ["35-recognition.js", "recognition-constants.js", "installContent35", "installRecognitionConstants"],
    ],
  },
  canonical: {
    dir: "extension/src/canonical/modules",
    renames: [
      ["01-geometry.js", "stitch-geometry.js", "installPipeline01", "installStitchGeometry"],
      ["02-geometry.js", "stitch-neighbor.js", "installPipeline02", "installStitchNeighbor"],
      ["03-geometry.js", "stitch-payload.js", "installPipeline03", "installStitchPayload"],
      ["04-geometry.js", "stitch-mapping.js", "installPipeline04", "installStitchMapping"],
      ["05-geometry.js", "stitch-debug.js", "installPipeline05", "installStitchDebug"],
      ["06-page-store.js", "page-store-bridge.js", "installPipeline06", "installPageStoreBridge"],
      ["07-page-store.js", "store-pipeline-context.js", "installPipeline07", "installStorePipelineContext"],
      ["08-pipeline.js", "pipeline-bridge.js", "installPipeline08", "installPipelineBridge"],
      ["09-canonical-pipeline.js", "canonical-bridge.js", "installPipeline09", "installCanonicalBridge"],
      ["10-canonical-pipeline.js", "pipeline-helpers.js", "installPipeline10", "installPipelineHelpers"],
      ["11-projection.js", "projection-builder.js", "installPipeline11", "installProjectionBuilder"],
      ["12-projection.js", "projection-utils.js", "installPipeline12", "installProjectionUtils"],
      ["13-scene-index.js", "scene-index-builder.js", "installPipeline13", "installSceneIndexBuilder"],
      ["14-scene-index.js", "scene-index-resolve.js", "installPipeline14", "installSceneIndexResolve"],
      ["15-scene-index.js", "scene-index-utils.js", "installPipeline15", "installSceneIndexUtils"],
      ["16-dedupe.js", "dedupe-global.js", "installPipeline16", "installDedupeGlobal"],
      ["17-geometry.js", "constants-fsm.js", "installPipeline17", "installConstantsFsm"],
      ["18-canonical-pipeline.js", "pipeline-errors.js", "installPipeline18", "installPipelineErrors"],
      ["19-dedupe.js", "pipeline-api.js", "installPipeline19", "installPipelineApi"],
    ],
  },
};

const cfg = configs[target];
if (!cfg) { console.error("Unknown target:", target); process.exit(1); }
const modulesDir = path.join(root, cfg.dir);

// Phase 1: git mv
for (const [oldName, newName] of cfg.renames) {
  const oldPath = path.join(modulesDir, oldName);
  const newPath = path.join(modulesDir, newName);
  try {
    execSync(`git mv "${oldPath}" "${newPath}"`, { cwd: root, stdio: "pipe" });
    console.log(`git mv: ${oldName} → ${newName}`);
  } catch (err) {
    // If git mv fails (file may already be moved), try regular mv
    console.log(`git mv failed for ${oldName}, trying file copy: ${err.message.slice(0, 80)}`);
  }
}

// Phase 2: Update export function names in each file
for (const [, newName, oldFunc, newFunc] of cfg.renames) {
  const filePath = path.join(modulesDir, newName);
  let content;
  try {
    content = readFileSync(filePath, "utf8");
  } catch {
    console.log(`SKIP ${newName} (file not found)`);
    continue;
  }
  // Replace function definition
  content = content.replaceAll(`function ${oldFunc}`, `function ${newFunc}`);
  // Replace runtime assignment: runtime.oldFunc = oldFunc;
  content = content.replaceAll(`runtime.${oldFunc} = ${oldFunc}`, `runtime.${newFunc} = ${newFunc}`);
  // Replace any remaining standalone references (export statement, etc.)
  content = content.replaceAll(oldFunc, newFunc);
  writeFileSync(filePath, content, "utf8");
  console.log(`updated: ${newName} (${oldFunc} → ${newFunc})`);
}

console.log("\nDone. Now update modules/index.js manually with new imports.");
