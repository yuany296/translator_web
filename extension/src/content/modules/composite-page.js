/**
 * 「一整页 = 一个容器 + 若干瓦片图」的站点能力（站点提示里的 `pageComposite`）。
 *
 * CMOA 的 speedreader 把一页切成 3 条横向瓦片（`.pt-img` 下 3 个 `img`，各 617x293，
 * 天然图 1127x536），瓦片边界与页边界无关。按瓦片各跑一次 OCR 有两层代价：
 * 跨瓦片的竖排台词被拦腰截断（上片读半句、下片读半句，各自翻译），以及一页挂 3 个
 * 覆盖层（滚动/翻页时它们各自为政）。这里把容器的瓦片按**版面位置**拼成一张整页图，
 * 一页只跑一次 OCR；百分比坐标仍然落在同一个容器上，覆盖层天然是整页的。
 *
 * 与 `tiledStrip`（KakaoPage/RIDI）的区别是**一层结构事实**：分片长条的一整章是一条
 * 连续长图，切片边界必须靠接缝 OCR 才能拼回台词；而这里的瓦片边界在页内部，把瓦片
 * 拼回整页之后根本不存在需要靠接缝去猜的边界，所以走上限更低的一条路。
 */
export function installCompositePage(runtime) {
  /** 站点声明了「整页容器」能力时的容器选择器；没声明返回空串（其余站点零影响）。 */
  function compositePageSelector() {
    const profile = runtime.readerProfile;
    return profile && profile.pageComposite === true ? String(profile.targetSelector || "") : "";
  }
  runtime.compositePageSelector = compositePageSelector;
  /** 目标所属的整页容器（自身是容器就返回自身）；没有这个能力时返回 null。 */
  function compositePageTargetOf(target) {
    const selector = compositePageSelector();
    if (!selector || !target || typeof target.closest !== "function") return null;
    if (typeof target.matches === "function" && target.matches(selector)) return target;
    return target.closest(selector);
  }
  runtime.compositePageTargetOf = compositePageTargetOf;
  function isCompositePageTarget(target) {
    return Boolean(target) && compositePageTargetOf(target) === target;
  }
  runtime.isCompositePageTarget = isCompositePageTarget;
  /**
   * 容器的瓦片图，按文档顺序 —— 站点按上→下排布瓦片，所以 DOM 顺序就是版面顺序。
   * 排除扩展自己画的层：覆盖层与跨页层就挂在同一个容器里，把它们画进整页图会自我叠加。
   */
  function compositePageBands(target) {
    if (!isCompositePageTarget(target)) return [];
    return Array.from(target.querySelectorAll("img")).filter(img => (img.naturalWidth || 0) > 0
      && !img.closest(".mt-overlay-layer") && !img.closest(".mt-cross-page-root")
      && !img.closest("[data-manga-translator-overlay]"));
  }
  runtime.compositePageBands = compositePageBands;
  /**
   * 目标身份：瓦片集合（数量 + 每一片的 URL）就是这一页的身份。
   * 阅读器回收 DOM 给新页时瓦片的 blob URL 会换，身份随之变化 → 旧页的缓存/覆盖层按
   * 既有的 sourceToken 变更路径作废。这里**不**掺版面尺寸：尺寸变化不该让译文重跑。
   */
  function compositePageSourceToken(target) {
    const bands = compositePageBands(target);
    return bands.length === 0 ? "" : `page-composite:${bands.length}|${bands.map(img => runtime.resolveImageUrl(img)).join("|")}`;
  }
  runtime.compositePageSourceToken = compositePageSourceToken;
  /**
   * 瓦片还在加载时挂一次 load 监听：瓦片齐了要重新入队，否则 IntersectionObserver
   * 不会为同一个容器再触发一次，这一页就永远停在「采集时瓦片不全」的状态。
   */
  function watchCompositePageBands(target) {
    if (!isCompositePageTarget(target)) return;
    Array.from(target.querySelectorAll("img")).forEach(img => {
      if (img.complete || !runtime.state || !runtime.state.kakaoLoadListenerTargets) return;
      if (runtime.state.kakaoLoadListenerTargets.has(img)) return;
      runtime.state.kakaoLoadListenerTargets.add(img);
      img.addEventListener("load", () => {
        runtime.state.kakaoLoadListenerTargets.delete(img);
        runtime.registerTarget(target);
        if (runtime.state.autoTranslatePageEnabled && runtime.state.enabled && target.isConnected) {
          runtime.queuePageAutoTranslate(target);
        }
      }, { once: true });
      img.addEventListener("error", () => runtime.state.kakaoLoadListenerTargets.delete(img), { once: true });
    });
  }
  runtime.watchCompositePageBands = watchCompositePageBands;
  /**
   * 整页采集：把瓦片按版面位置画进一张画布。
   *
   * 分辨率取瓦片自身的 natural/CSS 比（与单图路径 getRenderedImageSize 同口径：让 OCR
   * 输入与页面观感一致），再受 IMAGE_MAX_SIDE 限制。百分比坐标与分辨率无关，所以这个
   * 缩放不影响覆盖层对位 —— 但会决定 OCR 认不认得出小字，别把它降成视口分辨率。
   */
  async function extractCompositePagePayload(target) {
    const rect = target.getBoundingClientRect();
    const bands = compositePageBands(target);
    if (!(rect.width > 1 && rect.height > 1) || bands.length === 0) {
      throw new Error(runtime.SCREENSHOT_TARGET_NOT_VISIBLE);
    }
    const firstRect = bands[0].getBoundingClientRect();
    const naturalScale = firstRect.width > 0 ? Number(bands[0].naturalWidth || firstRect.width) / firstRect.width : 1;
    const maxSide = Math.max(1, Number(runtime.IMAGE_MAX_SIDE) || 1536);
    const scale = Math.max(1, Math.min(naturalScale, maxSide / Math.max(rect.width, rect.height)));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(rect.width * scale));
    canvas.height = Math.max(1, Math.round(rect.height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas context is unavailable");
    context.imageSmoothingEnabled = true;
    context.imageSmoothingQuality = "high";
    bands.forEach(band => {
      const bandRect = band.getBoundingClientRect();
      if (!(bandRect.width > 0 && bandRect.height > 0)) return;
      context.drawImage(band, Math.round((bandRect.left - rect.left) * scale), Math.round((bandRect.top - rect.top) * scale), Math.round(bandRect.width * scale), Math.round(bandRect.height * scale));
    });
    let dataUrl = "";
    try {
      dataUrl = canvas.toDataURL("image/jpeg", runtime.IMAGE_JPEG_QUALITY);
    } catch (error) {
      // 画布被跨域污染（瓦片不是同源 blob）时退回可见区截图；整页往往高出视口，
      // captureVisibleTargetPayload 会报 SCREENSHOT_TARGET_NOT_VISIBLE 交给重试机制，
      // 等用户自然滚到那里再采一次，而不是把这一页记成失败。
      return runtime.captureVisibleTargetPayload(target, error, "page-composite-crop");
    }
    if (!runtime.isDataUrl(dataUrl)) {
      throw new Error("Composite page capture failed");
    }
    return {
      dataUrl,
      imageUrl: compositePageSourceToken(target).slice(0, 120),
      width: canvas.width,
      height: canvas.height,
      cssWidth: rect.width,
      cssHeight: rect.height,
      source: "page-composite"
    };
  }
  runtime.extractCompositePagePayload = extractCompositePagePayload;
  /**
   * 目标身份里「媒体就绪了吗」的统一判据（canonical 重试调度器读它）。
   * 整页容器没有 complete/naturalWidth，必须换成「瓦片齐了 + 这一页仍然受理」。
   */
  function isTargetMediaReady(target) {
    if (isCompositePageTarget(target)) {
      return runtime.passesTargetFilter(target, true) && compositePageBands(target).length > 0;
    }
    return target instanceof HTMLImageElement && target.complete && runtime.passesTargetFilter(target, true);
  }
  runtime.isTargetMediaReady = isTargetMediaReady;
}
