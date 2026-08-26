import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sourcePath = "scripts/apply-durable-whatsapp-401-recovery.mjs";
let source = await fs.readFile(sourcePath, "utf8");

const oldFragment = `  source = replaceOnce(\n    source,\n    \`  getSession,\\n  startSession,\\n  updatePolicyCache,\\n\`,\n    \`  getSession,\\n  requestRemoteLogoutForSession,\\n  startSession,\\n  updatePolicyCache,\\n\`,\n    "managed boundary central logout import"\n  );`;

const newFragment = `  source = replaceOnce(\n    source,\n    \`import {\\n  disconnectSession,\\n  getManagedSession,\\n  getSession,\\n  startSession,\\n  updatePolicyCache,\\n} from "../whatsapp.js";\`,\n    \`import {\\n  disconnectSession,\\n  getManagedSession,\\n  getSession,\\n  requestRemoteLogoutForSession,\\n  startSession,\\n  updatePolicyCache,\\n} from "../whatsapp.js";\`,\n    "managed boundary central logout import"\n  );`;

if (!source.includes(oldFragment)) {
  throw new Error("Could not find managed boundary import patch fragment");
}
source = source.replace(oldFragment, newFragment);

const tempPath = path.join(os.tmpdir(), `ridepicker-durable-401-${Date.now()}.mjs`);
await fs.writeFile(tempPath, source, "utf8");
await import(pathToFileURL(tempPath).href);
