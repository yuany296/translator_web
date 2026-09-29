// Chromium 对行内 style 的**单个 CSS 值**有约 2MB 的静默上限：setProperty 写入
// 超限值不抛错、不告警，但 getPropertyValue 读回永远是空串。RIDI 高清分片的
// 清理图 dataURL 有 3.9~4.4MB，直接 `url("data:...")` 写 --mt-cleaned-image 必然
// 静默失败 → 变量恒为空 → 无遮罩；小分片不触线就有遮罩 —— 这正是「同一章里
// 有些分片有清理图、有些没有」的最终根源（KakaoPage 分片小，从未触线）。
// 所以所有写 --mt-cleaned-image 的地方必须统一走 runtime.maskCssValue：短图原样
// 返回 url("data:...")（行为不变），长图同步转 Blob + Object URL（值约 60 字符）。
const MASK_INLINE_STYLE_SAFE_LIMIT = 1500000; // 实测临界在 2M~3M 之间，留足安全余量
const MASK_BLOB_URL_CACHE_LIMIT = 16;

/** dataURL → Object URL；任何一步失败都返回 ""，由调用方兜底回原样（宁可原样，不崩）。 */
function dataUrlToObjectUrl(dataUrl) {
  try {
    const comma = dataUrl.indexOf(",");
    if (comma < 0) return "";
    const meta = dataUrl.slice(5, comma); // e.g. "image/png;base64"
    const mime = meta.split(";")[0] || "image/png";
    const body = dataUrl.slice(comma + 1);
    let bytes;
    if (/;base64/i.test(meta)) {
      const binary = atob(body);
      bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    } else {
      bytes = new TextEncoder().encode(decodeURIComponent(body));
    }
    if (typeof URL === "undefined" || typeof URL.createObjectURL !== "function") return "";
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
  } catch {
    return "";
  }
}

export function installRendererMask(runtime) {
  // 转换结果按 dataURL 字符串本身缓存（Map 持引用即可，调用方本来就持有它，无额外
  // 大内存）：同一张图每次返回同一个 blob:URL，写入幂等，调用方「值没变就不重写」
  // 的比较才能稳定成立 —— 否则 syncOverlayPosition 会陷入每帧重写的死循环。
  const maskBlobUrlCache = new Map();

  /**
   * 把清理图 dataURL 转成可安全写进行内样式的 CSS url(...) 值；非 dataURL 返回 ""。
   */
  function maskCssValue(dataUrl) {
    const raw = String(dataUrl || "");
    if (!runtime.isDataUrl(raw)) return "";
    if (raw.length <= MASK_INLINE_STYLE_SAFE_LIMIT) return `url("${raw}")`;
    let blobUrl = maskBlobUrlCache.get(raw);
    if (blobUrl) {
      // LRU 触碰：命中后挪到最新端，淘汰时才是真正的「最久未用优先」。
      maskBlobUrlCache.delete(raw);
      maskBlobUrlCache.set(raw, blobUrl);
      return `url("${blobUrl}")`;
    }
    blobUrl = dataUrlToObjectUrl(raw);
    if (!blobUrl) return `url("${raw}")`;
    maskBlobUrlCache.set(raw, blobUrl);
    // 超出上限时 revoke 并淘汰最旧的 Object URL，避免长会话里句柄泄漏。
    while (maskBlobUrlCache.size > MASK_BLOB_URL_CACHE_LIMIT) {
      const oldestKey = maskBlobUrlCache.keys().next().value;
      const oldestUrl = maskBlobUrlCache.get(oldestKey);
      maskBlobUrlCache.delete(oldestKey);
      try {
        URL.revokeObjectURL(oldestUrl);
      } catch {
        // revoke 只是回收资源，失败不影响遮罩本身。
      }
    }
    return `url("${blobUrl}")`;
  }
  runtime.maskCssValue = maskCssValue;

  /**
   * 把页级清理图（inpainted 遮罩图）直接绑到这一页的覆盖层 DOM 上。
   *
   * 为什么不能只靠"再渲染一遍"：清理图是**页级异步产物**，覆盖层永远先上屏。
   * 上游两条链路（投影计划的 cleaned artifact pass、渲染侧的 requestMissingPageMask）
   * 都把 `handle.cleanedImageArtifactKey === artifactKey` 当成"这一页的遮罩已经有了"，
   * 命中缓存就直接返回 —— 可那一刻 DOM 上画的还是"没有遮罩"的那一版，而且图是
   * 这一轮稍后才落地的，没有任何人再回来补画。用户看到的就是同一章里
   * "有些分片有清理图、有些没有"。
   *
   * 跨页（seam）覆盖层从来不缺遮罩，正是因为它的 surface 在拿到清理图之前
   * 根本不会被渲染（inspectSeamSurfaceRenderability）。这里给逐页覆盖层补上
   * 等价的确定性：以 DOM 为准，谁有图就给谁画上。
   *
   * 逐 bubble 的 background-size/position 在创建节点时已按页面坐标算好
   * （见 lifecycle-bubble.js），所以 root 级变量对层里每一枚 bubble 都成立；
   * 图里没被 inpaint 的区域显示的就是原图像素，与"透明"等价，不会更糟。
   */
  function applyCleanedImageToPageOverlays(pageId, cleanedImage) {
    const key = String(pageId || "");
    if (!key || !runtime.isDataUrl(cleanedImage)) return 0;
    const overlays = runtime.state && runtime.state.overlaysById;
    if (!overlays || typeof overlays.forEach !== "function") return 0;
    const url = runtime.maskCssValue(cleanedImage);
    if (!url) return 0;
    let applied = 0;
    let seen = 0;
    overlays.forEach(overlayState => {
      if (!overlayState || !overlayState.root) return;
      if (overlayPageId(runtime, overlayState) !== key) return;
      seen += 1;
      const style = overlayState.root.style;
      if (!style || typeof style.setProperty !== "function" ||
          typeof style.getPropertyValue !== "function") return;
      if (style.getPropertyValue("--mt-cleaned-image") === url) return;
      style.setProperty("--mt-cleaned-image", url);
      // 与 syncOverlayPosition 的校准口径保持一致：状态里也记上，否则下一次
      // 位置同步会按"这一层没有清理图"把刚画上去的遮罩撤掉。
      overlayState.cleanedImage = String(cleanedImage);
      applied += 1;
    });
    traceMaskEvent(key, "bind", { applied, seen, connected: true });
    if (applied > 0) publishMaskBind(key, applied);
    else if (seen === 0) traceMaskEvent(key, "bind-no-overlay", {});
    return applied;
  }
  runtime.applyCleanedImageToPageOverlays = applyCleanedImageToPageOverlays;

  /**
   * canonical store 里这一页此刻的清理图；没有就返回 ""。
   *
   * 渲染侧建 root 时用它兜底：`result.cleanedImage` 是「渲染那一刻的快照」，而清理图
   * 是异步产物 —— 图落地时这一版投影往往已经画完，绑过一次的 root 又可能已被重建。
   * 直接问 store「这一页现在有没有图」是唯一不依赖时序的取法。
   */
  function getPageCleanedImage(pageId) {
    const key = String(pageId || "");
    if (!key) return "";
    const store = runtime.state && runtime.state.kakaoStore;
    if (!store || typeof store.getPageHandle !== "function") return "";
    const handle = store.getPageHandle(key);
    const image = handle && handle.cleanedImage;
    return runtime.isDataUrl(image) ? String(image) : "";
  }
  runtime.getPageCleanedImage = getPageCleanedImage;
  // 遮罩现场取证。
  //
  // 「这一页到底有没有清理图」有四层：上游判定（data-mt-mask-report）、补绑
  // （data-mt-mask-bind）、渲染带入（data-mt-mask-render 的 in）、DOM 实况（out）。
  // 四层不一致就说明图在中途被抹掉了，但光看计数分不清是"绑定没匹配到覆盖层"
  // 还是"绑上了又被重建的 root 换掉"。这里按时间顺序记一条环形流水：
  // 谁写了、谁撤了、撤的时候 overlayState.cleanedImage 是什么、root 是不是同一个。
  const maskEvents = [];
  function traceMaskEvent(pageId, ev, extra) {
    try {
      const shortId = String(pageId || "").replace(/^page-/, "").slice(0, 8);
      maskEvents.push({ t: Date.now() % 1000000, p: shortId, ev, ...(extra || {}) });
      while (maskEvents.length > 80) maskEvents.shift();
      if (typeof document === "undefined" || !document || !document.documentElement) return;
      document.documentElement.dataset.mtMaskTrace = JSON.stringify(maskEvents);
    } catch {
      // 取证属性只是便利设施
    }
  }
  runtime.traceMaskEvent = traceMaskEvent;
}

