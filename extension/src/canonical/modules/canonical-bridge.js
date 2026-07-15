import { installCanonicalSetup } from "../canonical-pipeline-factory/canonical-setup.js";
import { installCanonicalPageOcr } from "../canonical-pipeline-factory/canonical-page-ocr.js";
import { installCanonicalSeamOcr } from "../canonical-pipeline-factory/canonical-seam-ocr.js";
import { installCanonicalTranslate } from "../canonical-pipeline-factory/canonical-translate.js";
import { installCanonicalRender } from "../canonical-pipeline-factory/canonical-render.js";

export function installCanonicalBridge(runtime) {
  const installers = [installCanonicalSetup, installCanonicalPageOcr, installCanonicalSeamOcr, installCanonicalTranslate, installCanonicalRender];
  runtime.createCanonicalPipeline = function createCanonicalPipeline(...args) {
    const scope = Object.assign(Object.create(null), { adapters: args[0] });
    for (const install of installers) install(runtime, scope);
    return scope.result;
  };
}
