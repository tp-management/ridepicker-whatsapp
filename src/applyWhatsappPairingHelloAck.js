import fs from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const whatsappPath = fileURLToPath(new URL("./whatsapp.js", import.meta.url));
const marker = "const WA_PAIRING_QUERY_ACK_V2 = true;";

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);

  if (first === -1 || first !== last) {
    throw new Error(
      `WhatsApp pairing query-ack target mismatch (${label}). Expected exactly one match.`
    );
  }

  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function applyWhatsappPairingHelloAck() {
  const original = fs.readFileSync(whatsappPath, "utf8");

  if (original.includes(marker)) {
    return false;
  }

  let source = original;

  source = replaceExactlyOnce(
    source,
    `import fs from "fs";\nimport path from "path";`,
    `import fs from "fs";\nimport path from "path";\nimport { randomBytes } from "crypto";`,
    "crypto import"
  );

  source = replaceExactlyOnce(
    source,
    `import makeWASocket, {\n  DisconnectReason,\n  fetchLatestWaWebVersion,\n  useMultiFileAuthState,\n} from "@whiskeysockets/baileys";`,
    `import makeWASocket, {\n  DisconnectReason,\n  fetchLatestWaWebVersion,\n  useMultiFileAuthState,\n  aesEncryptCTR,\n  bytesToCrockford,\n  derivePairingCodeKey,\n  getBinaryNodeChild,\n  jidEncode,\n  S_WHATSAPP_NET,\n} from "@whiskeysockets/baileys";`,
    "Baileys pairing query imports"
  );

  source = replaceExactlyOnce(
    source,
    `const WA_PAIRING_HARDENING_V1 = true;\nconst WA_WEB_VERSION_CACHE_MS = 10 * 60 * 1000;`,
    `const WA_PAIRING_HARDENING_V1 = true;\n${marker}\nconst WA_WEB_VERSION_CACHE_MS = 10 * 60 * 1000;`,
    "pairing query-ack marker"
  );

  source = replaceExactlyOnce(
    source,
    `async function waitForRegisteredSession(session, socket) {`,
    `async function requestVerifiedPairingCode(\n  session,\n  socket,\n  phoneDigits\n) {\n  const authState = socket?.authState;\n\n  if (!authState?.creds || !socket?.query) {\n    const error = new Error("WhatsApp pairing transport is not ready");\n    error.status = 409;\n    throw error;\n  }\n\n  const pairingCode = bytesToCrockford(randomBytes(5));\n  authState.creds.pairingCode = pairingCode;\n\n  const jid = jidEncode(phoneDigits, "s.whatsapp.net");\n  const salt = randomBytes(32);\n  const randomIv = randomBytes(16);\n  const key = await derivePairingCodeKey(pairingCode, salt);\n  const ciphered = aesEncryptCTR(\n    authState.creds.pairingEphemeralKeyPair.public,\n    key,\n    randomIv\n  );\n  const wrappedEphemeralKey = Buffer.concat([salt, randomIv, ciphered]);\n\n  try {\n    // Mirror the upstream pairing fix: use query() so this promise is tied to\n    // the actual companion_hello IQ response instead of returning an optimistic\n    // local code before WhatsApp has accepted it.\n    const result = await socket.query(\n      {\n        tag: "iq",\n        attrs: {\n          to: S_WHATSAPP_NET,\n          type: "set",\n          xmlns: "md",\n        },\n        content: [\n          {\n            tag: "link_code_companion_reg",\n            attrs: {\n              jid,\n              stage: "companion_hello",\n              should_show_push_notification: "true",\n            },\n            content: [\n              {\n                tag: "link_code_pairing_wrapped_companion_ephemeral_pub",\n                attrs: {},\n                content: wrappedEphemeralKey,\n              },\n              {\n                tag: "companion_server_auth_key_pub",\n                attrs: {},\n                content: authState.creds.noiseKey.public,\n              },\n              {\n                tag: "companion_platform_id",\n                attrs: {},\n                content: "1",\n              },\n              {\n                tag: "companion_platform_display",\n                attrs: {},\n                content: "Chrome (Mac OS)",\n              },\n              {\n                tag: "link_code_pairing_nonce",\n                attrs: {},\n                content: "0",\n              },\n            ],\n          },\n        ],\n      },\n      15_000\n    );\n\n    if (!result) {\n      const error = new Error(\n        "WhatsApp timed out while registering the pairing code."\n      );\n      error.status = 504;\n      throw error;\n    }\n\n    const registrationNode = getBinaryNodeChild(\n      result,\n      "link_code_companion_reg"\n    );\n    const pairingRefNode = registrationNode\n      ? getBinaryNodeChild(registrationNode, "link_code_pairing_ref")\n      : null;\n\n    if (!pairingRefNode) {\n      const error = new Error(\n        "WhatsApp did not return a pairing reference for the new code."\n      );\n      error.status = 502;\n      throw error;\n    }\n\n    // Persist through the normal creds.update listener. This keeps the auth\n    // writer scoped inside startSession instead of leaking local variables into\n    // the managed pairing function.\n    authState.creds.me = { id: jid, name: "~" };\n    socket.ev.emit("creds.update", authState.creds);\n\n    logWhatsappEvent(\n      session,\n      "info",\n      "pairing_hello_accepted",\n      "WhatsApp accepted pairing code registration",\n      { hasPairingRef: true }\n    );\n\n    return pairingCode;\n  } catch (error) {\n    if (authState.creds.pairingCode === pairingCode) {\n      authState.creds.pairingCode = undefined;\n    }\n\n    logWhatsappEvent(\n      session,\n      "warning",\n      "pairing_hello_rejected",\n      error.message,\n      {\n        statusCode:\n          error?.output?.statusCode ||\n          error?.statusCode ||\n          null,\n      }\n    );\n\n    throw error;\n  }\n}\n\nasync function waitForRegisteredSession(session, socket) {`,
    "verified pairing query helper"
  );

  source = replaceExactlyOnce(
    source,
    `    const candidateCode = await socket.requestPairingCode(\n      flow.phoneDigits\n    );\n\n    // Do NOT publish the candidate immediately. Baileys currently returns the\n    // code before WhatsApp has necessarily accepted companion_hello.\n    await sleep(MANAGED_PAIRING_PUBLISH_GRACE_MS);`,
    `    const candidateCode = await requestVerifiedPairingCode(\n      session,\n      socket,\n      flow.phoneDigits\n    );`,
    "verified pairing request"
  );

  fs.writeFileSync(whatsappPath, source);

  const check = spawnSync(process.execPath, ["--check", whatsappPath], {
    encoding: "utf8",
  });

  if (check.status !== 0) {
    fs.writeFileSync(whatsappPath, original);
    throw new Error(
      `Generated WhatsApp pairing query-ack guard failed syntax check: ${check.stderr || check.stdout}`
    );
  }

  console.log("[whatsapp] pairing query-ack guard applied");
  return true;
}
