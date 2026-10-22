/**
 * 振り仮名（ルビ）过滤 —— 聚类之前把「注音小字」整条丢掉。
 *
 * 日漫在汉字旁边用小一号的假名注音（縦書き的ルビ在汉字列的右侧，横書き的在汉字上方）。
 * PaddleOCR 会把那一列小字当成**独立的文本行**检测出来，于是同一句台词会多出 1~3 条
 * 「文本」：它们本身没有翻译价值（只是读音），却各自进翻译、各自画一个气泡（用户看到
 * 「日漫旁边怎么有那么多小字」）；更糟的是聚类会把ルビ和正文拼成同一行 —— 实测
 * 「あしたもと」+「明日地元」被拼成一行，译文是「明日元,明天是本地。」，一句正常台词
 * 被翻成乱码（「あしたもと」正是 明日(あした)+地元(じもと) 的ルビ）。
 *
 * 判据必须偏保守：**误删真台词比留着ルビ严重得多**（真台词删了就永远不翻，ルビ留着只是
 * 多一个气泡）。四条同时成立才认：
 *  1. 文本全是假名 —— ルビ注的是汉字读音；真台词几乎总带汉字（连纯假名台词也带「…」「?」
 *     这类标点，落不进这个字符集）。
 *  2. 它比**整页正文字号**细得多（thickness ≤ 0.8 × 页内同向条目的中位粗细）。只看
 *     「比邻居细」会误伤：邻居可能是聚类后的多列块，宽度是单列的 2 倍（实测
 *     「それなら」对「私王来時」比值 0.55，两条都是真台词）。
 *  3. 紧挨着一个更粗、且**含汉字**的邻居（縦書き在右侧、横書き在上方），间距不超过自身
 *     粗细的 1.6 倍；宿主不含汉字就不认（ルビ不会注在假名上）。
 *  4. 沿文字轴的范围基本落在该邻居里（重合 ≥ 60%）—— ルビ只注它那一段汉字。
 *
 * 竖排与横排两套轴对称实现。实测（CMOA《凶乱令嬢ニア・リストン》6 页 212 条原始识别）
 * 命中 21 条，逐条人工核对全部是ルビ/ルビ碎片，没有一条真台词被删。
 */

/** 只由假名（含长音符、中点、繰り返し記号、半角長音）构成的文本。 */
const RUBY_KANA_ONLY = /^[\u3041-\u309f\u30a0-\u30ff\u30fc\u30fb\u309d\u309e\u3005\u3006\uff70]+$/u;
/** ルビ只会注在汉字上；宿主必须含汉字。 */
const RUBY_HOST_KANJI = /[\u3400-\u9fff]/u;
/** ルビ相对整页正文字号的粗细上限（粗过它就按真台词放行）。 */
const RUBY_MAX_GLYPH_RATIO = 0.8;
/** manga-ocr 引擎的阈值放宽到 0.9：它对 ruby 列也是高置信（paddle 时代靠低分过滤挡住的
 * ruby 现在活到过滤面前），而其列框略厚（0.84~0.89 档），0.8 会漏。 */
const RUBY_MAX_GLYPH_RATIO_MANGA_OCR = 0.9;
/** 宿主相对ルビ的粗细下限：宿主必须明显更粗（防「两条等粗的真台词」互配）。 */
const RUBY_MAX_HOST_RATIO = 0.7;
/** manga-ocr 引擎放宽到 0.8：manga-ocr 的正文列普遍偏细（24~31px），ruby 列 20px 对
 * 27px 宿主（1.35×）在 0.7 判据下漏掉——实测 からだ/かのじょ 两列。 */
const RUBY_MAX_HOST_RATIO_MANGA_OCR = 0.8;
/** 沿文字轴与宿主的重合比例下限。 */
const RUBY_MIN_SPAN = 0.6;
/** ルビ一列不会太长；超过这么多字符就不当注音（避免拿长句去配宿主）。 */
const RUBY_MAX_CHARS = 12;
/** 与宿主的最大间距 = max(自身粗细 × 1.6, 12px)，相对宿主右/下边缘量。 */
const RUBY_AXIS_TOLERANCE = 1.6;
const RUBY_MIN_GAP_PX = 12;
/** 盒子沿轴向允许的自身重叠（服务端 unclip 会让相邻两列互相压住几个像素）。 */
const RUBY_OVERLAP_TOLERANCE = 1.2;

