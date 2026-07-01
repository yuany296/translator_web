import { execFileSync } from "node:child_process";
import { copyFile, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");
const extensionFiles = [
  "manifest.json",
  "background.js",
  "kakao-pipeline.js",
  "content.js",
  "popup.html",
  "popup.js",
  "styles.css"
];

// 根目录是唯一源码；构建只负责校验并生成可加载副本。
JSON.parse(await readFile(path.join(root, "manifest.json"), "utf8"));
for (const file of ["background.js", "kakao-pipeline.js", "content.js", "popup.js"]) {
  execFileSync(process.execPath, ["--check", path.join(root, file)], { stdio: "inherit" });
}

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });
for (const file of extensionFiles) {
  await copyFile(path.join(root, file), path.join(dist, file));
}

console.log(`已从根目录生成扩展副本：${dist}`);
