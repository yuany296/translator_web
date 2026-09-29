const BLANK_PLACEHOLDER_URL_RE = /^data:image\/svg\+xml(?:;[^,]*)?,/i;

export function installTargetIdentity(runtime) {
  /**
   * 懒加载占位图判定：RIDI 给每个未加载分片放一张**空** SVG
   * （`data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E`）。
   * 它显示尺寸与真页一致（720x720），natural 300x150，能骗过所有按尺寸/比例设的
   * 门禁，最终被当成一张「无文字漫画页」走完整条 OCR→翻译链路；更糟的是这些 data URL
   * 完全相同，所有占位图会塌缩成同一个 pageId，使该 page 的 target 绑定反复易主。
   * 判据只认「没有任何子元素的 SVG」：真图标/插画（含 path/rect/image 等）不受影响。
   */
  function isBlankPlaceholderImage(target) {
    if (!(target instanceof HTMLImageElement)) {
      return false;
    }
    const url = runtime.resolveImageUrl(target);
    if (!BLANK_PLACEHOLDER_URL_RE.test(url)) {
      return false;
    }
    const commaIndex = url.indexOf(",");
    const header = url.slice(0, commaIndex);
    const body = url.slice(commaIndex + 1);
    let svg = "";
    try {
      svg = /;base64/i.test(header) ? atob(body) : decodeURIComponent(body);
    } catch {
      return false;
    }
    return svg.replace(/<\/?svg\b[^>]*>/gi, "").trim().length === 0;
  }
  runtime.isBlankPlaceholderImage = isBlankPlaceholderImage;

  /**
   * 阅读顺序基准（布局坐标，与滚动无关）。
   *
   * 旧口径 `rect.top + window.scrollY` 在「内容放进内层滚动容器 + 虚拟化」的阅读器里
   * （RIDI 用 SimpleBar，window.scrollY 恒为 0）会退化成「采集那一刻的视口位置」：
   * 滚动时同一分片的值会变，多个分片还会互相打平，只能按 pageId 哈希排序。而下游
   * （reconciler 判定接缝上下页、按章排列分片）依赖它单调稳定。offsetTop 链是布局
   * 坐标：既不受滚动影响，也不受 transform 影响（RIDI 用 matrix 平移内容做虚拟化）。
   */
  function resolveReadingOrderTop(target) {
    let top = 0;
    let node = target;
    let guard = 0;
    while (node && node.nodeType === 1 && guard < 64) {
      top += Number(node.offsetTop) || 0;
      node = node.offsetParent;
      guard += 1;
    }
    if (top > 0) {
      return top;
    }
    const rect = target && typeof target.getBoundingClientRect === "function" ? target.getBoundingClientRect() : null;
    let offset = Number(rect && rect.top) || 0;
    const root = typeof document !== "undefined" ? document.documentElement : null;
    const body = typeof document !== "undefined" ? document.body : null;
    let ancestor = target && target.parentElement;
    while (ancestor && ancestor !== root && ancestor !== body) {
      offset += Number(ancestor.scrollTop) || 0;
      ancestor = ancestor.parentElement;
    }
    return offset + (Number(typeof window !== "undefined" && window.scrollY) || 0);
  }
  runtime.resolveReadingOrderTop = resolveReadingOrderTop;
}
