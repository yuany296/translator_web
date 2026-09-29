/**
 * KakaoPage 小说阅读器的正文适配（EPUB 分屏阅读 + shadow DOM）。
 *
 * 段落锚点由页面自己提供（`data-p-id`），我们只读不写；这与 RIDI 的适配器
 * （novel-ridi-reader.js，锚点由我们盖章）是两个入口、一条下游管线。
 */
export function installKakaoNovelReader(runtime) {
  function findKakaoNovelSurface() {
    if (!runtime.IS_KAKAOPAGE_READER || !document.querySelectorAll) return null;
    const viewer = document.querySelector("[data-testid='viewer-container']");
    if (!viewer) return null;
    const attribute = runtime.NOVEL_PAGE_ANCHOR_ATTRIBUTE;
    const candidates = [viewer, ...viewer.querySelectorAll("*")];
    for (const host of candidates) {
      const root = host && host.shadowRoot;
      if (!root || typeof root.querySelectorAll !== "function") continue;
      const paragraphs = [...root.querySelectorAll(`[${attribute}]`)]
        .filter(node => runtime.isNovelParagraphLeaf(node, attribute));
      if (paragraphs.length < 2) continue;
      return {
        kind: "kakao",
        viewer,
        host,
        root,
        // 分屏阅读复用同一个 shadow 宿主，观察的也是它；RIDI 侧观察的是内容容器。
        observeTarget: root,
        content: runtime.findCommonNovelAncestor(paragraphs, root),
        paragraphs,
        anchorAttribute: attribute
      };
    }
    return null;
  }
  runtime.findKakaoNovelSurface = findKakaoNovelSurface;

  function orderParagraphs(nodes) {
    const ordered = nodes.map((node, index) => ({
      node,
      index,
      id: String(node.getAttribute(runtime.NOVEL_PAGE_ANCHOR_ATTRIBUTE) || "")
    }));
    const sortable = ordered.map(item => item.id.match(/^([^\d]*)(\d+)([^\d]*)$/u));
    const numericIds = sortable.every(Boolean) &&
      sortable.every(match => match[1] === sortable[0][1] && match[3] === sortable[0][3]);
    if (numericIds) {
      ordered.sort((left, right) => left.id.localeCompare(right.id, undefined, {
        numeric: true,
        sensitivity: "base"
      }) || left.index - right.index);
    }
    return ordered;
  }

  function getSeriesTitle(chapterTitle) {
    return String(chapterTitle || "").replace(/\s*\d+(?:\.\d+)?\s*화.*$/u, "").trim();
  }

  function extractKakaoNovelChapter(surface = findKakaoNovelSurface()) {
    if (!surface) return null;
    const locationInfo = runtime.novelCore.parseKakaoNovelLocation(location.href, document.title);
    if (!locationInfo) return null;
    const attribute = surface.anchorAttribute || runtime.NOVEL_PAGE_ANCHOR_ATTRIBUTE;
    const occurrences = new Map();
    const pidOrdinals = new Map();
    const paragraphs = orderParagraphs(
      [...surface.root.querySelectorAll(`[${attribute}]`)]
        .filter(node => runtime.isNovelParagraphLeaf(node, attribute))
    ).map(({ node, id, index }) => {
      const originalText = runtime.getOriginalNovelParagraphText(node);
      const normalized = runtime.normalizeTranslationCacheText(originalText);
      const normalizedSourceHash = runtime.computeTranslationCacheHash(normalized);
      const occurrenceIndex = occurrences.get(normalizedSourceHash) || 0;
      occurrences.set(normalizedSourceHash, occurrenceIndex + 1);
      // KakaoPage 的 data-p-id 不是唯一标识:对话块内嵌套节点共享同一个
      // data-p-id。带嵌套段落的容器已由 isNovelParagraphLeaf 排除在外,这里
      // 只处理真正的同级同号段落:给同 id 的节点追加序号生成唯一 id,避免译文
      // 互相覆盖、进度计数把副本重复计入;domAnchor 保留原始 id 供恢复。
      // (novel-renderer 的 findNovelParagraphNode 必须用同一套 leaf 判据算
      // 序号,否则 reapply 会把容器当成第 0 段,哈希对不上而清掉译文。)
      // 且 data-p-id 只在单个 EPUB 文档(一屏)内唯一,翻页后从 0 重新编号;
      // 若段落身份只用「pid#同 id 序号」,新一屏的同号段落就会认领上一屏的
      // 译文(表现为末页版权信息被画上作品开头的句子)。把源文哈希并入 id,
      // 使段落身份与持久缓存一样按内容寻址,页面切换后不再串号。
      const pidOrdinal = pidOrdinals.get(id) || 0;
      pidOrdinals.set(id, pidOrdinal + 1);
      const paragraphId = `${pidOrdinal > 0 ? `${id}#${pidOrdinal}` : id}@${String(normalizedSourceHash).slice(0, 12)}`;
      const paragraphKey = runtime.computeTranslationCacheHash(
        `${locationInfo.chapterId}\u0000${normalizedSourceHash}\u0000${occurrenceIndex}`
      );
      return {
        id: paragraphId,
        pid: id,
        pidOrdinal,
        paragraphKey,
        domAnchor: id,
        occurrenceIndex,
        rawSourceHash: runtime.computeTranslationCacheHash(originalText),
        normalizedSourceHash,
        index,
        kind: /^H[1-6]$/u.test(node.tagName) ? "title" : "paragraph",
        original_text: originalText,
        node
      };
    });
    return {
      ...locationInfo,
      seriesTitle: getSeriesTitle(locationInfo.chapterTitle),
      surface,
      paragraphs,
      images: runtime.collectNovelImages(surface, paragraphs)
    };
  }
  runtime.extractKakaoNovelChapter = extractKakaoNovelChapter;
}
