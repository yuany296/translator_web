import react from "@vitejs/plugin-react";
import { build } from "vite";
import ts from "typescript";
import vm from "node:vm";
import { mkdir, readFile, rm, writeFile, copyFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const dist = path.join(root, "dist");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await build({
  configFile: false,
  root: path.join(root, "src", "popup"),
  base: "./",
  plugins: [react()],
  build: {
    outDir: path.join(dist, "popup"),
    emptyOutDir: false
  }
});

await buildScript("background", "MangaTranslatorBackground");
await buildScript("content", "MangaTranslatorContent");

await mkdir(path.join(dist, "styles"), { recursive: true });
await copyFile(path.join(root, "src", "styles", "overlay.css"), path.join(dist, "styles", "overlay.css"));
await writeFile(path.join(dist, "manifest.json"), `${JSON.stringify(await loadManifest(), null, 2)}\n`, "utf8");

async function buildScript(entryName, globalName) {
  await build({
    configFile: false,
    root,
    build: {
      outDir: dist,
      emptyOutDir: false,
      sourcemap: true,
      lib: {
        entry: path.join(root, "src", entryName, "index.ts"),
        name: globalName,
        formats: ["iife"],
        fileName: () => `${entryName}/index.js`
      },
      rollupOptions: {
        output: {
          inlineDynamicImports: true
        }
      }
    }
  });
}

async function loadManifest() {
  const source = await readFile(path.join(root, "src", "manifest.ts"), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2022
    }
  }).outputText;
  const module = { exports: {} };
  const sandbox = { module, exports: module.exports };
  vm.runInNewContext(compiled, sandbox, { filename: "manifest.ts" });
  return module.exports.extensionManifest;
}
