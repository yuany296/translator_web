import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// dist/extension 完整性门禁：manifest 引用到的文件必须都在。
// 少了 JS 产物时 Chrome 会直接拒绝加载扩展（「未能成功加载扩展程序」），
// 而那种半成品以前只有到浏览器里才会发现——这里先拦住。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dir = path.join(root, "dist", "extension");

function main() {
  const manifestPath = path.join(dir, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    console.error(`扩展产物缺失：${path.relative(root, manifestPath)}（先跑 npm run build）`);
    return 1;
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  } catch (error) {
    console.error(`扩展 manifest.json 解析失败：${error.message}`);
    return 1;
  }
  const referenced = [
    manifest.background && manifest.background.service_worker,
    manifest.action && manifest.action.default_popup,
    manifest.options_ui && manifest.options_ui.page,
    manifest.side_panel && manifest.side_panel.default_path,
    ...Object.values(manifest.icons || {}),
    ...(manifest.content_scripts || []).flatMap(script => [...(script.js || []), ...(script.css || [])]),
    ...((manifest.web_accessible_resources || []).flatMap(entry => entry.resources || []))
  ].filter(Boolean).filter(relative => !relative.includes("*"));
  const missing = referenced.filter(relative => !fs.existsSync(path.join(dir, relative)));
  // JS 产物单独兜底：manifest 不直接引用它们，但没有它们扩展一样加载不了。
  for (const name of ["background", "content", "glossary", "settings", "sidepanel", "quick-popup", "translations"]) {
    const relative = `${name}.js`;
    if (!fs.existsSync(path.join(dir, relative))) {
      missing.push(relative);
    }
  }
  if (missing.length) {
    console.error("扩展产物不完整，Chrome 会拒绝加载：");
    for (const item of [...new Set(missing)]) {
      console.error(`  缺失 ${item}`);
    }
    console.error("跑一次 `npm run build` 重新生成 dist/extension 即可。");
    return 1;
  }
  console.log(`扩展产物完整（${new Set(referenced).size} 个 manifest 引用 + 8 个 JS 产物）`);
  return 0;
}

process.exitCode = main();
