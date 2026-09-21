/**
 * 手机版：把「这次请求是哪一页 / 什么语言」传给术语前言构造器。
 *
 * 现象（用户实测）：同一个术语库，
 *   - 应用网址为空（全站生效）→ 术语照用；
 *   - 点过「一键加入应用」（应用网址非空）→ 一大批术语被模型忽略，人名开始自己发挥。
 *
 * 根因在共享代码里，跟提示词措辞无关：
 *   novel-translation.js#buildPrompt 构造术语前言时只传了 scopeKey ——
 *      runtime.glossaryCore.buildPrompt(glossary, items, { scopeKey: context.scopeKey })
 *   而 shared/glossary.js#getEnabledEntries 是用 pageUrl 判定「这个库的术语在哪些页面生效」的：
 *      libraryApplyUrlMatches(pageUrl, applyUrls)：
 *        applyUrls 为空        → true（全站生效）
 *        非空但没有 pageUrl    → false   ← 这里就翻车了
 *   于是应用网址一旦非空，这个库的**全部术语都不会进提示词**，模型当然只能自己发挥。
 *   而校验器与使用统计用的是带 pageUrl 的完整上下文（sender.tab.url），
 *   它们认为「术语注入过了」—— 表现就是进度行上「用上 n/m」里 n 明显小于 m。
 *
 * 修法：把每次请求的 pageUrl / 语言按 scopeKey 记下来，术语前言构造器按同一个 scopeKey
 * 取回来补进上下文。同一个作品（同一 scopeKey）的章节共享生效范围，所以按 scopeKey 记录是准的；
 * 只补调用方没给的字段，绝不覆盖显式传入的值（网页/漫画那两条路径本来就带着完整上下文）。
 */
const MAX_TRACKED_WORKS = 20;
const remembered = new Map();

/** 记下这次请求的上下文（在真正处理请求之前调用，见 term-usage-local.js）。 */
export function rememberRequestContext(scopeKey, context = null) {
  const key = String(scopeKey || "");
  if (!key) return null;
  const entry = {
    pageUrl: String(context && context.pageUrl || ""),
    sourceLanguage: String(context && context.sourceLanguage || ""),
    targetLanguage: String(context && context.targetLanguage || "")
  };
  // 重新 set 一次把 key 挪到末尾，超量时淘汰最早的作品，避免长期挂着无上限的作品列表
  remembered.delete(key);
  remembered.set(key, entry);
  while (remembered.size > MAX_TRACKED_WORKS) {
    remembered.delete(remembered.keys().next().value);
  }
  return entry;
}

export function requestContextFor(scopeKey) {
  return remembered.get(String(scopeKey || "")) || null;
}

/** 用记下来的上下文补全调用方漏掉的字段；没有记录或已完整时原样返回。 */
export function withRequestContext(context = null) {
  const scopeKey = String(context && context.scopeKey || "");
  const entry = scopeKey ? requestContextFor(scopeKey) : null;
  if (!entry) return context;
  const next = { ...(context || {}) };
  let changed = false;
  for (const field of ["pageUrl", "sourceLanguage", "targetLanguage"]) {
    if (!next[field] && entry[field]) {
      next[field] = entry[field];
      changed = true;
    }
  }
  return changed ? next : context;
}

export function forgetRequestContexts() {
  remembered.clear();
}
