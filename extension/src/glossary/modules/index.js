import { installGlossaryEditor } from "./glossary-editor.js";
import { installGlossaryPending } from "./glossary-pending.js";
import { installGlossaryStorage } from "./glossary-storage.js";
import { installGlossaryTransfer } from "./glossary-transfer.js";
import { installGlossaryTermsView } from "./glossary-terms-view.js";
import { installGlossarySearch } from "./glossary-search.js";
import { installGlossaryBatchActions } from "./glossary-batch-actions.js";
import { installGlossaryMoveNewLibrary } from "./glossary-move-new-library.js";

import { installGlossaryLibraryStore } from "./glossary-library-store.js";
import { installGlossaryLibraryPanel } from "./glossary-library-panel.js";
import { installGlossaryLibrarySettings } from "./glossary-library-settings.js";
import { installGlossaryLibraryTest } from "./glossary-library-test.js";
import { installGlossaryLibraryLifecycle } from "./glossary-library-lifecycle.js";
import { installNovelMemoryEditor } from "./novel-memory-editor.js";
import { installGlossaryImportTarget } from "./glossary-import-target.js";
import { installGlossaryViewRouter } from "./glossary-view-router.js";

export const glossaryInstallers = Object.freeze([
  installGlossaryEditor,
  installGlossaryPending,
  installGlossaryStorage,
  installGlossaryTransfer,
  installGlossarySearch,
  installGlossaryTermsView,
  installGlossaryBatchActions,
  installGlossaryMoveNewLibrary,
  installGlossaryLibraryStore,
  installGlossaryLibraryPanel,
  installGlossaryLibrarySettings,
  installGlossaryLibraryTest,
  installGlossaryLibraryLifecycle,
  installNovelMemoryEditor,
  installGlossaryImportTarget,
  installGlossaryViewRouter
]);

export const glossaryPhases = Object.freeze({
  functions: Object.freeze([
    installGlossaryEditor,
    installGlossaryPending,
    installGlossaryStorage,
    installGlossaryTransfer,
    installGlossarySearch,
    installGlossaryTermsView,
    installGlossaryBatchActions,
    installGlossaryLibraryStore,
    installGlossaryLibraryPanel,
    installGlossaryLibrarySettings,
    installGlossaryLibraryTest,
    installGlossaryLibraryLifecycle,
    installNovelMemoryEditor,
    installGlossaryImportTarget,
    installGlossaryViewRouter
  ]),
  state: Object.freeze([]),
  startup: Object.freeze([])
});
