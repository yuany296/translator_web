import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(root, "src");
const dist = path.join(root, "dist");
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

// src/ 是源码；构建负责校验并生成可加载副本到 dist/。
JSON.parse(await readFile(path.join(src, "manifest.json"), "utf8"));
for (const file of ["background.js", "kakao-reconciler.js", "kakao-pipeline.js", "content.js", "popup.js", "glossary-core.js", "term-discovery-core.js", "glossary.js", "core/utils.js"]) {
  execFileSync(process.execPath, ["--check", path.join(src, file)], { stdio: "inherit" });
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const file of extensionFiles) {
  const dest = path.join(dist, file);
  await mkdir(path.dirname(dest), { recursive: true });
  await copyFile(path.join(src, file), dest);
}

console.log(`已从 src/ 生成扩展副本：${dist}`);
