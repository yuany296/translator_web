// 供 chrome-devtools-mcp 在小说页面执行：检查渲染译文是否保留对话引号。
// 用法：在新会话里让模型用 mcp__chrome-devtools 工具，
// 用 Runtime.evaluate（evaluate_script）执行本表达式的字符串内容。
//
// Kakao 小说正文在 shadow root 内，必须经由 viewer-container.shadowRoot 取，
// 普通 document.querySelector 拿不到 data-p-id 段落。
export const checkNovelQuotesExpression = `(() => {
  const viewer = document.querySelector("[data-testid='viewer-container']");
  if (!viewer) return { ok: false, reason: "no viewer-container" };
  const root = viewer.shadowRoot;
  if (!root) return { ok: false, reason: "viewer has no shadowRoot" };
  const nodes = [...root.querySelectorAll("[data-p-id]")].filter(n =>
    /^(?:H[1-6]|P|DIV)$/u.test(String(n.tagName || ""))
  );
  if (nodes.length === 0) return { ok: false, reason: "no [data-p-id] paragraphs" };
  return {
    ok: true,
    total: nodes.length,
    samples: nodes.slice(0, 12).map(n => {
      const src = n.querySelector(":scope > .mt-novel-source");
      const tr = n.querySelector(":scope > .mt-novel-translation");
      return {
        id: n.getAttribute("data-p-id"),
        translated: tr ? String(tr.textContent).trim().slice(0, 60) : null,
        source: src ? String(src.textContent).trim().slice(0, 40) : null
      };
    })
  };
})()`;

export default checkNovelQuotesExpression;
