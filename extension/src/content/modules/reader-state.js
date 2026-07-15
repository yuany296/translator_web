export function installReaderState(runtime) {
  const IS_PIXIV_COMIC_VIEWER = /(^|\.)comic\.pixiv\.net$/i.test(location.hostname) && /^\/viewer\/stories\/\d+/i.test(location.pathname);
  runtime.IS_PIXIV_COMIC_VIEWER = IS_PIXIV_COMIC_VIEWER;
  const IS_KAKAOPAGE_READER = /(^|\.)page\.kakao\.com$/i.test(location.hostname) || /(^|\.)kakaopage\.com$/i.test(location.hostname) || /(^|\.)page\.kakaocdn\.net$/i.test(location.hostname);
  runtime.IS_KAKAOPAGE_READER = IS_KAKAOPAGE_READER;
  const TARGET_SELECTOR = runtime.IS_PIXIV_COMIC_VIEWER || runtime.IS_KAKAOPAGE_READER ? "img, canvas, [id^='page-'], [style*='background-image']" : "img, canvas";
  runtime.TARGET_SELECTOR = TARGET_SELECTOR;
  const PIXIV_PAGE_ID_RE = /^page-\d+$/;
  runtime.PIXIV_PAGE_ID_RE = PIXIV_PAGE_ID_RE;
  const PIXIV_PLACEHOLDER_BACKGROUND_RE = /\/images\/blank\.png|border_logo\.png/i;
  runtime.PIXIV_PLACEHOLDER_BACKGROUND_RE = PIXIV_PLACEHOLDER_BACKGROUND_RE;
  const AUTO_MIN_WIDTH = 80;
  runtime.AUTO_MIN_WIDTH = AUTO_MIN_WIDTH;
  const AUTO_MIN_HEIGHT = 80;
  runtime.AUTO_MIN_HEIGHT = AUTO_MIN_HEIGHT;
  const AUTO_MIN_RATIO = 0.10;
  runtime.AUTO_MIN_RATIO = AUTO_MIN_RATIO;
  const MANUAL_MIN_WIDTH = 60;
  runtime.MANUAL_MIN_WIDTH = MANUAL_MIN_WIDTH;
  const MANUAL_MIN_HEIGHT = 60;
  runtime.MANUAL_MIN_HEIGHT = MANUAL_MIN_HEIGHT;
  const MAX_MANUAL_TARGETS = 4;
  runtime.MAX_MANUAL_TARGETS = MAX_MANUAL_TARGETS;
  const MAX_PARALLEL_TRANSLATIONS = runtime.IS_KAKAOPAGE_READER ? 6 : 3;
  // 本地 Paddle 服务按全局锁串行执行 OCR；若同时放行多张 ahead 页面，
  // 它们会先进入服务端 FIFO，让后来进入视口的正文排在队尾。Kakao 仅允许
  // 一个 ahead 作业在途，其余槽位始终可由当前可视内容抢占。
  runtime.MAX_PARALLEL_TRANSLATIONS = MAX_PARALLEL_TRANSLATIONS;
  const VISIBLE_TRANSLATION_RESERVED_SLOTS = runtime.IS_KAKAOPAGE_READER ? runtime.MAX_PARALLEL_TRANSLATIONS - 1 : 0;
  runtime.VISIBLE_TRANSLATION_RESERVED_SLOTS = VISIBLE_TRANSLATION_RESERVED_SLOTS;
  const MANUAL_PARALLEL_TRANSLATIONS = 3;
  runtime.MANUAL_PARALLEL_TRANSLATIONS = MANUAL_PARALLEL_TRANSLATIONS;
  const MAX_PRELOAD_JOBS = 2;
  runtime.MAX_PRELOAD_JOBS = MAX_PRELOAD_JOBS;
  const PRELOAD_ROOT_MARGIN = "1400px 0px";
  runtime.PRELOAD_ROOT_MARGIN = PRELOAD_ROOT_MARGIN;
  const AGGRESSIVE_PRELOAD_JOBS = 5;
  runtime.AGGRESSIVE_PRELOAD_JOBS = AGGRESSIVE_PRELOAD_JOBS;
  const AGGRESSIVE_PRELOAD_ROOT_MARGIN = "3200px 0px";
  runtime.AGGRESSIVE_PRELOAD_ROOT_MARGIN = AGGRESSIVE_PRELOAD_ROOT_MARGIN;
  const AGGRESSIVE_PRELOAD_BATCH = 12;
  runtime.AGGRESSIVE_PRELOAD_BATCH = AGGRESSIVE_PRELOAD_BATCH;
  const AGGRESSIVE_PRELOAD_SWEEP_GAP_MS = 900;
  runtime.AGGRESSIVE_PRELOAD_SWEEP_GAP_MS = AGGRESSIVE_PRELOAD_SWEEP_GAP_MS;
  const AGGRESSIVE_PRELOAD_MAX_QUEUE = 24;
  runtime.AGGRESSIVE_PRELOAD_MAX_QUEUE = AGGRESSIVE_PRELOAD_MAX_QUEUE;
  const PAYLOAD_CACHE_TTL_MS = 90 * 1000;
  runtime.PAYLOAD_CACHE_TTL_MS = PAYLOAD_CACHE_TTL_MS;
  const MAX_PAYLOAD_CACHE = 30;
  runtime.MAX_PAYLOAD_CACHE = MAX_PAYLOAD_CACHE;
  const RECOVERY_SCAN_GAP_MS = 650;
  runtime.RECOVERY_SCAN_GAP_MS = RECOVERY_SCAN_GAP_MS;
  const RECOVERY_REQUEST_GAP_MS = 5000;
  runtime.RECOVERY_REQUEST_GAP_MS = RECOVERY_REQUEST_GAP_MS;
  const MAX_RECOVERY_TARGETS = 10;
  runtime.MAX_RECOVERY_TARGETS = MAX_RECOVERY_TARGETS;
  const IMAGE_MAX_SIDE = 1536;
  runtime.IMAGE_MAX_SIDE = IMAGE_MAX_SIDE;
  const IMAGE_JPEG_QUALITY = 0.82;
  runtime.IMAGE_JPEG_QUALITY = IMAGE_JPEG_QUALITY;
  const EMBEDDED_JPEG_QUALITY = 0.9;
  runtime.EMBEDDED_JPEG_QUALITY = EMBEDDED_JPEG_QUALITY;
  const EMBEDDED_MAX_CANVAS_PIXELS = 24 * 1000 * 1000;
  runtime.EMBEDDED_MAX_CANVAS_PIXELS = EMBEDDED_MAX_CANVAS_PIXELS;
  const EMBEDDED_MAX_ORIGINAL_BYTES = 16 * 1024 * 1024;
  runtime.EMBEDDED_MAX_ORIGINAL_BYTES = EMBEDDED_MAX_ORIGINAL_BYTES;
  const MAX_LOCAL_RESULT_CACHE = 120;
  runtime.MAX_LOCAL_RESULT_CACHE = MAX_LOCAL_RESULT_CACHE;
  const KAKAO_CANONICAL_TARGET_LANGUAGE = "zh-CN";
  runtime.KAKAO_CANONICAL_TARGET_LANGUAGE = KAKAO_CANONICAL_TARGET_LANGUAGE;
  const KAKAO_CANONICAL_SOURCE_LANGUAGE = "auto";
  runtime.KAKAO_CANONICAL_SOURCE_LANGUAGE = KAKAO_CANONICAL_SOURCE_LANGUAGE;
  const KAKAO_SEAM_CAPTURE_WIDTH_RATIO = 0.15;
  runtime.KAKAO_SEAM_CAPTURE_WIDTH_RATIO = KAKAO_SEAM_CAPTURE_WIDTH_RATIO;
  const KAKAO_SEAM_CAPTURE_MIN_PX = 64;
  runtime.KAKAO_SEAM_CAPTURE_MIN_PX = KAKAO_SEAM_CAPTURE_MIN_PX;
  const KAKAO_SEAM_CAPTURE_MAX_PX = 96;
  runtime.KAKAO_SEAM_CAPTURE_MAX_PX = KAKAO_SEAM_CAPTURE_MAX_PX;
  const KAKAO_AUTH_QUERY_PARAM_RE = /^(?:signature|credential|expires|policy|token|key-pair-id|x-amz-(?:algorithm|credential|date|expires|security-token|signature|signedheaders))$/i;
  runtime.KAKAO_AUTH_QUERY_PARAM_RE = KAKAO_AUTH_QUERY_PARAM_RE;
  const {
    KAKAO_OVERLAP_SAMPLE_WIDTH,
    KAKAO_THIN_STRIP_MIN_HEIGHT
  } = runtime.KP;
  runtime.KAKAO_OVERLAP_SAMPLE_WIDTH = KAKAO_OVERLAP_SAMPLE_WIDTH;
  runtime.KAKAO_THIN_STRIP_MIN_HEIGHT = KAKAO_THIN_STRIP_MIN_HEIGHT;
  const LOADING_OVERLAY_TIMEOUT_MS = 30000;
  runtime.LOADING_OVERLAY_TIMEOUT_MS = LOADING_OVERLAY_TIMEOUT_MS;
  const PRETRANSLATE_AHEAD_COUNT = 6;
  runtime.PRETRANSLATE_AHEAD_COUNT = PRETRANSLATE_AHEAD_COUNT;
  const RUNTIME_OWNER_ATTRIBUTE = "data-manga-translator-runtime-owner";
  runtime.RUNTIME_OWNER_ATTRIBUTE = RUNTIME_OWNER_ATTRIBUTE;
  const RUNTIME_FEATURE_ATTRIBUTE = "data-manga-translator-feature-version";
  runtime.RUNTIME_FEATURE_ATTRIBUTE = RUNTIME_FEATURE_ATTRIBUTE;
  const RUNTIME_FEATURE_VERSION = "kakao-canonical-v1";
  runtime.RUNTIME_FEATURE_VERSION = RUNTIME_FEATURE_VERSION;
  const MAX_EMBEDDED_IMAGE_CACHE = 40;
  runtime.MAX_EMBEDDED_IMAGE_CACHE = MAX_EMBEDDED_IMAGE_CACHE;
  const STATUS_INFO_THROTTLE_MS = 1200;
  runtime.STATUS_INFO_THROTTLE_MS = STATUS_INFO_THROTTLE_MS;
  const CONTEXT_INVALIDATED_RE = /extension context invalidated/i;
  runtime.CONTEXT_INVALIDATED_RE = CONTEXT_INVALIDATED_RE;
  const RENDER_MODE_OVERLAY = "overlay";
  runtime.RENDER_MODE_OVERLAY = RENDER_MODE_OVERLAY;
  const RENDER_MODE_EMBEDDED = "embedded";
  runtime.RENDER_MODE_EMBEDDED = RENDER_MODE_EMBEDDED;
  const CAPTURE_MODE_DIRECT = "direct";
  runtime.CAPTURE_MODE_DIRECT = CAPTURE_MODE_DIRECT;
  const CAPTURE_MODE_SCREENSHOT = "screenshot";
  runtime.CAPTURE_MODE_SCREENSHOT = CAPTURE_MODE_SCREENSHOT;
  const SCREENSHOT_TARGET_NOT_VISIBLE = "Target is not visible enough for screenshot capture";
  runtime.SCREENSHOT_TARGET_NOT_VISIBLE = SCREENSHOT_TARGET_NOT_VISIBLE;
  const IMAGE_RUNTIME_MESSAGE_TIMEOUT_MS = 12000;
  runtime.IMAGE_RUNTIME_MESSAGE_TIMEOUT_MS = IMAGE_RUNTIME_MESSAGE_TIMEOUT_MS;
  const IS_CMOA_SPEED_READER = /(^|\.)cmoa\.jp$/i.test(location.hostname) && /^\/bib\/speedreader\//i.test(location.pathname);
  runtime.IS_CMOA_SPEED_READER = IS_CMOA_SPEED_READER;
  const CMOA_AUTO_MIN_VISIBLE_AREA = 8000;
  runtime.CMOA_AUTO_MIN_VISIBLE_AREA = CMOA_AUTO_MIN_VISIBLE_AREA;
  const CMOA_MANUAL_MIN_VISIBLE_AREA = 2500;
  runtime.CMOA_MANUAL_MIN_VISIBLE_AREA = CMOA_MANUAL_MIN_VISIBLE_AREA;
  const BUBBLE_FONT_MIN = 10;
  runtime.BUBBLE_FONT_MIN = BUBBLE_FONT_MIN;
  const BUBBLE_FONT_MAX = 48;
  runtime.BUBBLE_FONT_MAX = BUBBLE_FONT_MAX;
  const BUBBLE_FONT_BASE_RATIO = 0.5;
  runtime.BUBBLE_FONT_BASE_RATIO = BUBBLE_FONT_BASE_RATIO;
  const BUBBLE_FONT_BINARY_STEPS = 9;
  runtime.BUBBLE_FONT_BINARY_STEPS = BUBBLE_FONT_BINARY_STEPS;
  const BUBBLE_FONT_SAFETY_SCALE = 0.9;
  runtime.BUBBLE_FONT_SAFETY_SCALE = BUBBLE_FONT_SAFETY_SCALE;
  const BUBBLE_FONT_VERTICAL_SAFETY_SCALE = 0.84;
  runtime.BUBBLE_FONT_VERTICAL_SAFETY_SCALE = BUBBLE_FONT_VERTICAL_SAFETY_SCALE;
  const BUBBLE_FONT_ORIGINAL_SCALE = 1.15;
  runtime.BUBBLE_FONT_ORIGINAL_SCALE = BUBBLE_FONT_ORIGINAL_SCALE;
  const BUBBLE_ROTATION_NEAR_HORIZONTAL = 0.75;
  runtime.BUBBLE_ROTATION_NEAR_HORIZONTAL = BUBBLE_ROTATION_NEAR_HORIZONTAL;
  const BUBBLE_ROTATION_MAX = 89;
  runtime.BUBBLE_ROTATION_MAX = BUBBLE_ROTATION_MAX;
  const MAX_FONT_FIT_CACHE = 600;
  runtime.MAX_FONT_FIT_CACHE = MAX_FONT_FIT_CACHE;
  const MODEL_IMAGE_PLACEHOLDER_BRACKET_RE = /[\[\(（【<［]\s*image\s*#?\s*\d+\s*[\]\)）】>］]/giu;
  runtime.MODEL_IMAGE_PLACEHOLDER_BRACKET_RE = MODEL_IMAGE_PLACEHOLDER_BRACKET_RE;
  const MODEL_IMAGE_PLACEHOLDER_ONLY_RE = /^image\s*#?\s*\d+$/iu;

  // Pipeline trace — 默认关闭，零性能开销
  runtime.MODEL_IMAGE_PLACEHOLDER_ONLY_RE = MODEL_IMAGE_PLACEHOLDER_ONLY_RE;
  let ENABLE_PIPELINE_TRACE = false;
  runtime.ENABLE_PIPELINE_TRACE = ENABLE_PIPELINE_TRACE;
  let ENABLE_FILTER_DEBUG = false;
  runtime.ENABLE_FILTER_DEBUG = ENABLE_FILTER_DEBUG;
  const state = {
    enabled: true,
    autoTranslatePageEnabled: false,
    pretranslateMode: "manual",
    invalidated: false,
    io: null,
    preloadIo: null,
    mo: null,
    overlayLayer: null,
    overlaysById: new Map(),
    embeddedById: new Map(),
    embeddedImageCache: new Map(),
    targetIdByElement: new WeakMap(),
    targetIdSeq: 1,
    observedTargets: new WeakSet(),
    inflightByTarget: new WeakMap(),
    queue: [],
    queueDrainScheduled: false,
    queuedTargets: new WeakSet(),
    runningJobs: 0,
    runningAheadJobs: 0,
    preloadQueue: [],
    preloadQueuedTargets: new WeakSet(),
    preloadRunningJobs: 0,
    preloadInFlightByTarget: new WeakMap(),
    aggressivePreload: runtime.IS_CMOA_SPEED_READER,
    lastAggressivePreloadSweepAt: 0,
    aggressiveSweepTimer: 0,
    overlayHideDepth: 0,
    overlayPreviousVisibility: "",
    payloadCacheByTargetKey: new Map(),
    localResultCache: new Map(),
    /** pageId 只映射当前可用 DOM 句柄；canonical/translation 事实保存在 Kakao Store。 */
    kakaoTargetsByPageId: new Map(),
    kakaoPageIdByTarget: new WeakMap(),
    kakaoImageRevisionByTarget: new WeakMap(),
    kakaoLoadListenerTargets: new WeakSet(),
    kakaoProjectionRefreshPageIds: new Set(),
    kakaoProjectionRefreshTimer: 0,
    /** registerTarget 检测到的邻页关系，在 pipeline commitPageIdentity 时触发 seam。 */
    pendingKakaoAdjacency: null,
    /** Kakao 管线 Store（由 kakao-pipeline.js 提供） */
    kakaoStore: null,
    lastRecoveryAt: 0,
    lastKakaoVisualDedupeAt: 0,
    syncRaf: 0,
    overlayFrameRaf: 0,
    syncInterval: 0,
    showFloatingBall: true,
    captureMode: runtime.CAPTURE_MODE_DIRECT,
    renderMode: runtime.RENDER_MODE_OVERLAY,
    floatingBallWrap: null,
    floatingBall: null,
    floatingBallClose: null,
    bubbleMeasureProbe: null,
    fontFitCache: new Map(),
    seamLayoutCache: new Map(),
    seamSourceModeByRenderKey: new Map(),
    termDiscoverySentKeys: new Set(),
    lastInfoStatusAt: 0,
    runtimeOwnerToken: `${Date.now()}-${Math.random().toString(36).slice(2)}`
  };

  // 初始化 Kakao 管线 Store（如可用）
  runtime.state = state;
}
