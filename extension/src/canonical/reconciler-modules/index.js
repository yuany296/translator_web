import { installReconciler01 } from "./01-observation.js";
import { installReconciler02 } from "./02-seam.js";
import { installReconciler03 } from "./03-seam.js";
import { installReconciler04 } from "./04-canonical.js";
import { installReconciler05 } from "./05-canonical.js";
import { installReconciler06 } from "./06-projection.js";
import { installReconciler07 } from "./07-projection.js";
import { installReconciler08 } from "./08-store.js";
import { installReconciler09 } from "./09-observation.js";
import { installReconciler10 } from "./10-store.js";
import { installReconciler11 } from "./11-store.js";

export const reconcilerInstallers = Object.freeze([
  installReconciler01,
  installReconciler02,
  installReconciler03,
  installReconciler04,
  installReconciler05,
  installReconciler06,
  installReconciler07,
  installReconciler08,
  installReconciler09,
  installReconciler10,
  installReconciler11
]);

export const reconcilerPhases = Object.freeze({
  functions: Object.freeze([installReconciler01, installReconciler02, installReconciler03, installReconciler04, installReconciler05, installReconciler06, installReconciler07, installReconciler08]),
  state: Object.freeze([installReconciler09, installReconciler10]),
  startup: Object.freeze([installReconciler11])
});
