import { installGlossaryEditor } from "./glossary-editor.js";
import { installGlossaryPending } from "./glossary-pending.js";
import { installGlossaryStorage } from "./glossary-storage.js";

export const glossaryInstallers = Object.freeze([
  installGlossaryEditor,
  installGlossaryPending,
  installGlossaryStorage
]);

export const glossaryPhases = Object.freeze({
  functions: Object.freeze([installGlossaryEditor, installGlossaryPending, installGlossaryStorage]),
  state: Object.freeze([]),
  startup: Object.freeze([])
});
