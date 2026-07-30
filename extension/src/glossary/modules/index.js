import { installGlossaryEditor } from "./glossary-editor.js";
import { installGlossaryPending } from "./glossary-pending.js";
import { installGlossaryStorage } from "./glossary-storage.js";
import { installNovelMemoryEditor } from "./novel-memory-editor.js";

export const glossaryInstallers = Object.freeze([
  installGlossaryEditor,
  installGlossaryPending,
  installGlossaryStorage,
  installNovelMemoryEditor
]);

export const glossaryPhases = Object.freeze({
  functions: Object.freeze([installGlossaryEditor, installGlossaryPending, installGlossaryStorage, installNovelMemoryEditor]),
  state: Object.freeze([]),
  startup: Object.freeze([])
});
