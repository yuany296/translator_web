/**
 * 小说正文的行内格式复刻(纯 DOM 工具)。
 *
 * 两块职责:
 *   1. 把原文的行内结构(加粗/斜体/带 class 的 span…)复刻到译文上 —— 优先用模型对齐过的
 *      ⟦⟧ 标记(见 novel-emphasis-align.js),拿不到就按字符占比近似映射;
 *   2. 给「让模型排版」那次请求提供输入:把原文的强调片段标出来(describeNovelEmphasis)。
 *
 * 与渲染器分开是因为这段逻辑只跟原文 DOM 结构打交道,不关心可见性/还原,而且
 * novel-renderer.js 已经接近单文件行数上限。
 */

// 可以镜像到译文上的行内标签。只认「纯样式」标签:块级、媒体、交互类
// (<br>/<img>/<ruby>/<a>)一概不复刻 —— 把 <br> 或链接语义按比例切进译文只会更乱。
const MIRROR_INLINE_TAGS = new Set([
  "B", "STRONG", "EM", "I", "U", "S", "STRIKE", "DEL", "INS", "SMALL", "MARK",
  "SUB", "SUP", "SPAN", "FONT", "CODE", "Q", "BIG", "TT"
]);
// 片段太多的段落(AI 标记、注释等)不做比例映射:切得越碎越不像。
const MAX_MIRROR_RUNS = 12;
// 强调标记:「让模型排版」那一次请求(见 novel-emphasis-align.js)用它把原文的强调片段
// 与译文里的对应片段对上。用一对正文里绝不会出现的括号,解析失败一律退回比例映射,
// 并且永远在写入页面前剔除。
const EMPHASIS_OPEN = "⟦";
const EMPHASIS_CLOSE = "⟧";


