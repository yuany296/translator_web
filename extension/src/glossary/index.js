import glossaryCore from "../shared/glossary.js";
import termDiscoveryCore from "../shared/term-discovery.js";
import { glossaryInstallers } from "./modules/index.js";

const runtime = Object.assign(Object.create(null), { glossaryCore, termDiscoveryCore });
for (const install of glossaryInstallers) install(runtime);
