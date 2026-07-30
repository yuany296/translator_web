import glossaryCore from "../shared/glossary.js";
import termDiscoveryCore from "../shared/term-discovery.js";
import novelMemoryCore from "../shared/novel-memory.js";
import { glossaryInstallers } from "./modules/index.js";

const runtime = Object.assign(Object.create(null), { glossaryCore, termDiscoveryCore, novelMemoryCore });
for (const install of glossaryInstallers) install(runtime);
