import { installGlossaryEditor } from "./glossary-editor.js";
import { installGlossaryPending } from "./glossary-pending.js";
import { installGlossaryStorage } from "./glossary-storage.js";
import { installGlossaryTransfer } from "./glossary-transfer.js";
import { installGlossaryTermsView } from "./glossary-terms-view.js";
import { installGlossaryBatchActions } from "./glossary-batch-actions.js";

import { installGlossaryLibraryStore } from "./glossary-library-store.js";
import { installGlossaryLibraryPanel } from "./glossary-library-panel.js";
import { installNovelMemoryEditor } from "./novel-memory-editor.js";
import { installGlossaryImportTarget } from "./glossary-import-target.js";

export const glossaryInstallers = Object.freeze([
  installGlossaryEditor,
  installGlossaryPending,
  installGlossaryStorage,
  installGlossaryTransfer,
  installGlossaryTermsView,
  installGlossaryBatchActions,
  installGlossaryLibraryStore,
  installGlossaryLibraryPanel,
  installNovelMemoryEditor,
  installGlossaryImportTarget
]);

export const glossaryPhases = Object.freeze({
  functions: Object.freeze([
    installGlossaryEditor,
    installGlossaryPending,
    installGlossaryStorage,
    installGlossaryTransfer,
    installGlossaryTermsView,
    installGlossaryBatchActions,
    installGlossaryLibraryStore,
    installGlossaryLibraryPanel,
    installNovelMemoryEditor,
    installGlossaryImportTarget
  ]),
  state: Object.freeze([]),
  startup: Object.freeze([])
});
