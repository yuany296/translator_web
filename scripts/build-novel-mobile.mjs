import { cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { context } from "esbuild";

// 小说手机版构建：只产出「小说翻译 + 术语库」需要的东西。
//
// 与桌面构建隔离的三条纪律：
//   1. 只读 extension/public 与 extension/novel-mobile-assets，绝不写入它们；
//   2. 临时目录用 dist/.novel-mobile-staging（桌面构建用 dist/.extension-staging），
//      两个构建同时跑（npm run dev + 本脚本）不会互相踩；
//   3. 输出只在 dist/novel-mobile，dist/extension 一个字节都不动。
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "extension", "src", "novel-mobile");
const publicDir = path.join(root, "extension", "public");
const assetsDir = path.join(root, "extension", "novel-mobile-assets");
const outdir = path.join(root, "dist", "novel-mobile");
const staging = path.join(root, "dist", ".novel-mobile-staging");

// 这份 manifest 是手机版唯一的入口描述，语法错误会让浏览器直接拒绝加载，先在这里拦住。
JSON.parse(await readFile(path.join(assetsDir, "manifest.json"), "utf8"));

// 先在临时目录里攒齐全部产物，最后一步整体换上：中途失败时 outdir 仍是上一次可用版本。
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await cp(publicDir, staging, { recursive: true });
// 手机版自己的 manifest 与样式表覆盖/补进共享静态资源里。
await cp(assetsDir, staging, { recursive: true });
// 漫画与本地译文库的页面不属于手机版，页面脚本也已经不再引用它们。
for (const name of [
  "popup.html", "popup.js",
  "sidepanel.html", "sidepanel.js",
  "translations.html", "translations.js"
]) {
  await rm(path.join(staging, name), { force: true });
}

// charset: utf8 —— 这个包里有大量中文提示语，默认的 ascii 转义会把每个汉字写成 6 字节。
const shared = { bundle: true, target: "chrome114", sourcemap: false, logLevel: "info", charset: "utf8" };
const pageEntries = ["content", "quick-popup", "settings", "glossary"];
const configs = [
  // 后台是 MV3 service worker（manifest 里 type: module），必须保持 ESM。
  { ...shared, entryPoints: [path.join(source, "background.js")], outfile: path.join(staging, "background.js"), format: "esm" },
  ...pageEntries.map((name) => ({
    ...shared, entryPoints: [path.join(source, `${name}.js`)], outfile: path.join(staging, `${name}.js`), format: "iife"
  }))
];

await Promise.all(configs.map((cfg) => context(cfg).then((ctx) => ctx.rebuild().finally(() => ctx.dispose()))));
await rm(outdir, { recursive: true, force: true });
await rename(staging, outdir);
console.log(`小说手机版扩展已生成：${outdir}`);
