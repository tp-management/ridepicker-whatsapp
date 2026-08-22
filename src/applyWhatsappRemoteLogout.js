import fs from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const whatsappPath = fileURLToPath(new URL("./whatsapp.js", import.meta.url));
const marker = "const WA_REMOTE_LOGOUT_V1 = true;";

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
    `const REGISTRATION_CONFIRM_TIMEOUT_MS = 5 * 1000;\n${marker}\nconst REMOTE_LOGOUT_TIMEOUT_MS = 10 * 1000;`,
    "remote logout constants"
  );

  source = replaceExactlyOnce(
    source,
    `export async function disconnectSession(sessionId) {\n  stopManagedPairingFlow(sessionId);\n\n  const session = sessions.get(sessionId);\n\n  if (session) {\n    clearReconnectTimer(session);\n\n    try {\n      if (session.socket) {\n        await session.socket.logout();\n      }\n    } catch (error) {\n      console.warn(\`[\${sessionId}] logout warning:\`, error.message);\n    }\n\n    sessions.delete(sessionId);\n  }\n\n  removeAuthDirectory(sessionId);\n}`,
    `export async function disconnectSession(\n  sessionId,\n  { verifyRemote = false } = {}\n) {\n  stopManagedPairingFlow(sessionId);\n\n  const session = sessions.get(sessionId);\n\n  if (session) {\n    clearReconnectTimer(session);\n\n    if (verifyRemote) {\n      const socket = session.socket;\n      const jid =\n        socket?.authState?.creds?.me?.id || socket?.user?.id || null;\n\n      if (!socket || !jid || typeof socket.query !== \"function\") {\n        const error = new Error(\n          \"RidePicker could not verify the WhatsApp unlink because the active linked-device session is unavailable. Remove the device from WhatsApp Linked Devices and try again.\"\n        );\n        error.status = 409;\n        throw error;\n      }\n\n      try {\n        if (typeof socket.waitForSocketOpen === \"function\") {\n          await Promise.race([\n            socket.waitForSocketOpen(),\n            new Promise((_, reject) =>\n              setTimeout(() => {\n                const error = new Error(\n                  \"Timed out waiting for WhatsApp before unlinking the device.\"\n                );\n                error.status = 504;\n                reject(error);\n              }, REMOTE_LOGOUT_TIMEOUT_MS)\n            ),\n          ]);\n        }\n\n        const response = await socket.query(\n          {\n            tag: \"iq\",\n            attrs: {\n              to: \"s.whatsapp.net\",\n              type: \"set\",\n              xmlns: \"md\",\n            },\n            content: [\n              {\n                tag: \"remove-companion-device\",\n                attrs: {\n                  jid,\n                  reason: \"user_initiated\",\n                },\n              },\n            ],\n          },\n          REMOTE_LOGOUT_TIMEOUT_MS\n        );\n\n        if (!response) {\n          const error = new Error(\n            \"WhatsApp did not confirm that the linked device was removed.\"\n          );\n          error.status = 504;\n          throw error;\n        }\n\n        logWhatsappEvent(\n          session,\n          \"info\",\n          \"whatsapp_remote_unlink_confirmed\",\n          \"WhatsApp confirmed linked-device removal\"\n        );\n      } catch (error) {\n        logWhatsappEvent(\n          session,\n          \"error\",\n          \"whatsapp_remote_unlink_failed\",\n          error.message,\n          {\n            statusCode:\n              error?.output?.statusCode ||\n              error?.statusCode ||\n              error?.status ||\n              null,\n          }\n        );\n        throw error;\n      }\n\n      dropSocketSession(session, {\n        removeAuth: true,\n        reason: \"WhatsApp remote unlink confirmed\",\n      });\n      return;\n    }\n\n    try {\n      if (session.socket) {\n        await session.socket.logout();\n      }\n    } catch (error) {\n      console.warn(\`[\${sessionId}] logout warning:\`, error.message);\n    }\n\n    sessions.delete(sessionId);\n  }\n\n  removeAuthDirectory(sessionId);\n}`,
    "verified disconnectSession"
  );

  source = replaceExactlyOnce(
    source,
    `  await disconnectSession(dbSession.id);`,
    `  await disconnectSession(dbSession.id, {\n    verifyRemote: [\"CONNECTED\", \"RECONNECTING\"].includes(dbSession.status),\n  });`,
    "managed disconnect remote verification"
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

  console.log("[whatsapp] remote logout verification applied");
  return true;
}
