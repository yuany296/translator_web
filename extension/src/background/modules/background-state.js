import { OCR_COORDINATE_MODEL_VERSION, OCR_GEOMETRY_VERSION, TRANSLATION_PROMPT_VERSION, WEBPAGE_TRANSLATION_PROMPT_VERSION } from "../../config/versions.js";

export function installBackgroundState(runtime) {
  const CONTENT_SCRIPT_FILES = Object.freeze(["kakao-reconciler.js", "kakao-pipeline.js", "content.js"]);
  runtime.CONTENT_SCRIPT_FILES = CONTENT_SCRIPT_FILES;
  const STORAGE_KEYS = {
    glossary: runtime.glossaryCore.STORAGE_KEY,
    glossaryLegacy: runtime.glossaryCore.LEGACY_STORAGE_KEY,
    glossaryPending: runtime.termDiscoveryCore.PENDING_STORAGE_KEY,
    glossaryIgnored: runtime.termDiscoveryCore.IGNORED_STORAGE_KEY,
    glossaryStorage: "mt_glossary_storage",
    novelMemory: runtime.novelMemoryCore.STORAGE_KEY
  };
  runtime.STORAGE_KEYS = STORAGE_KEYS;
  const DEFAULT_SETTINGS = {
    provider: "baidu",
    model: "deepseek-chat",
    apiKey: "",
    baseUrl: "",
    baiduApiKey: "",
    baiduSecretKey: "",
    localOcrBaseUrl: "http://127.0.0.1:8765",
    localOcrLang: "auto",
    localOcrMode: "fast",
    localOcrDetThresh: 0.3,
    localOcrDetBoxThresh: 0.6,
    localOcrDetUnclipRatio: 1.2,
    localOcrDebug: false,
    ocrConfidenceThreshold: 0.72,
    ocrMinBoxArea: 36,
    ocrMaxBoxArea: 0.35,
    ocrMinBoxWidth: 6,
    ocrMinBoxHeight: 6,
    ocrMaxAspectRatio: 18,
    ocrMergeLineGap: 1.65,
    overwriteFontScale: 1,
    overwriteCoverPadding: 1.2,
    debugOverlayMode: "final",
    overwritePreviewMode: "full",
    visionOcrApiKey: "",
    visionOcrBaseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
    visionOcrModel: "qwen-vl-ocr-latest",
    visionOcrEnabled: false,
    enabled: true,
    showBall: true,
    captureMode: "direct",
    renderMode: "overlay",
    pretranslateMode: "manual",
    ignoreSimplifiedChinese: false,
    termDiscoveryEnabled: true,
    floatingSide: "right",
    floatingYRatio: 0.72
  };
  runtime.DEFAULT_SETTINGS = DEFAULT_SETTINGS;
  const PROVIDERS = {
    baidu: "baidu",
    localPaddle: "local_paddle"
  };
  runtime.PROVIDERS = PROVIDERS;
  runtime.DEFAULT_TRANSLATION_MODEL = "deepseek-chat";
  const DEFAULT_TRANSLATION_BASE_URL = "https://api.deepseek.com";
  runtime.DEFAULT_TRANSLATION_BASE_URL = DEFAULT_TRANSLATION_BASE_URL;
  const DEFAULT_QWEN_BASE_URL = "https://dashscope.aliyuncs.com/compatible-mode/v1";
  runtime.DEFAULT_QWEN_BASE_URL = DEFAULT_QWEN_BASE_URL;
  const DEFAULT_VISION_OCR_MODEL = "qwen-vl-ocr-latest";
  runtime.DEFAULT_VISION_OCR_MODEL = DEFAULT_VISION_OCR_MODEL;
  const DEFAULT_LOCAL_OCR_BASE_URL = "http://127.0.0.1:8765";
  runtime.DEFAULT_LOCAL_OCR_BASE_URL = DEFAULT_LOCAL_OCR_BASE_URL;
  const DEFAULT_LOCAL_OCR_LANG = "auto";
  runtime.DEFAULT_LOCAL_OCR_LANG = DEFAULT_LOCAL_OCR_LANG;
  const DEFAULT_LOCAL_OCR_MODE = "fast";
  runtime.DEFAULT_LOCAL_OCR_MODE = DEFAULT_LOCAL_OCR_MODE;
  const DEFAULT_LOCAL_OCR_DET_THRESH = 0.3;
  runtime.DEFAULT_LOCAL_OCR_DET_THRESH = DEFAULT_LOCAL_OCR_DET_THRESH;
  const DEFAULT_LOCAL_OCR_DET_BOX_THRESH = 0.6;
  runtime.DEFAULT_LOCAL_OCR_DET_BOX_THRESH = DEFAULT_LOCAL_OCR_DET_BOX_THRESH;
  const DEFAULT_LOCAL_OCR_DET_UNCLIP_RATIO = 1.2;
  runtime.DEFAULT_LOCAL_OCR_DET_UNCLIP_RATIO = DEFAULT_LOCAL_OCR_DET_UNCLIP_RATIO;
  const DEBUG_OVERLAY_MODES = new Set(["raw", "filtered", "merged", "final"]);
  runtime.DEBUG_OVERLAY_MODES = DEBUG_OVERLAY_MODES;
  const OVERWRITE_PREVIEW_MODES = new Set(["full", "cover", "text"]);
  runtime.OVERWRITE_PREVIEW_MODES = OVERWRITE_PREVIEW_MODES;
  const CACHE_PREFIX = "mt_cache_v21:";
  runtime.CACHE_PREFIX = CACHE_PREFIX;
  const OCR_CACHE_PREFIX = "mt_cache_v28:ocr:";
  runtime.OCR_CACHE_PREFIX = OCR_CACHE_PREFIX;
  const CANONICAL_TRANSLATION_CACHE_PREFIX = "mt_cache_v22:translation:";
  runtime.CANONICAL_TRANSLATION_CACHE_PREFIX = CANONICAL_TRANSLATION_CACHE_PREFIX;
  const LOCAL_OCR_GEOMETRY_VERSION = OCR_GEOMETRY_VERSION;
  runtime.LOCAL_OCR_GEOMETRY_VERSION = LOCAL_OCR_GEOMETRY_VERSION;
  runtime.OCR_COORDINATE_MODEL_VERSION = OCR_COORDINATE_MODEL_VERSION;
  const CANONICAL_TRANSLATION_PROMPT_VERSION = TRANSLATION_PROMPT_VERSION;
  runtime.CANONICAL_TRANSLATION_PROMPT_VERSION = CANONICAL_TRANSLATION_PROMPT_VERSION;
  runtime.WEBPAGE_TRANSLATION_PROMPT_VERSION = WEBPAGE_TRANSLATION_PROMPT_VERSION;
  const TRANSLATION_CACHE_KEY_RE = /^mt_cache_v\d+:/;
  runtime.TRANSLATION_CACHE_KEY_RE = TRANSLATION_CACHE_KEY_RE;
  const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
  runtime.CACHE_TTL_MS = CACHE_TTL_MS;
  const TAB_STATUS_PREFIX = "mt_tab_status_v1:";
  runtime.TAB_STATUS_PREFIX = TAB_STATUS_PREFIX;
  const TAB_STATUS_TTL_MS = 12 * 60 * 60 * 1000;
  runtime.TAB_STATUS_TTL_MS = TAB_STATUS_TTL_MS;
  const MAX_BUBBLES = 400;
  runtime.MAX_BUBBLES = MAX_BUBBLES;
  const IMAGE_MAX_SIDE = 1536;
  runtime.IMAGE_MAX_SIDE = IMAGE_MAX_SIDE;
  const IMAGE_JPEG_QUALITY = 0.82;
  runtime.IMAGE_JPEG_QUALITY = IMAGE_JPEG_QUALITY;
  const FAST_PATH_MAX_JPEG_BYTES = 1900000;
  runtime.FAST_PATH_MAX_JPEG_BYTES = FAST_PATH_MAX_JPEG_BYTES;
  const BLOB_TO_DATA_URL_TIMEOUT_MS = 8000;
  runtime.BLOB_TO_DATA_URL_TIMEOUT_MS = BLOB_TO_DATA_URL_TIMEOUT_MS;
  const VISIBLE_TAB_CAPTURE_CACHE_MS = 700;
  runtime.VISIBLE_TAB_CAPTURE_CACHE_MS = VISIBLE_TAB_CAPTURE_CACHE_MS;
  const BAIDU_OCR_MIN_REQUEST_GAP_MS = 1200;
  runtime.BAIDU_OCR_MIN_REQUEST_GAP_MS = BAIDU_OCR_MIN_REQUEST_GAP_MS;
  const BAIDU_OCR_QPS_RETRY_DELAYS_MS = [1200, 2400, 4800];
  runtime.BAIDU_OCR_QPS_RETRY_DELAYS_MS = BAIDU_OCR_QPS_RETRY_DELAYS_MS;
  const BAIDU_MERGE_MAX_GAP_RATIO = 1.35;
  runtime.BAIDU_MERGE_MAX_GAP_RATIO = BAIDU_MERGE_MAX_GAP_RATIO;
  const BAIDU_MERGE_MAX_INDENT_RATIO = 2.4;
  runtime.BAIDU_MERGE_MAX_INDENT_RATIO = BAIDU_MERGE_MAX_INDENT_RATIO;
  const BAIDU_MERGE_MAX_WIDTH_RATIO = 0.68;
  runtime.BAIDU_MERGE_MAX_WIDTH_RATIO = BAIDU_MERGE_MAX_WIDTH_RATIO;
  const LOCAL_OCR_CONTAINER_SCAN_MAX_SIDE = 760;
  runtime.LOCAL_OCR_CONTAINER_SCAN_MAX_SIDE = LOCAL_OCR_CONTAINER_SCAN_MAX_SIDE;
  const LOCAL_OCR_EFFECT_JOIN_DISTANCE_RATIO = 2.25;
  runtime.LOCAL_OCR_EFFECT_JOIN_DISTANCE_RATIO = LOCAL_OCR_EFFECT_JOIN_DISTANCE_RATIO;
  const LOCAL_OCR_BUBBLE_JOIN_GAP_RATIO = 1.65;
  runtime.LOCAL_OCR_BUBBLE_JOIN_GAP_RATIO = LOCAL_OCR_BUBBLE_JOIN_GAP_RATIO;
  const TERM_EXTRACTOR_TIMEOUT_MS = 8000;
  runtime.TERM_EXTRACTOR_TIMEOUT_MS = TERM_EXTRACTOR_TIMEOUT_MS;
  const TERM_EXTRACTOR_COOLDOWN_MS = 5 * 60 * 1000;
  runtime.TERM_EXTRACTOR_COOLDOWN_MS = TERM_EXTRACTOR_COOLDOWN_MS;
  const TERM_EXTRACTOR_HEALTH_CACHE_MS = 30 * 1000;
  runtime.TERM_EXTRACTOR_HEALTH_CACHE_MS = TERM_EXTRACTOR_HEALTH_CACHE_MS;
  const LOCAL_OCR_REQUEST_TIMEOUT_MS = 60 * 1000;
  runtime.LOCAL_OCR_REQUEST_TIMEOUT_MS = LOCAL_OCR_REQUEST_TIMEOUT_MS;
  const TRANSLATION_REQUEST_TIMEOUT_MS = 30 * 1000;
  runtime.TRANSLATION_REQUEST_TIMEOUT_MS = TRANSLATION_REQUEST_TIMEOUT_MS;
  const VISION_OCR_REQUEST_TIMEOUT_MS = 12 * 1000;
  runtime.VISION_OCR_REQUEST_TIMEOUT_MS = VISION_OCR_REQUEST_TIMEOUT_MS;
  const VISION_OCR_REPAIR_BUDGET_MS = 20 * 1000;
  runtime.VISION_OCR_REPAIR_BUDGET_MS = VISION_OCR_REPAIR_BUDGET_MS;
  const MAX_CLEANED_MASKS = 200;
  runtime.MAX_CLEANED_MASKS = MAX_CLEANED_MASKS;
  const CLEANED_MASK_COORDINATE_SCALE = 10000;
  runtime.CLEANED_MASK_COORDINATE_SCALE = CLEANED_MASK_COORDINATE_SCALE;
  const CLEANED_MASK_FINGERPRINT_VERSION = "cleaned-masks-v1";
  runtime.CLEANED_MASK_FINGERPRINT_VERSION = CLEANED_MASK_FINGERPRINT_VERSION;
  const SEAM_CROSS_EDGE_WINDOW_PX = 24;
  runtime.SEAM_CROSS_EDGE_WINDOW_PX = SEAM_CROSS_EDGE_WINDOW_PX;
  const SEAM_CROSS_PAIR_MAX_GAP_PX = 48;
  runtime.SEAM_CROSS_PAIR_MAX_GAP_PX = SEAM_CROSS_PAIR_MAX_GAP_PX;
  const SEAM_CROSS_MIN_HORIZONTAL_OVERLAP = 0.25;
  runtime.SEAM_CROSS_MIN_HORIZONTAL_OVERLAP = SEAM_CROSS_MIN_HORIZONTAL_OVERLAP;
  const SEAM_CROSS_MIN_HEIGHT_RATIO = 0.5;
  runtime.SEAM_CROSS_MIN_HEIGHT_RATIO = SEAM_CROSS_MIN_HEIGHT_RATIO;
  const SEAM_CROSS_MAX_ROTATION_DELTA_DEG = 20;
  runtime.SEAM_CROSS_MAX_ROTATION_DELTA_DEG = SEAM_CROSS_MAX_ROTATION_DELTA_DEG;
  const SEAM_CROSS_MAX_BAND_COVERAGE = 1.5;
  runtime.SEAM_CROSS_MAX_BAND_COVERAGE = SEAM_CROSS_MAX_BAND_COVERAGE;
  const SEAM_CROSS_MAX_VISUAL_WIDTH_COVERAGE = 0.9;
  runtime.SEAM_CROSS_MAX_VISUAL_WIDTH_COVERAGE = SEAM_CROSS_MAX_VISUAL_WIDTH_COVERAGE;
  const SEAM_CROSS_MAX_VISUAL_AREA_COVERAGE = 0.6;
  runtime.SEAM_CROSS_MAX_VISUAL_AREA_COVERAGE = SEAM_CROSS_MAX_VISUAL_AREA_COVERAGE;
  const CHAT_CLOCK_TIME_SOURCE = "(?:(?:오전|오후)\\s*)?\\d{1,2}:\\d{2}";
  runtime.CHAT_CLOCK_TIME_SOURCE = CHAT_CLOCK_TIME_SOURCE;
  const CHAT_RELATIVE_TIME_SOURCE = "(?:\\d{1,3}\\s*)?(?:분|시간)\\s*전";
  runtime.CHAT_RELATIVE_TIME_SOURCE = CHAT_RELATIVE_TIME_SOURCE;
  const CHAT_TIME_RE = new RegExp(`${runtime.CHAT_CLOCK_TIME_SOURCE}|${runtime.CHAT_RELATIVE_TIME_SOURCE}`, "u");
  runtime.CHAT_TIME_RE = CHAT_TIME_RE;
  const CHAT_TRANSLATION_ROLES = Object.freeze({
    nickname: "chat_nickname",
    time: "chat_time",
    aux: "chat_aux",
    body: "chat_body"
  });
  runtime.CHAT_TRANSLATION_ROLES = CHAT_TRANSLATION_ROLES;
  const CHAT_TRANSLATION_ROLE_RE = /^chat_(?:nickname|time|aux|body)$/;
  runtime.CHAT_TRANSLATION_ROLE_RE = CHAT_TRANSLATION_ROLE_RE;
  const CHAT_FONT_WEIGHTS = Object.freeze({
    chat_nickname: 600,
    chat_time: 400,
    chat_aux: 500,
    chat_body: 700
  });
  runtime.CHAT_FONT_WEIGHTS = CHAT_FONT_WEIGHTS;
  const CHAT_MERGE_HEIGHT_RATIO_MAX = 1.32;
  runtime.CHAT_MERGE_HEIGHT_RATIO_MAX = CHAT_MERGE_HEIGHT_RATIO_MAX;
  const CHAT_MERGE_BRIGHTNESS_DIFF = 60;
  runtime.CHAT_MERGE_BRIGHTNESS_DIFF = CHAT_MERGE_BRIGHTNESS_DIFF;
  const CHAT_PARAGRAPH_HEIGHT_RATIO_MAX = 1.35;
  runtime.CHAT_PARAGRAPH_HEIGHT_RATIO_MAX = CHAT_PARAGRAPH_HEIGHT_RATIO_MAX;
  const CHAT_SMALL_ABOVE_LARGE_MIN_GAP = 0.3;
  runtime.CHAT_SMALL_ABOVE_LARGE_MIN_GAP = CHAT_SMALL_ABOVE_LARGE_MIN_GAP;
  const CHAT_PAINT_PADDING_X = 4;
  runtime.CHAT_PAINT_PADDING_X = CHAT_PAINT_PADDING_X;
  const CHAT_PAINT_PADDING_Y = 3;
  runtime.CHAT_PAINT_PADDING_Y = CHAT_PAINT_PADDING_Y;
  const CHAT_PAINT_PADDING_RATIO_X = 0.12;
  runtime.CHAT_PAINT_PADDING_RATIO_X = CHAT_PAINT_PADDING_RATIO_X;
  const CHAT_PAINT_PADDING_RATIO_Y = 0.08;
  runtime.CHAT_PAINT_PADDING_RATIO_Y = CHAT_PAINT_PADDING_RATIO_Y;
  const OCR_STYLE_SPLIT_HEIGHT_RATIO = 1.32;
  runtime.OCR_STYLE_SPLIT_HEIGHT_RATIO = OCR_STYLE_SPLIT_HEIGHT_RATIO;
  const MODEL_IMAGE_PLACEHOLDER_BRACKET_RE = /[\[\(（【<［]\s*image\s*#?\s*\d+\s*[\]\)）】>］]/giu;
  runtime.MODEL_IMAGE_PLACEHOLDER_BRACKET_RE = MODEL_IMAGE_PLACEHOLDER_BRACKET_RE;
  const MODEL_IMAGE_PLACEHOLDER_ONLY_RE = /^image\s*#?\s*\d+$/iu;
  runtime.MODEL_IMAGE_PLACEHOLDER_ONLY_RE = MODEL_IMAGE_PLACEHOLDER_ONLY_RE;
  const inflightTranslateByCacheKey = new Map();
  runtime.inflightTranslateByCacheKey = inflightTranslateByCacheKey;
  const inflightOcrByCacheKey = new Map();
  runtime.inflightOcrByCacheKey = inflightOcrByCacheKey;
  const inflightTranslationByFingerprint = new Map();
  runtime.inflightTranslationByFingerprint = inflightTranslationByFingerprint;
  let backgroundTestHooks = null;
  runtime.backgroundTestHooks = backgroundTestHooks;
  const ocrLinesBySourceImageId = new Map();
  runtime.ocrLinesBySourceImageId = ocrLinesBySourceImageId;
  const visibleTabCaptureCacheByWindow = new Map();
  runtime.visibleTabCaptureCacheByWindow = visibleTabCaptureCacheByWindow;
  let baiduAccessTokenCache = null;
  runtime.baiduAccessTokenCache = baiduAccessTokenCache;
  let baiduOcrQueue = Promise.resolve();
  runtime.baiduOcrQueue = baiduOcrQueue;
  let baiduLastOcrRequestAt = 0;
  runtime.baiduLastOcrRequestAt = baiduLastOcrRequestAt;
  let termDiscoveryMutationQueue = Promise.resolve();
  runtime.termDiscoveryMutationQueue = termDiscoveryMutationQueue;
  let termExtractorRuntime = {
    state: "unknown",
    error: "",
    checkedAt: 0,
    cooldownUntil: 0
  };
  runtime.termExtractorRuntime = termExtractorRuntime;
}
