import { installContent01 } from "./01-reader-runtime.js";
import { installContent02 } from "./02-reader-runtime.js";
import { installContent03 } from "./03-scheduler.js";
import { installContent04 } from "./04-scheduler.js";
import { installContent05 } from "./05-recognition.js";
import { installContent06 } from "./06-recognition.js";
import { installContent07 } from "./07-recognition.js";
import { installContent08 } from "./08-recognition.js";
import { installContent09 } from "./09-recognition.js";
import { installContent10 } from "./10-recognition.js";
import { installContent11 } from "./11-capture.js";
import { installContent12 } from "./12-capture.js";
import { installContent13 } from "./13-scene.js";
import { installContent14 } from "./14-scene.js";
import { installContent15 } from "./15-scene.js";
import { installContent16 } from "./16-renderer.js";
import { installContent17 } from "./17-renderer.js";
import { installContent18 } from "./18-renderer.js";
import { installContent19 } from "./19-lifecycle.js";
import { installContent20 } from "./20-lifecycle.js";
import { installContent21 } from "./21-lifecycle.js";
import { installContent22 } from "./22-lifecycle.js";
import { installContent23 } from "./23-reader-controls.js";
import { installContent24 } from "./24-reader-controls.js";
import { installContent25 } from "./25-reader-controls.js";
import { installContent26 } from "./26-target-discovery.js";
import { installContent27 } from "./27-target-discovery.js";
import { installContent28 } from "./28-target-discovery.js";
import { installContent29 } from "./29-platform.js";
import { installContent30 } from "./30-platform.js";
import { installContent31 } from "./31-reader-runtime.js";
import { installContent32 } from "./32-reader-runtime.js";
import { installContent33 } from "./33-reader-runtime.js";
import { installContent34 } from "./34-reader-runtime.js";
import { installContent35 } from "./35-recognition.js";

export const contentInstallers = Object.freeze([
  installContent01,
  installContent02,
  installContent03,
  installContent04,
  installContent05,
  installContent06,
  installContent07,
  installContent08,
  installContent09,
  installContent10,
  installContent11,
  installContent12,
  installContent13,
  installContent14,
  installContent15,
  installContent16,
  installContent17,
  installContent18,
  installContent19,
  installContent20,
  installContent21,
  installContent22,
  installContent23,
  installContent24,
  installContent25,
  installContent26,
  installContent27,
  installContent28,
  installContent29,
  installContent30,
  installContent31,
  installContent32,
  installContent33,
  installContent34,
  installContent35
]);

export const contentPhases = Object.freeze({
  functions: Object.freeze([installContent01, installContent02, installContent03, installContent04, installContent05, installContent06, installContent07, installContent08, installContent09, installContent10, installContent11, installContent12, installContent13, installContent14, installContent15, installContent16, installContent17, installContent18, installContent19, installContent20, installContent21, installContent22, installContent23, installContent24, installContent25, installContent26, installContent27, installContent28, installContent29, installContent30]),
  state: Object.freeze([installContent31, installContent33, installContent35]),
  startup: Object.freeze([installContent32, installContent34])
});
