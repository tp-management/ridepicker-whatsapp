import fs from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const whatsappPath = fileURLToPath(new URL("./whatsapp.js", import.meta.url));
const marker = "const WA_REMOTE_LOGOUT_V2 = true;";

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);

  if (first === -1 || first !== last) {
    throw new Error(
      `WhatsApp remote logout target mismatch (${label}). Expected exactly one match.`
    );
  }

  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function applyWhatsappRemoteLogout() {
  const original = fs.readFileSync(whatsappPath, "utf8");

  if (original.includes(marker)) {
    return false;
  }

  let source = original;

  source = replaceExactlyOnce(
    source,
    `const REGISTRATION_CONFIRM_TIMEOUT_MS = 5 * 1000;`,
    `const REGISTRATION_CONFIRM_TIMEOUT_MS = 5 * 1000;\n${marker}`,
    "remote logout marker"
  );

  source = replaceExactlyOnce(
    source,
    `export async function disconnectSession(sessionId) {\n  stopManagedPairingFlow(sessionId);\n\n  const session = sessions.get(sessionId);\n\n  if (session) {\n    clearReconnectTimer(session);\n\n    try {\n      if (session.socket) {\n        await session.socket.logout();\n      }\n    } catch (error) {\n      console.warn(\`[\${sessionId}] logout warning:\`, error.message);\n    }\n\n    sessions.delete(sessionId);\n  }\n\n  removeAuthDirectory(sessionId);\n}`,
    `export async function disconnectSession(\n  sessionId,\n  { requestRemoteLogout = false } = {}\n) {\n  stopManagedPairingFlow(sessionId);\n\n  const session = sessions.get(sessionId);\n\n  if (session) {\n    clearReconnectTimer(session);\n\n    if (requestRemoteLogout) {\n      if (!session.socket || typeof session.socket.logout !== \"function\") {\n        const error = new Error(\n          \"Active WhatsApp socket is unavailable for logout.\"\n        );\n        error.status = 409;\n        throw error;\n      }\n\n      try {\n        // Match Baileys' own logout semantics exactly. Baileys sends\n        // remove-companion-device with sendNode() and then ends the socket.\n        // This confirms that the stanza was written to the transport, not that\n        // WhatsApp returned an IQ acknowledgement. Do not claim remote ACK.\n        await session.socket.logout();\n      } catch (error) {\n        console.warn(\`[\${sessionId}] logout failed:\`, error.message);\n        if (!error.status) {\n          error.status = 502;\n        }\n        throw error;\n      }\n\n      sessions.delete(sessionId);\n      removeAuthDirectory(sessionId);\n      return;\n    }\n\n    try {\n      if (session.socket) {\n        await session.socket.logout();\n      }\n    } catch (error) {\n      console.warn(\`[\${sessionId}] logout warning:\`, error.message);\n    }\n\n    sessions.delete(sessionId);\n  }\n\n  removeAuthDirectory(sessionId);\n}`,
    "Baileys-native disconnectSession"
  );

  source = replaceExactlyOnce(
    source,
    `  await disconnectSession(dbSession.id);`,
    `  await disconnectSession(dbSession.id, {\n    requestRemoteLogout: [\"CONNECTED\", \"RECONNECTING\"].includes(dbSession.status),\n  });`,
    "managed disconnect remote request"
  );

  fs.writeFileSync(whatsappPath, source);

  const check = spawnSync(process.execPath, ["--check", whatsappPath], {
    encoding: "utf8",
  });

  if (check.status !== 0) {
    fs.writeFileSync(whatsappPath, original);
    throw new Error(
      `Generated WhatsApp remote logout patch failed syntax check: ${check.stderr || check.stdout}`
    );
  }

  console.log("[whatsapp] Baileys-native remote logout applied");
  return true;
}