export function installNovelInlineFormat(runtime) {
  /** childNodes 可能是 NodeList(浏览器)或数组(测试),统一取成长度可用的数组。 */
  function childArray(node) {
    const list = node?.childNodes;
    return list && typeof list.length === "number" ? [...list] : null;
  }

  /**
   * 收集原文的行内片段:每段文字带上「包着它的那串行内元素」。
   * 只要出现一个不能复刻的子节点(<br>、图片、链接、注释…)就整段放弃镜像。
   */
  function collectInlineRuns(source) {
    const runs = [];
    let simple = true;
    const walk = (parent, chain) => {
      const children = childArray(parent);
      if (!children) {
        simple = false;
        return;
      }
      for (const child of children) {
        if (!simple) return;
        if (child.nodeType === 3) {
          runs.push({ text: String(child.nodeValue || ""), chain });
          continue;
        }
        if (child.nodeType !== 1
          || !MIRROR_INLINE_TAGS.has(String(child.tagName || "").toUpperCase())) {
          simple = false;
          return;
        }
        walk(child, [...chain, child]);
      }
    };
    walk(source, []);
    if (!simple || !runs.length || runs.length > MAX_MIRROR_RUNS) return null;
    // 纯文本段落(没有任何行内包裹)不需要镜像,交给调用方直接写 textContent。
    return runs.some(run => run.chain.length) ? runs : null;
  }

  function sameChain(left, right) {
    return left.length === right.length && left.every((node, index) => node === right[index]);
  }

  /** 相邻且包裹相同的片段并成一段:模型只需要知道有几段强调、按顺序一一对应。 */
  function mergeRunsByChain(runs) {
    const merged = [];
    for (const run of runs) {
      const last = merged.at(-1);
      if (last && sameChain(last.chain, run.chain)) {
        last.text += run.text;
        continue;
      }
      merged.push({ text: run.text, chain: run.chain });
    }
    return merged;
  }

  /** 段落里承载原文的那一层:已渲染过就是 `.mt-novel-source`,原文模式下就是段落本身。 */
  function resolveSourceRoot(node) {
    return node?.querySelector?.(":scope > .mt-novel-source") || node || null;
  }

  /**
   * 段落的强调结构:把强调片段用 ⟦⟧ 标出来的原文 + 强调段数。
   *
   * 这是「让模型排版」那次请求的输入 —— 模型必须**看见**原文哪里加了强调,才能在译文里
   * 把对应的一段标出来。整段没有任何行内包裹(占绝大多数)时返回 null,不产生任何请求。
   */
  function describeNovelEmphasis(node) {
    const runs = collectInlineRuns(resolveSourceRoot(node));
    if (!runs) return null;
    const segments = mergeRunsByChain(runs);
    const emphasis = segments.filter(segment => segment.chain.length);
    if (!emphasis.length) return null;
    const marked = segments.map(segment => (segment.chain.length
      ? `${EMPHASIS_OPEN}${segment.text}${EMPHASIS_CLOSE}`
      : segment.text)).join("");
    return { marked, count: emphasis.length };
  }
  runtime.describeNovelEmphasis = describeNovelEmphasis;

  /**
   * 把标记文本里的偏移投影回译文自身。模型偶尔会在标记内外多写一个空格,逐字符跳过
   * 空白差异即可;真出现非空白差异(说明它改了译文)就返回 -1,由调用方退回比例映射。
   */
  function projectOffset(text, plain, offset) {
    let index = 0;
    let cursor = 0;
    while (cursor < offset && index < text.length) {
      const plainChar = plain[cursor];
      const textChar = text[index];
      if (plainChar === textChar) {
        index += 1;
        cursor += 1;
        continue;
      }
      if (/\s/u.test(String(plainChar || ""))) {
        cursor += 1;
        continue;
      }
      if (/\s/u.test(String(textChar || ""))) {
        index += 1;
        continue;
      }
      return -1;
    }
    return cursor >= offset ? index : -1;
  }

  /**
   * 解析模型标好的译文,返回每段强调在译文里的 [start, end)。
   *
   * 只有「标记成对、段数与原文一致、去掉标记后与译文逐字相同」才算对齐成功 ——
   * 排版这一步绝不允许改动译文,对不上就当作没对齐(退回比例映射)。
   */
  function parseEmphasisMarks(marked, text, expectedCount) {
    const raw = String(marked || "");
    if (!raw || !text || !expectedCount) return null;
    const pairs = [];
    let plain = "";
    let index = 0;
    while (index < raw.length) {
      const open = raw.indexOf(EMPHASIS_OPEN, index);
      if (open < 0) {
        plain += raw.slice(index);
        break;
      }
      plain += raw.slice(index, open);
      const close = raw.indexOf(EMPHASIS_CLOSE, open + EMPHASIS_OPEN.length);
      if (close < 0) return null;
      const body = raw.slice(open + EMPHASIS_OPEN.length, close);
      if (body.includes(EMPHASIS_OPEN)) return null;
      pairs.push({ start: plain.length, end: plain.length + body.length });
      plain += body;
      index = close + EMPHASIS_CLOSE.length;
    }
    if (pairs.length !== expectedCount) return null;
    if (plain === text) return pairs;
    const projected = pairs.map(pair => ({
      start: projectOffset(text, plain, pair.start),
      end: projectOffset(text, plain, pair.end)
    }));
    if (projected.some(pair => pair.start < 0 || pair.end <= pair.start)) return null;
    return projected;
  }

  /** 模型对齐结果 → 片段:每段标记盖住译文里对应的一段,空档就是普通文本。 */
  function piecesFromMarks(text, spans, emphasis) {
    const pieces = [];
    let cursor = 0;
    spans.forEach((span, index) => {
      const segment = emphasis[index];
      if (!segment) return;
      if (span.start > cursor) pieces.push({ text: text.slice(cursor, span.start), chain: [] });
      pieces.push({ text: text.slice(span.start, span.end), chain: segment.chain });
      cursor = span.end;
    });
    if (cursor < text.length) pieces.push({ text: text.slice(cursor), chain: [] });
    return pieces;
  }

  /** 比例映射:按原文每个片段的字符占比把译文切开(模型没对齐成功时的兜底)。 */
  function piecesFromRuns(runs, text) {
    const total = runs.reduce((sum, run) => sum + run.text.length, 0);
    if (!total) return [];
    const pieces = [];
    let sourceCursor = 0;
    let textCursor = 0;
    runs.forEach((run, index) => {
      sourceCursor += run.text.length;
      const end = index === runs.length - 1
        ? text.length
        : Math.min(text.length, Math.max(textCursor, Math.round(sourceCursor / total * text.length)));
      const piece = text.slice(textCursor, end);
      textCursor = end;
      if (piece) pieces.push({ text: piece, chain: run.chain });
    });
    return pieces;
  }

  function buildMirrorNodes(pieces) {
    // 相邻同包裹的片段合并,避免切出一堆单字节点。
    const merged = [];
    for (const piece of pieces) {
      const last = merged.at(-1);
      if (last && sameChain(last.chain, piece.chain)) last.text += piece.text;
      else merged.push(piece);
    }
    const nodes = [];
    for (const piece of merged) {
      if (!piece.chain.length) {
        nodes.push(document.createTextNode(piece.text));
        continue;
      }
      let shell = null;
      let deepest = null;
      for (const wrapper of piece.chain) {
        const clone = cloneInlineShell(wrapper);
        if (shell) deepest.appendChild(clone);
        else shell = clone;
        deepest = clone;
      }
      deepest.textContent = piece.text;
      nodes.push(shell);
    }
    return nodes;
  }

  /**
   * 复刻原文的行内结构。
   *
   * 优先用模型对齐过的标记(`marked`,见 novel-emphasis-align.js):强调段落在译文里的
   * 边界由模型判定,不用猜;拿不到标记或标记不可信时退回按字符占比近似映射。
   */
  function buildTranslationMirror(source, text, marked = "") {
    const runs = collectInlineRuns(source);
    if (!runs) return null;
    const emphasis = mergeRunsByChain(runs).filter(segment => segment.chain.length);
    if (!emphasis.length) return null;
    const spans = parseEmphasisMarks(marked, text, emphasis.length);
    const pieces = spans ? piecesFromMarks(text, spans, emphasis) : piecesFromRuns(runs, text);
    return pieces.length ? buildMirrorNodes(pieces) : null;
  }

  /**
   * 镜像壳只搬运样式语义(class / inline style)；段落锚点必须丢掉，否则镜像里的副本
   * 会被当成段落。两个锚点属性都要清：KakaoPage 的 data-p-id 与 RIDI 侧我们盖章的
   * data-mt-novel-pid（见 novel-paragraph.js），只清一个就会给某个站点留下重复锚点，
   * findNovelParagraphNode 按序号取值时就会指到镜像副本上。
   */
  function cloneInlineShell(source) {
    const tag = String(source.tagName || "span").toLowerCase();
    const clone = document.createElement(tag);
    // class 两处都写:真实 DOM 里 className 与 class 属性是同一份反射,但只读其中一处
    // 会漏掉另一种写法(测试桩、以及直接赋 className 的页面脚本)。
    const className = (typeof source.getAttribute === "function" ? source.getAttribute("class") : "")
      || (typeof source.className === "string" ? source.className : "");
    const style = (typeof source.getAttribute === "function" ? source.getAttribute("style") : "")
      || (source.style && typeof source.style.cssText === "string" ? source.style.cssText : "");
    if (typeof clone.setAttribute === "function") {
      if (className) {
        clone.className = className;
        clone.setAttribute("class", className);
      }
      if (style) clone.setAttribute("style", style);
      clone.removeAttribute("data-p-id");
      clone.removeAttribute("data-mt-novel-pid");
    }
    return clone;
  }

  runtime.buildNovelInlineMirror = buildTranslationMirror;
}
