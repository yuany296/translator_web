export function installPipeline17(runtime) {
  /* =================================================================
   * 常量 — 全部从 content.js 原值迁移，本轮不调整
   * ================================================================= */
  const KAKAO_STITCH_MAX_CONTEXT_PX = 480;
  runtime.KAKAO_STITCH_MAX_CONTEXT_PX = KAKAO_STITCH_MAX_CONTEXT_PX;
  const KAKAO_STITCH_MIN_CONTEXT_PX = 96;
  runtime.KAKAO_STITCH_MIN_CONTEXT_PX = KAKAO_STITCH_MIN_CONTEXT_PX;
  const KAKAO_STITCH_CONTEXT_CSS_PX = 360;
  runtime.KAKAO_STITCH_CONTEXT_CSS_PX = KAKAO_STITCH_CONTEXT_CSS_PX;
  const KAKAO_STITCH_CONTEXT_HEIGHT_RATIO = 0.35;
  runtime.KAKAO_STITCH_CONTEXT_HEIGHT_RATIO = KAKAO_STITCH_CONTEXT_HEIGHT_RATIO;
  const KAKAO_STITCH_MAX_SEAM_GAP_CSS_PX = 32;
  runtime.KAKAO_STITCH_MAX_SEAM_GAP_CSS_PX = KAKAO_STITCH_MAX_SEAM_GAP_CSS_PX;
  const KAKAO_STITCH_MIN_WIDTH_RATIO = 0.82;
  runtime.KAKAO_STITCH_MIN_WIDTH_RATIO = KAKAO_STITCH_MIN_WIDTH_RATIO;
  const KAKAO_SHORT_PAGE_ATTACH_CSS_HEIGHT = 420;
  runtime.KAKAO_SHORT_PAGE_ATTACH_CSS_HEIGHT = KAKAO_SHORT_PAGE_ATTACH_CSS_HEIGHT;
  const KAKAO_SHORT_PAGE_ATTACH_HEIGHT_RATIO = 0.45;
  runtime.KAKAO_SHORT_PAGE_ATTACH_HEIGHT_RATIO = KAKAO_SHORT_PAGE_ATTACH_HEIGHT_RATIO;
  const KAKAO_OVERLAP_SAMPLE_WIDTH = 96;
  runtime.KAKAO_OVERLAP_SAMPLE_WIDTH = KAKAO_OVERLAP_SAMPLE_WIDTH;
  const KAKAO_OVERLAP_MIN_RATIO = 0.28;
  runtime.KAKAO_OVERLAP_MIN_RATIO = KAKAO_OVERLAP_MIN_RATIO;
  const KAKAO_OVERLAP_MAX_RATIO = 0.88;
  runtime.KAKAO_OVERLAP_MAX_RATIO = KAKAO_OVERLAP_MAX_RATIO;
  const KAKAO_OVERLAP_MAX_MAE = 12;
  runtime.KAKAO_OVERLAP_MAX_MAE = KAKAO_OVERLAP_MAX_MAE;
  const KAKAO_OVERLAP_MIN_INFORMATIVE_RATIO = 0.002;
  runtime.KAKAO_OVERLAP_MIN_INFORMATIVE_RATIO = KAKAO_OVERLAP_MIN_INFORMATIVE_RATIO;
  const KAKAO_OVERLAP_MAX_INFORMATIVE_MAE = 32;
  runtime.KAKAO_OVERLAP_MAX_INFORMATIVE_MAE = KAKAO_OVERLAP_MAX_INFORMATIVE_MAE;
  const KAKAO_OVERLAP_MIN_INFORMATIVE_SPAN_RATIO = 0.25;
  runtime.KAKAO_OVERLAP_MIN_INFORMATIVE_SPAN_RATIO = KAKAO_OVERLAP_MIN_INFORMATIVE_SPAN_RATIO;
  const KAKAO_OVERLAP_INFORMATIVE_LUMA = 245;
  runtime.KAKAO_OVERLAP_INFORMATIVE_LUMA = KAKAO_OVERLAP_INFORMATIVE_LUMA;
  const KAKAO_OVERLAP_INFORMATIVE_DIFF = 10;
  runtime.KAKAO_OVERLAP_INFORMATIVE_DIFF = KAKAO_OVERLAP_INFORMATIVE_DIFF;
  const KAKAO_OVERLAP_MIN_UNIQUE_PX = 220;
  runtime.KAKAO_OVERLAP_MIN_UNIQUE_PX = KAKAO_OVERLAP_MIN_UNIQUE_PX;
  const KAKAO_OVERLAP_MIN_UNIQUE_RATIO = 0.22;
  runtime.KAKAO_OVERLAP_MIN_UNIQUE_RATIO = KAKAO_OVERLAP_MIN_UNIQUE_RATIO;
  const KAKAO_THIN_STRIP_MAX_NATURAL_HEIGHT = 100;
  runtime.KAKAO_THIN_STRIP_MAX_NATURAL_HEIGHT = KAKAO_THIN_STRIP_MAX_NATURAL_HEIGHT;
  const KAKAO_THIN_STRIP_MIN_HEIGHT = 8;
  runtime.KAKAO_THIN_STRIP_MIN_HEIGHT = KAKAO_THIN_STRIP_MIN_HEIGHT;
  const KAKAO_SHORT_PAGE_ATTACHMENT_TIMEOUT_MS = 8000;
  runtime.KAKAO_SHORT_PAGE_ATTACHMENT_TIMEOUT_MS = KAKAO_SHORT_PAGE_ATTACHMENT_TIMEOUT_MS;
  const KAKAO_GEOMETRY_DUPLICATE_MIN_INTERSECTION = 0.72;
  runtime.KAKAO_GEOMETRY_DUPLICATE_MIN_INTERSECTION = KAKAO_GEOMETRY_DUPLICATE_MIN_INTERSECTION;
  const KAKAO_GEOMETRY_DUPLICATE_MIN_AREA_RATIO = 0.35;
  runtime.KAKAO_GEOMETRY_DUPLICATE_MIN_AREA_RATIO = KAKAO_GEOMETRY_DUPLICATE_MIN_AREA_RATIO;
  const KAKAO_STITCH_MIN_CROSS_PX = 16;
  runtime.KAKAO_STITCH_MIN_CROSS_PX = KAKAO_STITCH_MIN_CROSS_PX;
  const KAKAO_STITCH_MIN_CROSS_RATIO = 0.008;

  /**
   * Canonical 链路只描述真实处理阶段。旧 PagePhase 继续供非目标链路兼容，
   * Kakao direct-overlay 不再进入 stitch / destructive-dedupe 阶段。
   */
  runtime.KAKAO_STITCH_MIN_CROSS_RATIO = KAKAO_STITCH_MIN_CROSS_RATIO;
  const CanonicalPhase = Object.freeze({
    WAITING: "waiting",
    FETCHING: "fetching",
    PAGE_OCR: "page_ocr",
    OBSERVING: "observing",
    SEAM_OCR: "seam_ocr",
    RECONCILING: "reconciling",
    TRANSLATING: "translating",
    PROJECTING: "projecting",
    RENDERING: "rendering",
    RENDERED: "rendered",
    RETRY_WAIT: "retry_wait",
    CANCELLED: "cancelled",
    FAILED: "failed"
  });
  runtime.CanonicalPhase = CanonicalPhase;
  const KAKAO_EDGE_WAIT_TIMEOUT_MS = 8000;
  runtime.KAKAO_EDGE_WAIT_TIMEOUT_MS = KAKAO_EDGE_WAIT_TIMEOUT_MS;
  const KAKAO_CLEANED_ARTIFACT_RETRY_COOLDOWN_MS = 5000;
  runtime.KAKAO_CLEANED_ARTIFACT_RETRY_COOLDOWN_MS = KAKAO_CLEANED_ARTIFACT_RETRY_COOLDOWN_MS;
  const KAKAO_CLEANED_ARTIFACT_AUTO_RETRY_LIMIT = 1;
  runtime.KAKAO_CLEANED_ARTIFACT_AUTO_RETRY_LIMIT = KAKAO_CLEANED_ARTIFACT_AUTO_RETRY_LIMIT;
  const KAKAO_SEAM_HEIGHT_WIDTH_RATIO = 0.15;
  runtime.KAKAO_SEAM_HEIGHT_WIDTH_RATIO = KAKAO_SEAM_HEIGHT_WIDTH_RATIO;
  const KAKAO_SEAM_HEIGHT_MIN_PX = 64;
  runtime.KAKAO_SEAM_HEIGHT_MIN_PX = KAKAO_SEAM_HEIGHT_MIN_PX;
  const KAKAO_SEAM_HEIGHT_MAX_PX = 96;
  runtime.KAKAO_SEAM_HEIGHT_MAX_PX = KAKAO_SEAM_HEIGHT_MAX_PX;
  const KAKAO_CANONICAL_TARGET_LANGUAGE = "zh-CN";

  /* =================================================================
   * PagePhase — 有限状态机状态定义
   * ================================================================= */
  runtime.KAKAO_CANONICAL_TARGET_LANGUAGE = KAKAO_CANONICAL_TARGET_LANGUAGE;
  const PagePhase = Object.freeze({
    /** 初始等待 */
    WAITING: "waiting",
    /** 正在获取图片数据 */
    FETCHING: "fetching",
    /** 图片数据就绪 */
    FETCHED: "fetched",
    /** 正在拼接相邻页 */
    STITCHING: "stitching",
    /** 拼接完成 */
    STITCHED: "stitched",
    /** 正在 OCR / 翻译（与 background.js 通信） */
    RECOGNIZING: "recognizing",
    /** OCR / 翻译完成 */
    RECOGNIZED: "recognized",
    /** 正在全局去重 */
    DEDUPING: "deduping",
    /** 去重完成 */
    DEDUPED: "deduped",
    /** 正在渲染 */
    RENDERING: "rendering",
    /** 渲染完成 */
    RENDERED: "rendered",
    /** 已取消（DOM 复用/源变化/扩展卸载） */
    CANCELLED: "cancelled",
    /** 等待重试 */
    RETRY_WAIT: "retry_wait",
    /** 最终失败（重试耗尽） */
    FAILED: "failed",
    /** 合法正向转换表 */
    transitions: Object.freeze({
      waiting: ["fetching", "deduping", "cancelled", "failed"],
      fetching: ["fetched", "retry_wait", "cancelled", "failed"],
      fetched: ["stitching", "recognizing", "cancelled", "failed"],
      stitching: ["stitched", "retry_wait", "cancelled", "failed"],
      stitched: ["recognizing", "cancelled", "failed"],
      recognizing: ["recognized", "retry_wait", "cancelled", "failed"],
      recognized: ["deduping", "cancelled", "failed"],
      deduping: ["deduped", "cancelled", "failed"],
      deduped: ["rendering", "cancelled", "failed"],
      rendering: ["rendered", "cancelled", "failed"],
      rendered: ["cancelled"],
      cancelled: [],
      retry_wait: ["waiting", "cancelled", "failed"],
      failed: ["cancelled"]
    })
  });

  /** 检查 FSM 转换是否合法 */
  runtime.PagePhase = PagePhase;
}
