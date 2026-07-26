import { installStitchGeometry } from "./stitch-geometry.js";
import { installStitchNeighbor } from "./stitch-neighbor.js";
import { installStitchPayload } from "./stitch-payload.js";
import { installStitchMapping } from "./stitch-mapping.js";
import { installStitchDebug } from "./stitch-debug.js";
import { installPageStoreBridge } from "./page-store-bridge.js";
import { installStorePipelineContext } from "./store-pipeline-context.js";
import { installCanonicalBridge } from "./canonical-bridge.js";
import { installPipelineHelpers } from "./pipeline-helpers.js";
import { installProjectionBuilder } from "./projection-builder.js";
import { installProjectionUtils } from "./projection-utils.js";
import { installSeamResiduals } from "./seam-residuals.js";
import { installSceneIndexBuilder } from "./scene-index-builder.js";
import { installSceneIndexResolve } from "./scene-index-resolve.js";
import { installSceneIndexUtils } from "./scene-index-utils.js";
import { installDedupeGlobal } from "./dedupe-global.js";
import { installConstantsFsm } from "./constants-fsm.js";
import { installPipelineApi } from "./pipeline-api.js";

export const pipelineInstallers = Object.freeze([
  installStitchGeometry,
  installStitchNeighbor,
  installStitchPayload,
  installStitchMapping,
  installStitchDebug,
  installPageStoreBridge,
  installStorePipelineContext,
  installCanonicalBridge,
  installPipelineHelpers,
  installProjectionBuilder,
  installProjectionUtils,
  installSeamResiduals,
  installSceneIndexBuilder,
  installSceneIndexResolve,
  installSceneIndexUtils,
  installDedupeGlobal,
  installConstantsFsm,
  installPipelineApi
]);

export const pipelinePhases = Object.freeze({
  functions: Object.freeze([
    installStitchGeometry,
    installStitchNeighbor,
    installStitchPayload,
    installStitchMapping,
    installStitchDebug,
    installPageStoreBridge,
    installStorePipelineContext,
    installCanonicalBridge,
    installPipelineHelpers,
    installProjectionBuilder,
    installProjectionUtils,
    installSeamResiduals,
    installSceneIndexBuilder,
    installSceneIndexResolve,
    installSceneIndexUtils,
    installDedupeGlobal
  ]),
  state: Object.freeze([installConstantsFsm]),
  startup: Object.freeze([installPipelineApi])
});
