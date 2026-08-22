import fs from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const whatsappPath = fileURLToPath(new URL("./whatsapp.js", import.meta.url));
const marker = "const WA_PAIRING_HELLO_ACK_V1 = true;";

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);

  if (first === -1 || first !== last) {
    throw new Error(
      `WhatsApp pairing hello-ack target mismatch (${label}). Expected exactly one match.`
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
    `const WA_PAIRING_HARDENING_V1 = true;\nconst WA_WEB_VERSION_CACHE_MS = 10 * 60 * 1000;`,
    `const WA_PAIRING_HARDENING_V1 = true;\n${marker}\nconst PAIRING_HELLO_ACK_TIMEOUT_MS = 6 * 1000;\nconst WA_WEB_VERSION_CACHE_MS = 10 * 60 * 1000;`,
    "pairing hello ack constant"
  );

  source = replaceExactlyOnce(
    source,
    `async function waitForRegisteredSession(session, socket) {`,
    `function resolvePairingHelloAck(session, result) {\n  if (!session) return;\n\n  session.pairingHelloAck = result;\n\n  for (const resolve of session.pairingHelloAckResolvers || []) {\n    resolve(result);\n  }\n\n  session.pairingHelloAckResolvers = [];\n}\n\nfunction waitForPairingHelloAck(session, socket) {\n  if (session?.pairingHelloAck) {\n    return Promise.resolve(session.pairingHelloAck);\n  }\n\n  return new Promise((resolve, reject) => {\n    let settled = false;\n\n    const finish = (result) => {\n      if (settled) return;\n      settled = true;\n      clearTimeout(timer);\n      resolve(result);\n    };\n\n    const timer = setTimeout(() => {\n      if (settled) return;\n      settled = true;\n\n      session.pairingHelloAckResolvers = (\n        session.pairingHelloAckResolvers || []\n      ).filter((item) => item !== finish);\n\n      const error = new Error(\n        "WhatsApp did not acknowledge the pairing code registration request."\n      );\n      error.status = 504;\n      reject(error);\n    }, PAIRING_HELLO_ACK_TIMEOUT_MS);\n\n    session.pairingHelloAckResolvers ||= [];\n    session.pairingHelloAckResolvers.push(finish);\n\n    if (!isCurrentSession(session) || session.socket !== socket) {\n      clearTimeout(timer);\n      settled = true;\n      const error = new Error("WhatsApp pairing socket changed before acknowledgement.");\n      error.status = 409;\n      reject(error);\n    }\n  });\n}\n\nasync function waitForRegisteredSession(session, socket) {`,
    "pairing hello ack waiter"
  );

  source = replaceExactlyOnce(
    source,
    `  session.socket = socket;\n\n  // WhatsApp can require an additional passkey/WebAuthn step for selected`,
    `  session.socket = socket;\n\n  // requestPairingCode() in Baileys only waits for the frame to be written to\n  // the websocket. It does not wait for WhatsApp to confirm that the\n  // companion_hello was accepted. Capture the corresponding IQ result and\n  // require link_code_pairing_ref before RidePicker exposes a code to the UI.\n  socket.ws?.on?.("CB:iq", (node) => {\n    if (!isCurrentSession(session)) return;\n\n    const children = Array.isArray(node?.content) ? node.content : [];\n    const linkNode = children.find(\n      (child) =>\n        child?.tag === "link_code_companion_reg" &&\n        child?.attrs?.stage === "companion_hello"\n    );\n\n    if (!linkNode) return;\n\n    const linkChildren = Array.isArray(linkNode?.content)\n      ? linkNode.content\n      : [];\n    const hasPairingRef = linkChildren.some(\n      (child) => child?.tag === "link_code_pairing_ref"\n    );\n    const errorNode = children.find((child) => child?.tag === "error") || null;\n    const responseType = node?.attrs?.type || null;\n    const errorCode =\n      errorNode?.attrs?.code || errorNode?.attrs?.text || null;\n    const accepted = responseType === "result" && hasPairingRef;\n\n    const result = {\n      accepted,\n      responseType,\n      errorCode,\n      hasPairingRef,\n      receivedAt: new Date().toISOString(),\n    };\n\n    resolvePairingHelloAck(session, result);\n\n    logWhatsappEvent(\n      session,\n      accepted ? "info" : "warning",\n      accepted\n        ? "pairing_hello_accepted"\n        : "pairing_hello_rejected",\n      accepted\n        ? "WhatsApp accepted pairing code registration"\n        : "WhatsApp did not accept pairing code registration",\n      { responseType, errorCode, hasPairingRef }\n    );\n  });\n\n  // WhatsApp can require an additional passkey/WebAuthn step for selected`,
    "pairing hello ack listener"
  );

  source = replaceExactlyOnce(
    source,
    `    const candidateCode = await socket.requestPairingCode(\n      flow.phoneDigits\n    );\n\n    // Do NOT publish the candidate immediately. Baileys currently returns the\n    // code before WhatsApp has necessarily accepted companion_hello.\n    await sleep(MANAGED_PAIRING_PUBLISH_GRACE_MS);`,
    `    session.pairingHelloAck = null;\n    session.pairingHelloAckResolvers = [];\n\n    const candidateCode = await socket.requestPairingCode(\n      flow.phoneDigits\n    );\n\n    // Do not publish a locally generated code until WhatsApp has explicitly\n    // acknowledged companion_hello and returned link_code_pairing_ref. This\n    // prevents the phone from receiving a code that immediately fails with\n    // "Device not found".\n    const pairingHelloAck = await waitForPairingHelloAck(session, socket);\n\n    if (!pairingHelloAck?.accepted) {\n      const error = new Error(\n        "WhatsApp rejected the pairing code registration request."\n      );\n      error.status = Number(pairingHelloAck?.errorCode) || 502;\n      throw error;\n    }`,
    "publish only acknowledged code"
  );

  fs.writeFileSync(whatsappPath, source);

  const check = spawnSync(process.execPath, ["--check", whatsappPath], {
    encoding: "utf8",
  });

  if (check.status !== 0) {
    fs.writeFileSync(whatsappPath, original);
    throw new Error(
      `Generated WhatsApp pairing hello-ack guard failed syntax check: ${check.stderr || check.stdout}`
    );
  }

  console.log("[whatsapp] pairing hello-ack guard applied");
  return true;
}
