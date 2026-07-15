import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Each entry: [dir, oldFileName, newFileName, oldFunc, newFunc]
const renames = [
  // reconciler-modules
  ["canonical/reconciler-modules", "01-observation.js", "reconciler-observation.js", "installReconciler01", "installReconcilerObservation"],
  ["canonical/reconciler-modules", "02-seam.js", "reconciler-seam.js", "installReconciler02", "installReconcilerSeam"],
  ["canonical/reconciler-modules", "03-seam.js", "reconciler-seam-eval.js", "installReconciler03", "installReconcilerSeamEval"],
  ["canonical/reconciler-modules", "04-canonical.js", "reconciler-canonical.js", "installReconciler04", "installReconcilerCanonical"],
  ["canonical/reconciler-modules", "05-canonical.js", "reconciler-history.js", "installReconciler05", "installReconcilerHistory"],
  ["canonical/reconciler-modules", "06-projection.js", "reconciler-projection.js", "installReconciler06", "installReconcilerProjection"],
  ["canonical/reconciler-modules", "07-projection.js", "reconciler-projection-utils.js", "installReconciler07", "installReconcilerProjectionUtils"],
  ["canonical/reconciler-modules", "08-store.js", "reconciler-store.js", "installReconciler08", "installReconcilerStore"],
  ["canonical/reconciler-modules", "09-observation.js", "reconciler-constants.js", "installReconciler09", "installReconcilerConstants"],
  ["canonical/reconciler-modules", "10-store.js", "reconciler-api.js", "installReconciler10", "installReconcilerApi"],
  ["canonical/reconciler-modules", "11-store.js", "reconciler-startup.js", "installReconciler11", "installReconcilerStartup"],
  // pipeline-factory
  ["canonical/pipeline-factory", "01.js", "pipeline-legacy-setup.js", "installCreatePipeline01", "installPipelineLegacySetup"],
  ["canonical/pipeline-factory", "02.js", "pipeline-legacy-exec.js", "installCreatePipeline02", "installPipelineLegacyExec"],
  // canonical-pipeline-factory
  ["canonical/canonical-pipeline-factory", "01.js", "canonical-setup.js", "installCreateCanonicalPipeline01", "installCanonicalSetup"],
  ["canonical/canonical-pipeline-factory", "02.js", "canonical-page-ocr.js", "installCreateCanonicalPipeline02", "installCanonicalPageOcr"],
  ["canonical/canonical-pipeline-factory", "03.js", "canonical-seam-ocr.js", "installCreateCanonicalPipeline03", "installCanonicalSeamOcr"],
  ["canonical/canonical-pipeline-factory", "04.js", "canonical-translate.js", "installCreateCanonicalPipeline04", "installCanonicalTranslate"],
  ["canonical/canonical-pipeline-factory", "05.js", "canonical-render.js", "installCreateCanonicalPipeline05", "installCanonicalRender"],
  // page-store-factory
  ["canonical/page-store-factory", "01.js", "store-state.js", "installCreateStore01", "installStoreState"],
  ["canonical/page-store-factory", "02.js", "store-methods.js", "installCreateStore02", "installStoreMethods"],
  ["canonical/page-store-factory", "03.js", "store-canonical.js", "installCreateStore03", "installStoreCanonical"],
  // glossary/modules
  ["glossary/modules", "01-editor.js", "glossary-editor.js", "installGlossary01", "installGlossaryEditor"],
  ["glossary/modules", "02-pending.js", "glossary-pending.js", "installGlossary02", "installGlossaryPending"],
  ["glossary/modules", "03-storage.js", "glossary-storage.js", "installGlossary03", "installGlossaryStorage"],
  ["glossary/modules", "04-editor.js", "glossary-dom.js", "installGlossary04", "installGlossaryDom"],
  ["glossary/modules", "05-editor.js", "glossary-startup.js", "installGlossary05", "installGlossaryStartup"],
];

for (const [dir, oldName, newName, oldFunc, newFunc] of renames) {
  const absDir = path.join(root, "extension", "src", dir);
  const oldPath = path.join(absDir, oldName);
  const newPath = path.join(absDir, newName);
  try {
    execSync(`git mv "${oldPath}" "${newPath}"`, { cwd: root, stdio: "pipe" });
    console.log(`${dir}/${oldName} → ${newName}`);
  } catch (err) {
    console.log(`SKIP ${dir}/${oldName}: ${err.message.slice(0, 80)}`);
    continue;
  }
  // Update function name
  let content = readFileSync(newPath, "utf8");
  content = content.replaceAll(`function ${oldFunc}`, `function ${newFunc}`);
  content = content.replaceAll(`runtime.${oldFunc} = ${oldFunc}`, `runtime.${newFunc} = ${newFunc}`);
  content = content.replaceAll(oldFunc, newFunc);
  writeFileSync(newPath, content, "utf8");
}

console.log("\nNow update index files in sub-directories manually.");
