import { installGlossary01 } from "./01-editor.js";
import { installGlossary02 } from "./02-pending.js";
import { installGlossary03 } from "./03-storage.js";
import { installGlossary04 } from "./04-editor.js";
import { installGlossary05 } from "./05-editor.js";

export const glossaryInstallers = Object.freeze([
  installGlossary01,
  installGlossary02,
  installGlossary03,
  installGlossary04,
  installGlossary05
]);

export const glossaryPhases = Object.freeze({
  functions: Object.freeze([installGlossary01, installGlossary02, installGlossary03]),
  state: Object.freeze([installGlossary04]),
  startup: Object.freeze([installGlossary05])
});
