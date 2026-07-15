import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Each merge: [dir, sourceFile, targetFile]
// Content from source's install function body is appended to target's install function body.
// Source file is deleted after merge.
const merges = [
  // Background
  ["extension/src/background/modules", "messages-constants.js", "messages.js"],
  // Content
  ["extension/src/content/modules", "recognition-constants.js", "recognition-binding.js"],
  ["extension/src/content/modules", "reader-store.js", "reader-api.js"],
  ["extension/src/content/modules", "preload-sweep.js", "scheduler.js"],
  ["extension/src/content/modules", "capture-helpers.js", "capture-payload.js"],
  // Canonical
  ["extension/src/canonical/modules", "pipeline-errors.js", "constants-fsm.js"],
  // Glossary
  ["extension/src/glossary/modules", "glossary-dom.js", "glossary-editor.js"],
  ["extension/src/glossary/modules", "glossary-startup.js", "glossary-editor.js"],
];

for (const [dir, sourceFile, targetFile] of merges) {
  const dirPath = path.join(root, dir);
  const sourcePath = path.join(dirPath, sourceFile);
  const targetPath = path.join(dirPath, targetFile);

  const sourceContent = readFileSync(sourcePath, "utf8");
  const targetContent = readFileSync(targetPath, "utf8");

  // Extract body of source install function (everything between first { and last })
  const sourceBodyMatch = sourceContent.match(/export function \w+\(runtime\) \{([\s\S]*)\n\}\s*$/);
  if (!sourceBodyMatch) {
    console.log(`SKIP ${sourceFile}: could not parse install function body`);
    continue;
  }
  const sourceBody = sourceBodyMatch[1];

  // Find the closing } of the target's install function (last } in file)
  const lastBraceIdx = targetContent.lastIndexOf("\n}");
  if (lastBraceIdx === -1) {
    console.log(`SKIP ${targetFile}: could not find closing brace`);
    continue;
  }

  // Insert source body before the closing brace
  const merged = targetContent.slice(0, lastBraceIdx) + "\n" + sourceBody + targetContent.slice(lastBraceIdx);

  writeFileSync(targetPath, merged, "utf8");
  unlinkSync(sourcePath);
  console.log(`MERGED: ${sourceFile} → ${targetFile}`);
}

console.log("\nDone. Now update index.js files to remove merged imports.");