export function installOcrRuby(runtime) {
  function isKanaOnlyOcrText(text) {
    return RUBY_KANA_ONLY.test(String(text || "").replace(/\s+/g, ""));
  }
  runtime.isKanaOnlyOcrText = isKanaOnlyOcrText;
  function rubyThickness(box) {
    return Math.min(Number(box && box.width) || 0, Number(box && box.height) || 0);
  }
  runtime.rubyThickness = rubyThickness;
  function isVerticalRubyBox(box) {
    return Number(box && box.height) > Number(box && box.width) * 1.15;
  }
  runtime.isVerticalRubyBox = isVerticalRubyBox;
  function isHorizontalRubyBox(box) {
    return Number(box && box.width) > Number(box && box.height) * 1.15;
  }
  runtime.isHorizontalRubyBox = isHorizontalRubyBox;
  function medianRubyThickness(entries) {
    const values = entries.map(entry => entry.thickness).filter(value => value > 0).sort((left, right) => left - right);
    if (values.length === 0) {
      return 0;
    }
    const middle = Math.floor(values.length / 2);
    return values.length % 2 === 1 ? values[middle] : (values[middle - 1] + values[middle]) / 2;
  }
  runtime.medianRubyThickness = medianRubyThickness;
  function rubySpanOverlap(start, end, hostStart, hostEnd, length) {
    const overlap = Math.max(0, Math.min(end, hostEnd) - Math.max(start, hostStart));
    return overlap / Math.max(1, length);
  }
  runtime.rubySpanOverlap = rubySpanOverlap;
  /**
   * 找这条候选ルビ的宿主。返回最像的那一条（粗细最接近、仍在阈值内），没有就 null。
   * `vertical` 决定轴：竖排时宿主在候选**右**边、比 top/bottom 范围；横排时宿主在
   * 候选**下**边（横書き的ルビ在汉字上方）、比 left/right 范围。
   */
  function findRubyHost(candidate, entries, vertical, engine) {
    const box = candidate.box;
    const gapLimit = Math.max(candidate.thickness * RUBY_AXIS_TOLERANCE, RUBY_MIN_GAP_PX);
    const overlapTolerance = candidate.thickness * RUBY_OVERLAP_TOLERANCE;
    let best = null;
    entries.forEach(entry => {
      if (entry === candidate) {
        return;
      }
      if (!RUBY_HOST_KANJI.test(entry.text)) {
        return;
      }
      const hostMinRatio = engine === "manga_ocr" ? RUBY_MAX_HOST_RATIO_MANGA_OCR : RUBY_MAX_HOST_RATIO;
      if (entry.thickness <= candidate.thickness / hostMinRatio) {
        return;
      }
      const host = entry.box;
      // 两组轴上的「候选在宿主之外」方向必须一致：竖排的ルビ在宿主**右**边（比 left 与
      // host.right），横排的在宿主**上**边（比 bottom 与 host.top）。
      const gap = vertical ? box.left - host.right : host.top - box.bottom;
      if (gap < -overlapTolerance || gap > gapLimit) {
        return;
      }
      const span = vertical
        ? rubySpanOverlap(box.top, box.bottom, host.top, host.bottom, box.height)
        : rubySpanOverlap(box.left, box.right, host.left, host.right, box.width);
      if (span < RUBY_MIN_SPAN) {
        return;
      }
      // ルビ必须与宿主**紧贴**：两者之间若还夹着其它同向文本列，这条「ルビ」其实是
      // 从右往左句子的开头列，被大字号邻列吸走了（真案例：そういえば [いぜん]
      // 言っていたな…——「そういえば」是正文开头，隔着 ruby 列配上了 46px 的大字宿主）。
      // 中间列判定：盒中心落在候选与宿主之间的带内，且自身跨度的一半以上落在候选的
      // 文字轴范围内（短ルビ列整列都在宿主旁边也算）。
      const between = entries.some(entry2 => {
        if (entry2 === candidate || entry2 === entry) {
          return false;
        }
        const b2 = entry2.box;
        const low = vertical ? Math.min(host.right, box.left) : Math.min(box.bottom, host.top);
        const high = vertical ? Math.max(host.right, box.left) : Math.max(box.bottom, host.top);
        const center = vertical ? b2.left + b2.width / 2 : b2.top + b2.height / 2;
        if (center < low || center > high) {
          return false;
        }
        const overlapSpan = vertical
          ? Math.max(0, Math.min(box.bottom, b2.bottom) - Math.max(box.top, b2.top))
          : Math.max(0, Math.min(box.right, b2.right) - Math.max(box.left, b2.left));
        const entrySpan = vertical ? b2.bottom - b2.top : b2.right - b2.left;
        return entrySpan > 0 && overlapSpan >= entrySpan * 0.5;
      });
      if (between) {
        return;
      }
      if (!best || entry.thickness < best.entry.thickness) {
        best = { entry, span, gap };
      }
    });
    return best;
  }
  runtime.findRubyHost = findRubyHost;
  function stripFuriganaLikeClusterEntries(cluster, regionType) {
    if (!Array.isArray(cluster) || cluster.length < 3 || runtime.isChatRegionType(regionType)) {
      return cluster;
    }
    const rotation = runtime.medianRotation(cluster.map(entry => entry.rotation));
    if (Math.abs(runtime.normalizeRotationDegrees(rotation)) < 45) {
      return cluster;  // 竖排限定：横排的短假名行语义多变，不动
    }
    const hasKanji = entry => /[\u3400-\u9fff]/.test(String(entry.item?.words || entry.text || ""));
    if (cluster.filter(hasKanji).length < 2) {
      return cluster;  // 含汉字列不足两条：假名heavy的块无法区分注音与正文，保守不动
    }
    return cluster.filter(entry => {
      const text = String(entry.item?.words || entry.text || "").replace(/\s+/g, "");
      if (hasKanji(entry) || !runtime.isKanaOnlyOcrText(text)) {
        return true;
      }
      // ≤8 字的全假名列混在多列汉字正文里 = 漏过ルビ过滤的注音读音，剥掉。
      return [...text].length > 8;
    });
  }
  runtime.stripFuriganaLikeClusterEntries = stripFuriganaLikeClusterEntries;

  /**
   * 丢掉整页里判定为ルビ的词条。返回保留下来的数组（**不**把它们并进正文：读音没有
   * 翻译价值，并进去只会污染原文）。`words` 是已过尺寸/分数门槛的词条数组。
   */
  function filterRubyAnnotationWords(words, imageSize, debug, engine = "local_paddle") {
    const list = Array.isArray(words) ? words : [];
    if (list.length < 2) {
      return list;
    }
    const entries = list.map((item, index) => {
      const box = runtime.getBaiduItemBox(item);
      if (!box) {
        return null;
      }
      return {
        item,
        index,
        box,
        text: String(item && (item.words || item.text) ? item.words || item.text : "").replace(/\s+/g, ""),
        thickness: rubyThickness(box)
      };
    }).filter(Boolean);
    if (entries.length < 2) {
      return list;
    }
    const vertical = entries.filter(entry => isVerticalRubyBox(entry.box) && !isHorizontalRubyBox(entry.box));
    const horizontal = entries.filter(entry => isHorizontalRubyBox(entry.box));
    const medianVertical = medianRubyThickness(vertical);
    const medianHorizontal = medianRubyThickness(horizontal);
    const dropped = new Set();
    entries.forEach(entry => {
      if (dropped.has(entry.index)) {
        return;
      }
      if (!isKanaOnlyOcrText(entry.text) || Array.from(entry.text).length > RUBY_MAX_CHARS) {
        return;
      }
      const isVertical = isVerticalRubyBox(entry.box) && !isHorizontalRubyBox(entry.box);
      const isHorizontal = !isVertical && isHorizontalRubyBox(entry.box);
      if (!isVertical && !isHorizontal) {
        return;
      }
      const median = isVertical ? medianVertical : medianHorizontal;
      const maxGlyphRatio = engine === "manga_ocr" ? RUBY_MAX_GLYPH_RATIO_MANGA_OCR : RUBY_MAX_GLYPH_RATIO;
      if (!(median > 0) || entry.thickness > median * maxGlyphRatio) {
        return;
      }
      const host = findRubyHost(entry, isVertical ? vertical : horizontal, isVertical, engine);
      if (!host) {
        return;
      }
      dropped.add(entry.index);
      runtime.traceFilterReason(debug, {
        stage: "filter",
        engine,
        index: entry.index,
        dropReason: "ruby-annotation",
        reason: "ruby-annotation",
        text: entry.text,
        rubyHostText: host.entry.text,
        rubyGlyphRatio: Number((entry.thickness / Math.max(1, median)).toFixed(3)),
        item: runtime.toDebugOcrItem(entry.item, entry.index, imageSize, "filtered")
      });
    });
    if (dropped.size === 0) {
      return list;
    }
    return list.filter((item, index) => !dropped.has(index));
  }
  runtime.filterRubyAnnotationWords = filterRubyAnnotationWords;
}
