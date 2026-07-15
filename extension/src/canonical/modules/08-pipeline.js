import { installCreatePipeline01 } from "../pipeline-factory/01.js";
import { installCreatePipeline02 } from "../pipeline-factory/02.js";

export function installPipeline08(runtime) {
  const installers = [installCreatePipeline01, installCreatePipeline02];
  runtime.createPipeline = function createPipeline(...args) {
    const scope = Object.assign(Object.create(null), { adapters: args[0] });
    for (const install of installers) install(runtime, scope);
    return scope.result;
  };
}