// 绑定的现场证据。data-mt-mask-render 的 out 记的是**最后一次渲染**时图在不在，
// 补绑之后它可能仍然是 0；这个属性记的是"到底哪几页被补画了"，用来区分
// "链路没走到"和"走到了但诊断属性还停在上一轮"。
const maskBindByPage = new Map();
function publishMaskBind(pageId, applied) {
  if (typeof document === "undefined" || !document || !document.documentElement) return;
  const shortId = String(pageId).replace(/^page-/, "").slice(0, 8);
  maskBindByPage.set(shortId, (maskBindByPage.get(shortId) || 0) + applied);
  while (maskBindByPage.size > 24) maskBindByPage.delete(maskBindByPage.keys().next().value);
  document.documentElement.dataset.mtMaskBind =
    JSON.stringify([...maskBindByPage.entries()].map(([p, n]) => ({ p, n })));
}

function overlayPageId(runtime, overlayState) {
  if (!overlayState) return "";
  // 以**当前**的 target → pageId 绑定为准，overlayState.pageId 只是建 root 那一刻的快照。
  //
  // RIDI 分片阅读器换图时是「同一个 <img> 元素原地换页」：新图有新的 pageId 与新的
  // imageRevision，可这个 target 的 targetId 没变，覆盖层也不会重建，于是
  // overlayState.pageId 永远停在旧页。清理图是按 pageId 补绑的
  // （canonical 层拿到图的那一刻才绑），一旦两个 pageId 对不上：
  //   · 新页的图绑不上去 —— overlayPageId 返回旧 pageId，匹配失败被跳过，
  //     可见的那一层永远没有遮罩；
  //   · 旧页的图反而写进这个 target 的层，而旧页此刻多半已经 display:none。
  // 现场表现正是「同一章里有些分片有清理图、有些没有」。
  const live = livePageId(runtime, overlayState.target);
  if (live) return live;
  return String(overlayState.pageId || "");
}

/** 这个 target 此刻绑在哪一页；没有绑定时返回 ""。 */
function livePageId(runtime, target) {
  if (!target || !runtime.state || !runtime.state.kakaoPageIdByTarget) return "";
  return String(runtime.state.kakaoPageIdByTarget.get(target) || "");
}
