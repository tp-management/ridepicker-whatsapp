import fs from "node:fs/promises";

function replaceOnce(source, search, replacement, label) {
  const first = source.indexOf(search);
  if (first < 0) throw new Error(`Could not find patch anchor: ${label}`);
  if (source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`Patch anchor is not unique: ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + search.length);
}

const path = "src/whatsapp.js";
let source = await fs.readFile(path, "utf8");

source = replaceOnce(
  source,
  `    registered: Boolean(state?.creds?.registered),\n    openedOnce: false,`,
  `    registered: Boolean(state?.creds?.registered),\n    openedOnce: false,\n    openedAtMs: null,`,
  "runtime open timestamp"
);

source = replaceOnce(
  source,
  `    if (connection === "open") {\n      clearReconnectTimer(session);\n      unexpectedLogoutRecoveryAttempts.delete(id);\n      session.logoutRequested = false;\n      session.logoutRequestedAt = null;\n      session.openedOnce = true;`,
  `    if (connection === "open") {\n      clearReconnectTimer(session);\n      // Do not reset an unexpected-401 retry budget merely because a recovery\n      // socket reaches open for a moment. A conflict can recur immediately\n      // after open. The budget is reset lazily only after a genuinely stable\n      // connection window.\n      session.openedAtMs = Date.now();\n      session.logoutRequested = false;\n      session.logoutRequestedAt = null;\n      session.openedOnce = true;`,
  "do not reset recovery budget on transient open"
);

source = replaceOnce(
  source,
  `      if (statusCode === DisconnectReason.loggedOut) {\n        const attempt =\n          (unexpectedLogoutRecoveryAttempts.get(id) || 0) + 1;`,
  `      if (statusCode === DisconnectReason.loggedOut) {\n        const stableOpen =\n          Number.isFinite(session.openedAtMs) &&\n          Date.now() - session.openedAtMs >= 60_000;\n\n        if (stableOpen) {\n          unexpectedLogoutRecoveryAttempts.delete(id);\n        }\n\n        const attempt =\n          (unexpectedLogoutRecoveryAttempts.get(id) || 0) + 1;`,
  "stable-window recovery budget reset"
);

await fs.writeFile(path, source, "utf8");

const testPath = "test/whatsappCharacterization.test.js";
let testSource = await fs.readFile(testPath, "utf8");
testSource = replaceOnce(
  testSource,
  `  for (let index = 0; index < 4; index += 1) {\n    const error = disconnectError(401, "Stream Errored (conflict)");`,
  `  for (let index = 0; index < 4; index += 1) {\n    // A recovery socket that only opens briefly must not reset the bounded\n    // retry budget. Otherwise conflict -> open -> conflict could loop forever.\n    if (index > 0) {\n      await socket.ev.emit("connection.update", { connection: "open" });\n    }\n\n    const error = disconnectError(401, "Stream Errored (conflict)");`,
  "rapid-open exhaustion regression"
);
await fs.writeFile(testPath, testSource, "utf8");

console.log("Applied stable-window refinement.");
