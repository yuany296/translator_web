import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const source = path.join(root, "extension", "src");
const publicDir = path.join(root, "extension", "public");
const outdir = path.join(root, "dist", "extension");
const testOutdir = path.join(root, "dist", "test");
JSON.parse(await readFile(path.join(publicDir, "manifest.json"), "utf8"));
await rm(outdir, { recursive: true, force: true });
await mkdir(outdir, { recursive: true });
await mkdir(testOutdir, { recursive: true });
await cp(publicDir, outdir, { recursive: true });

const shared = { bundle: true, target: "chrome114", sourcemap: false, logLevel: "info" };
await build({
  ...shared,
  entryPoints: [path.join(source, "background", "index.js")],
  outfile: path.join(outdir, "background.js"),
  format: "esm"
});
await build({
  ...shared,
  entryPoints: [path.join(source, "background", "index.js")],
  outfile: path.join(testOutdir, "background.iife.js"),
  format: "iife",
  globalName: "MtBackgroundModule"
});
for (const name of ["content", "popup", "glossary"]) {
  await build({
    ...shared,
    entryPoints: [path.join(source, name, "index.js")],
    outfile: path.join(outdir, `${name}.js`),
    format: "iife"
  });
}
console.log(`扩展已生成：${outdir}`);
