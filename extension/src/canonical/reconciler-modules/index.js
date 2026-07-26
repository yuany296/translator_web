import { installReconcilerObservation } from "./reconciler-observation.js";
import { installReconcilerSeam } from "./reconciler-seam.js";
import { installReconcilerSeamEval } from "./reconciler-seam-eval.js";
import { installReconcilerFragmentGroups } from "./reconciler-fragment-groups.js";
import { installReconcilerCanonical } from "./reconciler-canonical.js";
import { installReconcilerHistory } from "./reconciler-history.js";
import { installReconcilerProjection } from "./reconciler-projection.js";
import { installReconcilerProjectionUtils } from "./reconciler-projection-utils.js";
import { installReconcilerStore } from "./reconciler-store.js";
import { installReconcilerConstants } from "./reconciler-constants.js";
import { installReconcilerApi } from "./reconciler-api.js";
import { installReconcilerStartup } from "./reconciler-startup.js";

export const reconcilerInstallers = Object.freeze([
  installReconcilerObservation,
  installReconcilerSeam,
  installReconcilerSeamEval,
  installReconcilerFragmentGroups,
  installReconcilerCanonical,
  installReconcilerHistory,
  installReconcilerProjection,
  installReconcilerProjectionUtils,
  installReconcilerStore,
  installReconcilerConstants,
  installReconcilerApi,
  installReconcilerStartup
]);

export const reconcilerPhases = Object.freeze({
  functions: Object.freeze([
    installReconcilerObservation,
    installReconcilerSeam,
    installReconcilerSeamEval,
    installReconcilerFragmentGroups,
    installReconcilerCanonical,
    installReconcilerHistory,
    installReconcilerProjection,
    installReconcilerProjectionUtils,
    installReconcilerStore
  ]),
  state: Object.freeze([installReconcilerConstants, installReconcilerApi]),
  startup: Object.freeze([installReconcilerStartup])
});
