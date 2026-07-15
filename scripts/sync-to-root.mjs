// 从 src/ 同步到根目录，使 Chrome 能加载最新代码。
// 用法：node scripts/sync-to-root.mjs
// 开发工作流：在 src/ 中编辑 → npm run dev → 重载 Chrome 扩展

import { copyFile, mkdir, readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const extensionFiles = [
  "manifest.json",
  "background.js",
  "kakao-reconciler.js",
  "kakao-pipeline.js",
  "content.js",
  "popup.html",
  "popup.js",
  "glossary.html",
  "glossary-core.js",
  "term-discovery-core.js",
  "glossary.js",
  "styles.css",
  "core/utils.js",
];

try {
  await readFile(path.join(src, "manifest.json"), "utf8");
} catch {
  console.error(
    "错误：src/manifest.json 不存在\n" +
    "请确保在项目根目录运行此脚本，并且源文件已放入 src/ 目录。"
  );
  process.exit(1);
}

for (const file of extensionFiles) {
  const dest = path.join(root, file);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(path.join(src, file), dest);
}

console.log(`✅ 已同步 ${extensionFiles.length} 个文件从 src/ 到根目录`);
