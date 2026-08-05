/**
 * Per-node loading indicators for continuous webpage translation.
 *
 * Segment state lives in JS memory (text nodes are never wrapped or marked,
 * so translation state produces no DOM signal of its own). This module is the
 * single UI entry that reconciles segment state onto small inline indicators
 * inserted right after each pending/inflight/failed text node:
 *
 *   pending | inflight → spinning dot
 *   failed            → red ↻ (retry on click) with the error in title
 *   done | blocked    → no indicator
 *
 * Reconcile is idempotent and self-healing: every state transition already
 * funnels through refreshWebpageUi(), and a stale indicator left behind by a
 * missed transition is swept on the next call. Indicators carry the
 * data-manga-translator-overlay exemption token so the page scanner/observer
 * never treats them as page content. Inline placement (after the text node)
 * keeps them clear of the text itself and of page click targets.
 */
import { updateWebpageProgress } from "./webpage-renderer.js";

export function installWebpageNodeLoading(runtime) {
  // TextNode → { element, parent }；节点强引用进 managed 供 sweep 遍历。
  const indicators = new WeakMap();
  const managed = new Set();

  function buildIndicatorElement() {
    const element = document.createElement("span");
    element.className = "mt-webpage-node-loading";
    element.dataset.mangaTranslatorOverlay = "true";
    element.setAttribute("aria-hidden", "true");
    element.appendChild(createChild("mt-webpage-node-loading-spinner"));
    element.appendChild(createChild("mt-webpage-node-loading-error", "↻"));
    return element;
  }

  function createChild(className, text = "") {
    const child = document.createElement("span");
    child.className = className;
    if (text) child.textContent = text;
    return child;
  }

  function createIndicator(node) {
    const parent = node.parentElement;
    if (!parent) return null;
    const element = buildIndicatorElement();
    // 插在文本节点之后（inline 跟随文字，不覆盖文本本身）
    parent.insertBefore(element, node.nextSibling);
    const record = { element, parent, segmentKey: "" };
    element.addEventListener("click", event => {
      // 点击刷新图标重试该段（仅失败态可点击）；阻止冒泡，避免触发
      // 父元素（链接/按钮）自身的点击导致页面跳转
      if (record.segmentKey && element.classList.contains("mt-failed")) {
        event.stopPropagation();
        event.preventDefault();
        runtime.requeueWebpageSegment?.(record.segmentKey);
      }
    });
    indicators.set(node, record);
    managed.add(node);
    return record;
  }

  function updateIndicator(record, info) {
    record.element.classList.toggle("mt-failed", info.status === "failed");
    record.element.title = info.error || "";
    if (info.segmentKey) record.segmentKey = info.segmentKey;
  }

  function removeIndicator(node) {
    const record = indicators.get(node);
    indicators.delete(node);
    managed.delete(node);
    if (!record) return;
    try {
      record.element.remove();
    } catch {
      // 页面可能已自行移除该元素。
    }
  }

  /**
   * 幂等 reconcile：从当前会话的 segments 推导期望态，创建/更新/清扫图标。
   */
  function syncWebpageNodeLoading() {
    const webpage = runtime.getWebpageState();
    const session = webpage && webpage.session;
    const desired = new Map();
    if (session) {
      for (const segment of session.segments.values()) {
        const status = segment.status.translation;
        if (status === "pending" || status === "inflight") {
          if (segment.node) desired.set(segment.node, { status: "loading", error: "", segmentKey: segment.segmentKey });
        } else if (status === "failed") {
          if (segment.node) desired.set(segment.node, {
            status: "failed",
            error: String(segment.errors?.[0]?.error || "翻译失败"),
            segmentKey: segment.segmentKey
          });
        }
        // done / blocked / 其它：无图标。
      }
    }
    for (const [node, info] of desired) {
      const record = indicators.get(node);
      if (!node || node.isConnected !== true) {
        if (record) removeIndicator(node);
        continue;
      }
      if (record) updateIndicator(record, info);
      else {
        const created = createIndicator(node);
        if (created) updateIndicator(created, info);
      }
    }
    for (const node of [...managed]) {
      if (!desired.has(node)) removeIndicator(node);
    }
  }

  function clearAllWebpageNodeLoading() {
    for (const node of [...managed]) removeIndicator(node);
  }

  runtime.syncWebpageNodeLoading = syncWebpageNodeLoading;
  runtime.clearAllWebpageNodeLoading = clearAllWebpageNodeLoading;
  runtime.refreshWebpageUi = () => {
    updateWebpageProgress(runtime, runtime.getWebpageState());
    syncWebpageNodeLoading();
  };
}
