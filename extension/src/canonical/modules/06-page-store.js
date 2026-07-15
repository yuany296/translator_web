import { installCreateStore01 } from "../page-store-factory/01.js";
import { installCreateStore02 } from "../page-store-factory/02.js";
import { installCreateStore03 } from "../page-store-factory/03.js";

export function installPipeline06(runtime) {
  const installers = [installCreateStore01, installCreateStore02, installCreateStore03];
  runtime.createStore = function createStore(...args) {
    const scope = Object.assign(Object.create(null), {  });
    for (const install of installers) install(runtime, scope);
    return scope.result;
  };
}
