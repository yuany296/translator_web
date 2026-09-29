/**
 * RIDI（ridibooks.com）小说阅读器的正文适配。
 *
 * 与 KakaoPage 的差别只有两处，其余（切块、翻译、渲染、缓存）完全共用：
 *   1. 正文不是 shadow DOM，而是 `#viewer_contents` 里一段普通 DOM；
 *   2. 段落**没有任何标识**（KakaoPage 的 EPUB 阅读器会打 `data-p-id`），
 *      所以段落身份必须由我们盖章：把内容哈希写到 `data-mt-novel-pid`。
 *
 * 为什么段落 id 用内容哈希而不是「第几段」：RIDI 的正文是 EPUB 分节
 * （`webview-cache-epub.ridibooks.com/{话id}/epub/Section0001.xhtml.json`），
 * 长章节会随滚动加载后续分节，同一段在 DOM 里的序号会变；内容寻址的 id 让
 * 「同一段」在任何时刻都是同一个 id，译文与缓存不会因为序号漂移而认错段落。
 * 内容相同的段落靠 `#序号` 区分，与 Kakao 侧同一套 id 形状。
 *
 * 容器选择不看类名：RIDI 的类名是构建期哈希（`css-hafgtc` / `_container_d25rb_1`），
 * 换一次构建就变。判据只有结构——`#viewer_contents` 里「块级段落最多的一条直接子树」。
 */
import { RIDI_HOST_RE } from "../../shared/novel-hosts.js";

const RIDI_VIEWER_ROOT_SELECTOR = "#viewer_contents";
const RIDI_BLOCK_SELECTOR = "h1, h2, h3, h4, h5, h6, p";
const RIDI_MIN_PARAGRAPHS = 2;
// 单章段落数上限：只用于防御异常页面（例如整站 SPA 误判），正常长篇远低于此。
const RIDI_MAX_PARAGRAPHS = 4000;
const RIDI_SERIES_LINK_SELECTOR = '#viewer a[href*="/library/books/"]';

