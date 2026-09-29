import sharedUtils from "../../shared/utils.js";

/**
 * 小说段落的基本判据。桌面版与手机版、Kakao 与 RIDI 都从这里取，不再各写一份。
 *
 * 段落锚点有两种来源，必须是**两个**属性名：
 *   - KakaoPage 的 EPUB 阅读器自己给段落打 `data-p-id`（页面所有，我们只读）；
 *   - RIDI 的 웹뷰어 什么都不打，段落身份只能由我们盖章（`data-mt-novel-pid`）。
 * 合成一个属性名会把「页面的事实」和「我们的标记」混为一谈：页面重建段落时前者
 * 由站点负责、后者由我们负责，混起来就分不清该信谁。两者都只是「定位这一段用的
 * 锚」，消费方一律通过 surface.anchorAttribute 取，不硬编码。
 */
const PAGE_ANCHOR_ATTRIBUTE = "data-p-id";
const STAMP_ANCHOR_ATTRIBUTE = "data-mt-novel-pid";

// 只读消费方（如 novel-renderer 在 runtime 未装段落模块时）需要静态拿到这个默认属性名，
// 而不是自己写死字符串。
export { PAGE_ANCHOR_ATTRIBUTE as NOVEL_PAGE_ANCHOR_ATTRIBUTE };

export function installNovelParagraphs(runtime) {
  runtime.NOVEL_PAGE_ANCHOR_ATTRIBUTE = PAGE_ANCHOR_ATTRIBUTE;
  runtime.NOVEL_STAMP_ANCHOR_ATTRIBUTE = STAMP_ANCHOR_ATTRIBUTE;

  function novelAnchorAttribute(surface) {
    return String(surface && surface.anchorAttribute || PAGE_ANCHOR_ATTRIBUTE);
  }
  runtime.novelAnchorAttribute = novelAnchorAttribute;

  /**
   * 从一个节点上读出段落锚点值 —— 消费方**不要**自己硬编码属性名。
   *
   * `surface` 已知时用它的 anchorAttribute；不知道 surface 时按「页面自带 → 我们盖章」
   * 的顺序两个都试（`novel-anchor-value` 这一层就是为了兜住"拿不到 surface"的调用点，
   * 例如图像结果键、面板摘要）。硬编码 data-p-id 的写法在 RIDI 上永远拿到空串：
   * 那里的锚点是我们自己盖的 data-mt-novel-pid，于是图像结果键丢了段落身份。
   */
  function novelAnchorValueOf(node, surface = null) {
    const preferred = novelAnchorAttribute(surface);
    const direct = node?.getAttribute?.(preferred);
    if (direct != null) return String(direct);
    const alternate = preferred === PAGE_ANCHOR_ATTRIBUTE ? STAMP_ANCHOR_ATTRIBUTE : PAGE_ANCHOR_ATTRIBUTE;
    const fallback = node?.getAttribute?.(alternate);
    return fallback == null ? "" : String(fallback);
  }
  runtime.novelAnchorValueOf = novelAnchorValueOf;

  function isNovelParagraphNode(node, attribute = PAGE_ANCHOR_ATTRIBUTE) {
    return !!node && /^(?:H[1-6]|P|DIV)$/u.test(String(node.tagName || "")) &&
      node.hasAttribute(attribute);
  }
  runtime.isNovelParagraphNode = isNovelParagraphNode;

  /**
   * KakaoPage 会把「容器」也打上 data-p-id:论坛/评论块是
   * `div.box01[data-p-id] > div.box02[data-p-id] > p.box_txt[data-p-id] × N`,
   * 三层同号。容器不是段落:若把它也当段落,整块会被当成一段送去翻译,渲染时
   * 内层盒子又被塞进隐藏的原文包裹,译文只剩一整段纯文本(白底内框、逐行
   * padding/行距、加粗标题全部消失),同一段文字还会被重复翻译。
   * 判据:带锚点的块级节点若存在「同为段落的块级后代」,它就只是容器。
   * 只认块级后代——`<br data-p-id>`、`<img data-p-id>`、`<span data-p-id>` 是
   * 空元素或行内元素,不构成嵌套段落,否则整屏的空行段落会被误删。
   *
   * RIDI 侧锚点由我们盖章、只盖在叶子上,所以这条判据天然成立;两边共用同一个
   * 函数是为了「RIDI 段落之后被别的东西包一层」时行为仍然一致。
   */
  function hasNestedNovelParagraph(node, attribute = PAGE_ANCHOR_ATTRIBUTE) {
    const descendants = node?.querySelectorAll?.(`[${attribute}]`);
    if (!descendants || typeof descendants.length !== "number") return false;
    for (let index = 0; index < descendants.length; index += 1) {
      if (isNovelParagraphNode(descendants[index], attribute)) return true;
    }
    return false;
  }
  runtime.hasNestedNovelParagraph = hasNestedNovelParagraph;

  function isNovelParagraphLeaf(node, attribute = PAGE_ANCHOR_ATTRIBUTE) {
    return isNovelParagraphNode(node, attribute) && !hasNestedNovelParagraph(node, attribute);
  }
  runtime.isNovelParagraphLeaf = isNovelParagraphLeaf;

  /**
   * 段落原文的唯一出口：渲染包裹（`.mt-novel-source`）装进去之后仍要能取到原文，
   * 且**抽取与回填必须走同一个出口**——两边的源文哈希就是据此算出来的。
   * 不可见标记也在这里清掉，让提示词与缓存看不到 RIDI 的零宽水印。
   */
  function getOriginalParagraphText(node) {
    const source = node?.querySelector?.(":scope > .mt-novel-source");
    const text = String(source ? source.textContent : node?.textContent || "").replace(/\r\n?/gu, "\n");
    return sharedUtils.stripInvisibleMarks(text);
  }
  runtime.getOriginalNovelParagraphText = getOriginalParagraphText;

  function findCommonAncestor(nodes, fallback) {
    let current = nodes[0] && nodes[0].parentElement;
    while (current && current !== fallback) {
      if (nodes.every(node => current.contains(node))) return current;
      current = current.parentElement;
    }
    return fallback;
  }
  runtime.findCommonNovelAncestor = findCommonAncestor;
}
