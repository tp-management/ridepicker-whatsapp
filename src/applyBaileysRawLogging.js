import fs from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const whatsappPath = fileURLToPath(new URL("./whatsapp.js", import.meta.url));
const marker = "const BAILEYS_RAW_LOGGING_V1 = true;";

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);

  if (first === -1 || first !== last) {
    throw new Error(
      `Baileys raw logging target mismatch (${label}). Expected exactly one match.`
    );
  }

  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function applyBaileysRawLogging() {
  const original = fs.readFileSync(whatsappPath, "utf8");

  if (original.includes(marker)) {
    return false;
  }

  let source = original;

  source = replaceExactlyOnce(
    source,
    `import { writeSystemLog } from "./systemLog.js";\nimport { isSupabaseConfigured } from "./supabase.js";`,
    `import { writeSystemLog } from "./systemLog.js";\nimport { createBaileysRawLogger } from "./baileysRawLogger.js";\nimport { isSupabaseConfigured } from "./supabase.js";`,
    "logger import"
  );

  source = replaceExactlyOnce(
    source,
    `const sessions = new Map();`,
    `${marker}\nconst sessions = new Map();`,
    "marker"
  );

  source = replaceExactlyOnce(
    source,
    `  const socket = makeWASocket({\n    auth: state,\n    ...(waWebVersion ? { version: waWebVersion } : {}),\n    markOnlineOnConnect: false,\n    printQRInTerminal: false,\n  });`,
    `  const socket = makeWASocket({\n    auth: state,\n    ...(waWebVersion ? { version: waWebVersion } : {}),\n    logger: createBaileysRawLogger({\n      userId,\n      sessionId: id,\n    }),\n    markOnlineOnConnect: false,\n    printQRInTerminal: false,\n  });`,
    "socket logger"
  );

  fs.writeFileSync(whatsappPath, source);

  const check = spawnSync(process.execPath, ["--check", whatsappPath], {
    encoding: "utf8",
  });

  if (check.status !== 0) {
    fs.writeFileSync(whatsappPath, original);
    throw new Error(
      `Generated Baileys raw logging patch failed syntax check: ${check.stderr || check.stdout}`
    );
  }

  console.log("[whatsapp] native Baileys logging enabled");
  return true;
}
