import { installBackground01 } from "./01-messages.js";
import { installBackground02 } from "./02-messages.js";
import { installBackground03 } from "./03-observations.js";
import { installBackground04 } from "./04-observations.js";
import { installBackground05 } from "./05-observations.js";
import { installBackground06 } from "./06-observations.js";
import { installBackground07 } from "./07-capture.js";
import { installBackground10 } from "./10-ocr-provider.js";
import { installBackground11 } from "./11-ocr-provider.js";
import { installBackground12 } from "./12-ocr-grouping.js";
import { installBackground13 } from "./13-ocr-grouping.js";
import { installBackground14 } from "./14-ocr-grouping.js";
import { installBackground15 } from "./15-ocr-grouping.js";
import { installBackground16 } from "./16-ocr-geometry.js";
import { installBackground17 } from "./17-ocr-geometry.js";
import { installBackground18 } from "./18-ocr-geometry.js";
import { installBackground19 } from "./19-ocr-geometry.js";
import { installBackground20 } from "./20-baidu.js";
import { installBackground21 } from "./21-baidu.js";
import { installBackground22 } from "./22-translation.js";
import { installBackground23 } from "./23-translation.js";
import { installBackground24 } from "./24-translation.js";
import { installBackground25 } from "./25-translation.js";
import { installBackground26 } from "./26-platform.js";
import { installBackground27 } from "./27-platform.js";
import { installBackground28 } from "./28-platform.js";
import { installBackground29 } from "./29-bootstrap.js";
import { installBackground30 } from "./30-bootstrap.js";
import { installBackground31 } from "./31-messages.js";

export const backgroundInstallers = Object.freeze([
  installBackground01,
  installBackground02,
  installBackground03,
  installBackground04,
  installBackground05,
  installBackground06,
  installBackground07,
  installBackground10,
  installBackground11,
  installBackground12,
  installBackground13,
  installBackground14,
  installBackground15,
  installBackground16,
  installBackground17,
  installBackground18,
  installBackground19,
  installBackground20,
  installBackground21,
  installBackground22,
  installBackground23,
  installBackground24,
  installBackground25,
  installBackground26,
  installBackground27,
  installBackground28,
  installBackground29,
  installBackground30,
  installBackground31
]);

export const backgroundPhases = Object.freeze({
  functions: Object.freeze([installBackground01, installBackground02, installBackground03, installBackground04, installBackground05, installBackground06, installBackground07, installBackground10, installBackground11, installBackground12, installBackground13, installBackground14, installBackground15, installBackground16, installBackground17, installBackground18, installBackground19, installBackground20, installBackground21, installBackground22, installBackground23, installBackground24, installBackground25, installBackground26, installBackground27, installBackground28]),
  state: Object.freeze([installBackground29, installBackground31]),
  startup: Object.freeze([installBackground30])
});
