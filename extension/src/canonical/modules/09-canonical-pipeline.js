import { installCreateCanonicalPipeline01 } from "../canonical-pipeline-factory/01.js";
import { installCreateCanonicalPipeline02 } from "../canonical-pipeline-factory/02.js";
import { installCreateCanonicalPipeline03 } from "../canonical-pipeline-factory/03.js";
import { installCreateCanonicalPipeline04 } from "../canonical-pipeline-factory/04.js";
import { installCreateCanonicalPipeline05 } from "../canonical-pipeline-factory/05.js";

export function installPipeline09(runtime) {
  const installers = [installCreateCanonicalPipeline01, installCreateCanonicalPipeline02, installCreateCanonicalPipeline03, installCreateCanonicalPipeline04, installCreateCanonicalPipeline05];
  runtime.createCanonicalPipeline = function createCanonicalPipeline(...args) {
    const scope = Object.assign(Object.create(null), { adapters: args[0] });
    for (const install of installers) install(runtime, scope);
    return scope.result;
  };
}
