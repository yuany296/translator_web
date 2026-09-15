import { cp, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { context } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "extension", "src");
const publicDir = path.join(root, "extension", "public");
const outdir = path.join(root, "dist", "extension");
// 先在临时目录里攒齐全部产物，最后一步才整体换上：
// 构建中途失败/被打断时，dist/extension 仍是上一次能加载的完整版本，
// 不会出现「只有 HTML、没有 JS」的半成品（Chrome 会直接拒绝加载扩展）。
const staging = path.join(root, "dist", ".extension-staging");
const testOutdir = path.join(root, "dist", "test");
const watch = process.argv.includes("--watch");

JSON.parse(await readFile(path.join(publicDir, "manifest.json"), "utf8"));
await rm(staging, { recursive: true, force: true });
await mkdir(staging, { recursive: true });
await mkdir(testOutdir, { recursive: true });
await cp(publicDir, staging, { recursive: true });

const shared = { bundle: true, target: "chrome114", sourcemap: false, logLevel: "info" };
const configs = [
  { ...shared, entryPoints: [path.join(source, "background", "index.js")], outfile: path.join(staging, "background.js"), format: "esm" },
  { ...shared, entryPoints: [path.join(source, "background", "index.js")], outfile: path.join(testOutdir, "background.iife.js"), format: "iife", globalName: "MtBackgroundModule" },
  ...["content", "popup", "quick-popup", "settings", "glossary", "translations", "sidepanel"].map((name) => ({
    ...shared, entryPoints: [path.join(source, name, "index.js")], outfile: path.join(staging, `${name}.js`), format: "iife"
  }))
];

if (watch) {
  // watch 模式不换目录（换掉会让正在监听的输出路径失效），但同样先清空再写。
  await rm(outdir, { recursive: true, force: true });
  await mkdir(outdir, { recursive: true });
  await cp(staging, outdir, { recursive: true });
  const watchConfigs = configs.map((cfg) => ({
    ...cfg,
    outfile: cfg.outfile.replace(staging, outdir)
  }));
  const contexts = await Promise.all(watchConfigs.map((cfg) => context(cfg)));
  await Promise.all(contexts.map((ctx) => ctx.watch()));
  console.log("watching for changes...");
} else {
  await Promise.all(configs.map((cfg) => context(cfg).then((ctx) => ctx.rebuild().finally(() => ctx.dispose()))));
  await rm(outdir, { recursive: true, force: true });
  await rename(staging, outdir);
  console.log(`扩展已生成：${outdir}`);
}
