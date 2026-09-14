/**
 * 决定「导入文件」的术语落到哪个术语库（对齐沉浸式翻译：先选库，再导入）。
 *
 * 规则（用户已拍板）：
 * - 左侧术语库列表里**选中了某个库** → 本次导入全部进该库（沉浸式翻译同款交互：
 *   上下文就是答案，不弹任何窗）；
 * - 当前是「显示全部」→ **CSV 一个文件就是一套术语库，库名取自文件名**
 *   （`骸骨皇女.csv` → 库「骸骨皇女」，同名复用、不存在自动建）；
 * - JSON 是本扩展的备份格式，自带完整库结构 → 保留自带归属
 *   （按文件名反而会把多本书的条目塞进一个库）；
 * - CSV 的 library（库名）列已废弃：导入去向完全由上面两条决定，不再读取。
 */
/** 从文件名推导术语库名：去扩展名 → 剥尾部语言码 → 去复制副本 → 折叠空白。 */
export function deriveLibraryName(fileName) {
  let name = String(fileName || "").replace(/\.[A-Za-z0-9]+$/u, "");
  // 沉浸式翻译导出的文件常带尾部语言码：terms_ko.csv / terms_zh-CN.csv
  name = name.replace(/[_\-. ]+(?:zh-CN|zh-TW|zh|ko|ja|en|auto)$/iu, "");
  // Windows 复制副本：xxx (1) / xxx - 副本
  name = name.replace(/\s*[(（]\d+[)）]\s*$/u, "");
  name = name.replace(/\s*-\s*副本\s*$/u, "");
  return name.replace(/\s+/gu, " ").trim();
}

export function installGlossaryImportTarget(runtime) {
  /**
   * 返回导入去向：
   *   { mode:"library", libraryId } → 全部条目进左侧当前选中的库
   *   { mode:"name", name }         → 全部条目进以该名命名的库（不存在自动建）
   *   { mode:"attribution" }        → JSON 按自带归属，并缺失的库定义
   */
  runtime.resolveImportTarget = ({ fileName, kind } = {}) => {
    const activeLibraryId = runtime.glossaryCore.normalizeLibraryId(runtime.activeLibraryId);
    if (activeLibraryId) {
      return { mode: "library", libraryId: activeLibraryId };
    }
    if (kind === "json") {
      return { mode: "attribution" };
    }
    return { mode: "name", name: deriveLibraryName(fileName) };
  };
}
