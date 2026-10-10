/**
 * 配置档案的命名规则。
 *
 * 单独成模块有两个原因：它是纯函数、可以直接单测；`settings/vendor-ui.js` 贴着 400 行门禁，
 * 向导表单每加一个字段都要先在这里腾出位置。
 */

/** 「X 副本」「X 副本 2」…… 复制配置时不撞名。 */
export function nextCopyName(names, name) {
  const taken = new Set(Array.isArray(names) ? names : []);
  const base = `${name} 副本`;
  if (!taken.has(base)) return base;
  for (let index = 2; index < 100; index += 1) {
    const candidate = `${base} ${index}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base} ${Date.now()}`;
}
