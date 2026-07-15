import { installPipeline01 } from "./01-geometry.js";
import { installPipeline02 } from "./02-geometry.js";
import { installPipeline03 } from "./03-geometry.js";
import { installPipeline04 } from "./04-geometry.js";
import { installPipeline05 } from "./05-geometry.js";
import { installPipeline06 } from "./06-page-store.js";
import { installPipeline07 } from "./07-page-store.js";
import { installPipeline08 } from "./08-pipeline.js";
import { installPipeline09 } from "./09-canonical-pipeline.js";
import { installPipeline10 } from "./10-canonical-pipeline.js";
import { installPipeline11 } from "./11-projection.js";
import { installPipeline12 } from "./12-projection.js";
import { installPipeline13 } from "./13-scene-index.js";
import { installPipeline14 } from "./14-scene-index.js";
import { installPipeline15 } from "./15-scene-index.js";
import { installPipeline16 } from "./16-dedupe.js";
import { installPipeline17 } from "./17-geometry.js";
import { installPipeline18 } from "./18-canonical-pipeline.js";
import { installPipeline19 } from "./19-dedupe.js";

export const pipelineInstallers = Object.freeze([
  installPipeline01,
  installPipeline02,
  installPipeline03,
  installPipeline04,
  installPipeline05,
  installPipeline06,
  installPipeline07,
  installPipeline08,
  installPipeline09,
  installPipeline10,
  installPipeline11,
  installPipeline12,
  installPipeline13,
  installPipeline14,
  installPipeline15,
  installPipeline16,
  installPipeline17,
  installPipeline18,
  installPipeline19
]);

export const pipelinePhases = Object.freeze({
  functions: Object.freeze([installPipeline01, installPipeline02, installPipeline03, installPipeline04, installPipeline05, installPipeline06, installPipeline07, installPipeline08, installPipeline09, installPipeline10, installPipeline11, installPipeline12, installPipeline13, installPipeline14, installPipeline15, installPipeline16]),
  state: Object.freeze([installPipeline17, installPipeline18]),
  startup: Object.freeze([installPipeline19])
});
