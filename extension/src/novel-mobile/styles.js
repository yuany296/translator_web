/**
 * 手机版布局样式注入。
 *
 * novel-mobile.css 是纯覆盖层，追加到 <head> 末尾即可压过页面自带规则
 * （术语库页的规则写在 HTML 内联 <style> 里，同样靠「后加载」取胜）。
 * 三个页面脚本都在 body 末尾加载，本地样式表几乎瞬时到位。
 */
const STYLE_HREF = "novel-mobile.css";

export function injectNovelMobileStyles(doc = globalThis.document) {
  if (!doc || !doc.head) return false;
  if (doc.querySelector("link[data-mt-novel-mobile]")) return false;
  const link = doc.createElement("link");
  link.rel = "stylesheet";
  link.href = STYLE_HREF;
  link.dataset.mtNovelMobile = "true";
  doc.head.appendChild(link);
  return true;
}
