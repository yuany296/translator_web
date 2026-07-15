import { CONFIG_KEYS, normalizeRuntimeConfig } from "../config/schema.js";
import { detectReaderProfile } from "../readers/profile.js";
import { createRenderScene } from "../rendering/render-scene.js";

function buildProjectionScenes(runtime, input) {
  const pages = runtime.normalizeProjectionPages(input);
  const scenes = new Map();
  for (const [pageId, projections] of pages) {
    const layers = projections.map((projection, index) => {
      const role = String(projection.role || "text_primary");
      const coverOnly = role === "cover" || role === "cover_only" || projection.coverOnly === true;
      return {
        id: String(projection.projectionId || `${pageId}:${index}`),
        canonicalId: String(projection.canonicalId || projection.groupId || ""),
        regionFamily: String(projection.regionFamily || projection.canonicalId || projection.groupId || ""),
        type: coverOnly ? "cover" : "debug",
        active: coverOnly ? projection.active !== false : true,
        geometry: projection.geometry || projection.visual || {},
        diagnostic: coverOnly ? null : { reason: "legacy_projection_waiting_for_crop_placement" }
      };
    });
    scenes.set(pageId, createRenderScene({ id: `page:${pageId}`, surface: { id: pageId, type: "page" }, layers }));
  }
  return scenes;
}

async function requestSeparatedFallback(runtime, payload, requestKey) {
  const pageId = `single:${requestKey}`;
  const ocr = await runtime.sendRuntimeMessage({
    type: "OCR_DATA_URL", dataUrl: payload.dataUrl, sourceType: "page", pageIds: [pageId],
    targetKey: requestKey, imageMeta: runtime.buildPayloadImageMeta(payload)
  });
  if (!ocr?.ok) return ocr;
  const observations = ocr.result?.observations || [];
  const translation = await runtime.sendRuntimeMessage({
    type: "TRANSLATE_TEXT_BLOCKS",
    items: observations.map((item) => ({ id: item.id, revision: 1, original_text: item.originalText }))
  });
  if (!translation?.ok) return translation;
  const translated = new Map(translation.translations.map((item) => [item.id, item.translated_text]));
  return {
    ok: true,
    result: {
      bubbles: observations.map((item) => ({
        ...(item.visual?.box || {}), original_text: item.originalText,
        translated_text: translated.get(item.id) || item.originalText, visual: item.visual
      })),
      cleanedImage: ocr.result.cleanedImage || null,
      debug: ocr.result.debug || null
    }
  };
}

export function prepareContentRuntime(runtime) {
  runtime.readerProfile = detectReaderProfile();
  runtime.TARGET_SELECTOR = runtime.readerProfile.targetSelector;
  runtime.RUNTIME_FEATURE_VERSION = "reader-canonical-scene-v2";
  runtime.shouldUseKakaoCanonicalPipeline = (target) => Boolean(
    target && runtime.isSupportedTarget(target) && runtime.state?.captureMode !== "screenshot"
  );
  runtime.requestTranslationForPayload = (payload, requestKey) => requestSeparatedFallback(runtime, payload, requestKey);
  runtime.expandBubbleForTextOverflow = () => false;

  const renderCanonical = runtime.renderCanonicalProjections;
  runtime.renderCanonicalProjections = (input = {}) => {
    runtime.renderScenesByPage = buildProjectionScenes(runtime, input);
    return renderCanonical(input);
  };

  runtime.loadLocalSettings = async () => {
    const stored = await runtime.storageGet([CONFIG_KEYS.runtime]);
    const config = normalizeRuntimeConfig(stored[CONFIG_KEYS.runtime]);
    runtime.state.enabled = config.enabled;
    runtime.state.showFloatingBall = config.showBall;
    runtime.state.captureMode = config.captureMode;
    runtime.state.renderMode = config.renderMode;
    runtime.state.pretranslateMode = config.pretranslateMode;
    return config;
  };
  runtime.bindStorageListener = () => chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local" || !changes[CONFIG_KEYS.runtime]) return;
    const config = normalizeRuntimeConfig(changes[CONFIG_KEYS.runtime].newValue);
    Object.assign(runtime.state, {
      enabled: config.enabled, showFloatingBall: config.showBall,
      captureMode: config.captureMode, renderMode: config.renderMode,
      pretranslateMode: config.pretranslateMode
    });
    runtime.ensureExtensionUiMounted();
    if (config.enabled) runtime.rescan();
    else runtime.clearAllRenderedTargets();
  });
}

export function completeContentRuntime(runtime) {
  runtime.kakaoLegacyPipeline = null;
  runtime.api.readerProfile = runtime.readerProfile;
  runtime.api.__test.shouldUseKakaoCanonicalPipeline = runtime.shouldUseKakaoCanonicalPipeline;
  runtime.api.__test.getRenderScenes = () => runtime.renderScenesByPage || new Map();
}
