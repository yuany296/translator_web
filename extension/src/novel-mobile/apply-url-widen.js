/**
 * 手机版：「一键加入应用」不该把术语库锁死在单个章节上。
 *
 * 术语库有两套网址（见 shared/glossary.js#getEnabledEntries）：
 *   - 绑定网址 urls：决定**归集**（新提取的术语进哪个库）；
 *   - 应用网址 applyUrls：决定**生效** —— 空 = 全站生效；非空 = 只在这些网址生效。
 * 「一键加入应用」做的事就是把绑定网址复制进应用网址。问题在于阅读器的绑定网址常是
 * **章节级**的：KakaoPage 小说地址是 `page.kakao.com/content/{作品}/viewer/{章节}`，
 * 从某一章「按网址建库」得到的绑定就是这一章的地址。复制进应用网址之后，
 * 应用名单从空（全站生效）变成「只有这一章」，于是：
 *
 *   加入应用之前 → 术语全站生效 → 好用
 *   加入应用之后 → 只有那一章命中 → 换一章就「术语不生效了」
 *
 * 这跟手机/桌面无关，是「章节级网址当应用范围」这件事本身的坑；但手机上没法开 DevTools，
 * 用户只能看到「术语突然不生效了」。这里在点「一键加入应用」的**捕获阶段**先把绑定网址里的
 * 章节地址放宽成作品地址（`.../content/{作品}/viewer/{章节}` → `.../content/{作品}/*`），
 * 再让原来的处理器照常合并、保存 —— 归集与生效同时变成整个作品，符合「这是这本书的术语库」的本意。
 *
 * 只认同 KakaoPage 阅读器那一种形状（`/viewer/` 之后是章节标识），其它地址一个字不动：
 * 猜错范围比范围偏窄更糟（范围窄只是不生效，范围错会让别的小说的术语串进来）。
 */

const VIEWER_TAIL_RE = /\/viewer\/.*$/u;

/** 章节级阅读地址 → 作品级地址；没有 `/viewer/` 的地址原样返回。 */
export function widenApplyUrl(value) {
  const raw = String(value || "").trim();
  if (!raw) return raw;
  const clean = raw.replace(/[#?].*$/u, "");
  const widened = clean.replace(VIEWER_TAIL_RE, "/*");
  return widened === clean ? raw : widened;
}

/** 列表态的绑定网址输入框；批量编辑态读文本框（两条都放宽，谁在用就会被读到）。 */
function collectBoundInputs(doc) {
  return {
    rows: Array.from(doc.querySelectorAll("#libraryUrlList input[data-action='edit-url']")),
    bulk: doc.getElementById("libraryUrlsInput")
  };
}

export function widenBoundUrlFields(doc = globalThis.document) {
  const { rows, bulk } = collectBoundInputs(doc);
  let changed = false;
  for (const input of rows) {
    const next = widenApplyUrl(input.value);
    if (next && next !== input.value) {
      input.value = next;
      changed = true;
    }
  }
  if (bulk && bulk.value) {
    const next = String(bulk.value).split(/\r?\n/u).map(widenApplyUrl).join("\n");
    if (next !== bulk.value) {
      bulk.value = next;
      changed = true;
    }
  }
  return changed;
}

/**
 * 装在术语库页上：
 *   - 「一键加入应用」用**捕获阶段**监听：先放宽绑定网址，再让原处理器（模块私有，改不得）跑；
 *   - 行内「应用」按钮走 `runtime.applySingleUrl`（晚绑定），包一层即可。
 */
export function installApplyUrlWidening(runtime, doc = globalThis.document) {
  const button = doc.getElementById("libraryApplyAllBtn");
  if (button && typeof button.addEventListener === "function") {
    button.addEventListener("click", () => widenBoundUrlFields(doc), true);
  }
  const applySingle = runtime.applySingleUrl;
  if (typeof applySingle === "function") {
    runtime.applySingleUrl = url => applySingle(widenApplyUrl(url));
  }
  return runtime;
}