export function installRidiNovelReader(runtime) {
  function isRidiHost() {
    // globalThis 取法：Node 测试环境里没有 location 这个全局，裸引用会直接
    // ReferenceError（而表面发现一定是「Kakao 找不到才轮到 RIDI」）。
    return runtime.IS_RIDI_READER === true || RIDI_HOST_RE.test(String(globalThis.location?.hostname || ""));
  }

  function findRidiViewerRoot() {
    return document?.querySelector?.(RIDI_VIEWER_ROOT_SELECTOR) || null;
  }

  /**
   * 同一份正文可能被渲染不止一次（阅读器的测量副本/翻页副本/评论引用块）。
   * 按「`#viewer_contents` 的直接子树」分组，只取块数最多的那一条，避免把
   * 同一段正文抽两遍、翻两遍、渲染两遍。
   */
  function pickRidiBranch(viewerRoot, blocks) {
    const groups = new Map();
    for (const block of blocks.slice(0, RIDI_MAX_PARAGRAPHS)) {
      let branch = block;
      while (branch.parentElement && branch.parentElement !== viewerRoot) {
        branch = branch.parentElement;
      }
      const key = branch === viewerRoot ? viewerRoot : branch;
      const list = groups.get(key);
      if (list) list.push(block);
      else groups.set(key, [block]);
    }
    let best = null;
    for (const [branch, list] of groups) {
      if (!best || list.length > best.list.length) best = { branch, list };
    }
    if (!best || best.list.length < RIDI_MIN_PARAGRAPHS) return null;
    // 分页模式下每条分支里可能还有一层包装，容器取这些块的最近公共祖先，
    // 保证 container 与 paragraphs 覆盖的是同一份内容。
    return { container: runtime.findCommonNovelAncestor(best.list, best.branch), blocks: best.list };
  }

  /**
   * 给段落盖内容锚点，并生成与 Kakao 侧同形状的段落身份。
   * 只写值有变化时才 setAttribute：本函数每次 reconcile 都会跑（80ms 去抖 + 悬浮球
   * 状态刷新），无谓的写入会变成观察器上的噪声。
   *
   * **空段落（`<p><br></p>`）不算段落**：RIDI 的 EPUB 用它当空行，真机取证里一个
   * 短章 88 个块里有 51 个是空的。把它们算进 chapter.paragraphs 会让缓存覆盖率
   * （analyzeNovelCacheStatus 按段落总数算命中）永远到不了「完整」，进度分母也跟着
   * 虚高，而它们本来就不会被送去翻译（getTranslatableParagraphs 过滤空文本）。
   */
  function stampRidiParagraphs(blocks, attribute) {
    const occurrences = new Map();
    const paragraphs = [];
    for (const node of blocks) {
      if (runtime.hasNestedNovelParagraph(node, attribute)) continue;
      const originalText = runtime.getOriginalNovelParagraphText(node);
      if (!originalText.trim()) continue;
      const normalized = runtime.normalizeTranslationCacheText(originalText);
      const normalizedSourceHash = runtime.computeTranslationCacheHash(normalized);
      const pid = `c${String(normalizedSourceHash).slice(0, 12)}`;
      if (node.getAttribute(attribute) !== pid) node.setAttribute(attribute, pid);
      const occurrenceIndex = occurrences.get(normalizedSourceHash) || 0;
      occurrences.set(normalizedSourceHash, occurrenceIndex + 1);
      paragraphs.push({
        node,
        pid,
        occurrenceIndex,
        normalizedSourceHash,
        originalText
      });
    }
    return paragraphs;
  }

  /** 作品级 id 与作品名取自阅读器自己的作品标题链接（URL 里只有这一话的 id）。 */
  function readRidiSeriesLink() {
    const anchor = document?.querySelector?.(RIDI_SERIES_LINK_SELECTOR) || null;
    if (!anchor) return { seriesId: "", seriesTitle: "" };
    const match = String(anchor.getAttribute?.("href") || "").match(/\/library\/books\/(\d+)/u);
    return {
      seriesId: match ? match[1] : "",
      seriesTitle: String(anchor.textContent || "").replace(/\s+/gu, " ").trim()
    };
  }

  /**
   * 章节标题优先取 og:title：浏览器整页翻译会把 document.title 一起译掉
   * （"… - 리디" 变成 "… - 里迪"），og:title 不会被改写，是页面自报的原文标题。
   */
  function readRidiChapterTitle() {
    const og = document?.querySelector?.('meta[property="og:title"]');
    const value = String(og?.getAttribute?.("content") || "").trim();
    return value || String(document?.title || "").trim();
  }

  function findRidiNovelSurface() {
    if (!isRidiHost() || !document?.querySelectorAll) return null;
    const viewer = findRidiViewerRoot();
    if (!viewer) return null;
    const blocks = [...viewer.querySelectorAll(RIDI_BLOCK_SELECTOR)];
    if (blocks.length < RIDI_MIN_PARAGRAPHS) return null;
    const picked = pickRidiBranch(viewer, blocks);
    if (!picked) return null;
    const attribute = runtime.NOVEL_STAMP_ANCHOR_ATTRIBUTE;
    const stamped = stampRidiParagraphs(picked.blocks, attribute);
    if (stamped.length < RIDI_MIN_PARAGRAPHS) return null;
    const series = readRidiSeriesLink();
    return Object.freeze({
      kind: "ridi",
      viewer,
      // root 用 document：段落锚点是我们自己盖的，React 重建容器后锚点仍在文档里，
      // 按 document 查询不会因为容器换了一棵树而找不到已渲染的译文。
      root: document,
      container: picked.container,
      content: picked.container,
      observeTarget: picked.container,
      paragraphs: stamped.map(item => item.node),
      anchorAttribute: attribute,
      seriesId: series.seriesId,
      seriesTitle: series.seriesTitle,
      chapterTitle: readRidiChapterTitle()
    });
  }
  runtime.findRidiNovelSurface = findRidiNovelSurface;

  function extractRidiNovelChapter(surface = findRidiNovelSurface()) {
    if (!surface) return null;
    const locationInfo = runtime.novelCore.parseRidiNovelLocation(
      globalThis.location?.href || "", surface.chapterTitle, surface.seriesId
    );
    if (!locationInfo) return null;
    const attribute = surface.anchorAttribute || runtime.NOVEL_STAMP_ANCHOR_ATTRIBUTE;
    const blocks = [...(surface.container || surface.viewer).querySelectorAll(RIDI_BLOCK_SELECTOR)];
    const stamped = stampRidiParagraphs(blocks, attribute);
    const paragraphs = stamped.map((item, index) => {
      const { node, pid, occurrenceIndex, normalizedSourceHash, originalText } = item;
      return {
        id: `${occurrenceIndex > 0 ? `${pid}#${occurrenceIndex}` : pid}@${String(normalizedSourceHash).slice(0, 12)}`,
        pid,
        pidOrdinal: occurrenceIndex,
        // 段落身份按内容寻址，所以「重复出现的同一段」只能靠出现序号区分；
        // paragraphKey 与 Kakao 侧同构，让记录形状在两端一致。
        paragraphKey: runtime.computeTranslationCacheHash(
          `${locationInfo.chapterId}\u0000${normalizedSourceHash}\u0000${occurrenceIndex}`
        ),
        domAnchor: pid,
        occurrenceIndex,
        rawSourceHash: runtime.computeTranslationCacheHash(originalText),
        normalizedSourceHash,
        index,
        kind: /^H[1-6]$/u.test(String(node.tagName || "")) ? "title" : "paragraph",
        original_text: originalText,
        node
      };
    });
    return {
      ...locationInfo,
      seriesTitle: surface.seriesTitle || locationInfo.chapterTitle,
      surface,
      paragraphs,
      images: runtime.collectNovelImages(surface, paragraphs)
    };
  }
  runtime.extractRidiNovelChapter = extractRidiNovelChapter;
}
