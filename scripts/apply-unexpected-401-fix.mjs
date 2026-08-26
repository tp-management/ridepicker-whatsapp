import fs from "node:fs/promises";

function replaceOnce(source, search, replacement, label) {
  const first = source.indexOf(search);
  if (first < 0) throw new Error(`Could not find patch anchor: ${label}`);
  if (source.indexOf(search, first + search.length) >= 0) {
    throw new Error(`Patch anchor is not unique: ${label}`);
  }
  return source.slice(0, first) + replacement + source.slice(first + search.length);
}

function replaceBetween(source, startMarker, endMarker, replacement, label) {
  const start = source.indexOf(startMarker);
  if (start < 0) throw new Error(`Could not find start marker: ${label}`);
  const end = source.indexOf(endMarker, start + startMarker.length);
  if (end < 0) throw new Error(`Could not find end marker: ${label}`);
  return source.slice(0, start) + replacement + source.slice(end);
}

const whatsappPath = "src/whatsapp.js";
let whatsapp = await fs.readFile(whatsappPath, "utf8");

whatsapp = replaceOnce(
  whatsapp,
  `const chatWriteCache = new Map();\n\nconst GROUP_CACHE_TTL = 10 * 60 * 1000;`,
  `const chatWriteCache = new Map();\nconst unexpectedLogoutRecoveryAttempts = new Map();\n\nconst GROUP_CACHE_TTL = 10 * 60 * 1000;`,
  "unexpected logout recovery map"
);

whatsapp = replaceOnce(
  whatsapp,
  `const PAIRING_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;\nconst WA_WEB_VERSION_CACHE_MS = 10 * 60 * 1000;`,
  `const PAIRING_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;\n// Unsolicited 401s are ambiguous in Baileys v7. Retry them with the same\n// registered Supabase auth before asking the user to pair again. Never hammer\n// WhatsApp indefinitely if the companion really was removed.\nconst UNEXPECTED_LOGOUT_RETRY_DELAYS_MS = [2_000, 10_000, 30_000];\nconst WA_WEB_VERSION_CACHE_MS = 10 * 60 * 1000;`,
  "unexpected logout retry delays"
);

const oldDisconnectDetails = `function disconnectDetails(lastDisconnect) {\n  const error = lastDisconnect?.error;\n\n  const statusCode =\n    error instanceof Boom\n      ? error.output.statusCode\n      : error?.output?.statusCode ||\n        error?.data?.statusCode ||\n        error?.statusCode ||\n        null;\n\n  const message =\n    error?.message ||\n    error?.output?.payload?.message ||\n    \"WhatsApp connection closed\";\n\n  return {\n    statusCode,\n    message,\n  };\n}`;

const newDisconnectDetails = `function disconnectDetails(lastDisconnect) {\n  const error = lastDisconnect?.error;\n\n  const statusCode =\n    error instanceof Boom\n      ? error.output.statusCode\n      : error?.output?.statusCode ||\n        error?.data?.statusCode ||\n        error?.statusCode ||\n        null;\n\n  const message =\n    error?.message ||\n    error?.output?.payload?.message ||\n    \"WhatsApp connection closed\";\n\n  // Baileys attaches the WhatsApp stream-error reason node to Boom.data.\n  // Keep only the small classification fields we need for diagnostics. Never\n  // persist the full node because it may contain protocol/account metadata.\n  const reasonNode =\n    error?.data && typeof error.data === \"object\" ? error.data : null;\n  const reasonTag =\n    typeof reasonNode?.tag === \"string\" ? reasonNode.tag : null;\n  const conflictType =\n    reasonTag === \"conflict\" &&\n    typeof reasonNode?.attrs?.type === \"string\"\n      ? reasonNode.attrs.type\n      : null;\n\n  return {\n    statusCode,\n    message,\n    reasonTag,\n    conflictType,\n  };\n}`;

whatsapp = replaceOnce(
  whatsapp,
  oldDisconnectDetails,
  newDisconnectDetails,
  "disconnect diagnostics"
);

whatsapp = replaceOnce(
  whatsapp,
  `    reconnectTimer: null,\n    lastError: null,\n    disposed: false,`,
  `    reconnectTimer: null,\n    lastError: null,\n    // This flag is set only by RidePicker immediately before socket.logout().\n    // A remote/unsolicited 401 must never be allowed to impersonate that intent.\n    logoutRequested: false,\n    logoutRequestedAt: null,\n    disposed: false,`,
  "runtime logout intent fields"
);

whatsapp = replaceOnce(
  whatsapp,
  `    if (connection === \"open\") {\n      clearReconnectTimer(session);\n      session.openedOnce = true;`,
  `    if (connection === \"open\") {\n      clearReconnectTimer(session);\n      unexpectedLogoutRecoveryAttempts.delete(id);\n      session.logoutRequested = false;\n      session.logoutRequestedAt = null;\n      session.openedOnce = true;`,
  "successful open resets 401 recovery"
);

whatsapp = replaceOnce(
  whatsapp,
  `      const { statusCode, message } = disconnectDetails(lastDisconnect);`,
  `      const { statusCode, message, reasonTag, conflictType } =\n        disconnectDetails(lastDisconnect);`,
  "close diagnostics destructuring"
);

whatsapp = replaceOnce(
  whatsapp,
  `          statusCode,\n          message,\n          registered: session.registered,\n          pairingAttemptActive: session.pairingAttemptActive,`,
  `          statusCode,\n          message,\n          reasonTag,\n          conflictType,\n          locallyRequestedLogout: Boolean(session.logoutRequested),\n          registered: session.registered,\n          pairingAttemptActive: session.pairingAttemptActive,`,
  "close console diagnostics"
);

whatsapp = replaceOnce(
  whatsapp,
  `          statusCode,\n          registered: session.registered,\n          pairingAttemptActive: session.pairingAttemptActive,\n        }\n      );\n\n      session.socket = null;`,
  `          statusCode,\n          reasonTag,\n          conflictType,\n          locallyRequestedLogout: Boolean(session.logoutRequested),\n          registered: session.registered,\n          pairingAttemptActive: session.pairingAttemptActive,\n        }\n      );\n\n      session.socket = null;`,
  "persistent close diagnostics"
);

whatsapp = replaceOnce(
  whatsapp,
  `      session.registered = Boolean(\n        session.registered || state?.creds?.registered\n      );\n\n      const restartRequired =`,
  `      session.registered = Boolean(\n        session.registered || state?.creds?.registered\n      );\n\n      // socket.logout() produces a 401-style close too. The explicit caller\n      // owns the destructive transition and only finalizes LOGGED_OUT after\n      // socket.logout() resolves. Returning here prevents a race that could\n      // purge auth early and also prevents duplicate disconnect activity rows.\n      if (session.logoutRequested) {\n        clearReconnectTimer(session);\n        unexpectedLogoutRecoveryAttempts.delete(id);\n        session.lastError = null;\n\n        console.log(\`[\${id}] expected close during requested WhatsApp logout\`);\n        logWhatsappEvent(\n          session,\n          \"info\",\n          \"whatsapp_logout_transport_closed\",\n          \"WhatsApp transport closed during a requested logout\",\n          { statusCode, reasonTag, conflictType }\n        );\n        return;\n      }\n\n      const restartRequired =`,
  "local logout ownership"
);

const old401Start = `      // Only a non-pairing 401 is a genuine WhatsApp logout.\n`;
const genericReconnectMarker = `      session.status = \"RECONNECTING\";\n      console.log(\`[\${id}] reconnecting...\`);`;

const new401Block = `      // An unsolicited 401 is NOT sufficient proof of a terminal logout.\n      // Baileys v7 can surface transient conflict/device_removed stream errors\n      // for a previously healthy companion. Preserve registered Supabase auth\n      // and make a few bounded recovery attempts. If WhatsApp really removed\n      // the device, stop in ERROR with auth preserved so only an explicit user\n      // re-pair can replace it.\n      if (statusCode === DisconnectReason.loggedOut) {\n        const attempt =\n          (unexpectedLogoutRecoveryAttempts.get(id) || 0) + 1;\n        unexpectedLogoutRecoveryAttempts.set(id, attempt);\n\n        if (attempt > UNEXPECTED_LOGOUT_RETRY_DELAYS_MS.length) {\n          clearReconnectTimer(session);\n          session.status = \"ERROR\";\n          session.lastError = {\n            code: \"UNEXPECTED_401_RECOVERY_EXHAUSTED\",\n            message,\n          };\n\n          console.error(\n            \`[\${id}] unexpected WhatsApp 401 recovery exhausted; preserving auth\`\n          );\n          logWhatsappEvent(\n            session,\n            \"error\",\n            \"unexpected_401_recovery_exhausted\",\n            message,\n            {\n              statusCode,\n              reasonTag,\n              conflictType,\n              attempts: attempt - 1,\n              authPreserved: true,\n            }\n          );\n\n          await persistSessionState(session, {\n            status: \"ERROR\",\n          });\n\n          dropSocketSession(session, {\n            removeAuth: false,\n            reason: \"Unexpected WhatsApp 401 recovery exhausted\",\n          });\n          return;\n        }\n\n        const delayMs = UNEXPECTED_LOGOUT_RETRY_DELAYS_MS[attempt - 1];\n        session.status = \"RECONNECTING\";\n\n        console.warn(\n          \`[\${id}] unexpected WhatsApp 401; preserving auth and retrying in \${delayMs}ms\`\n        );\n        logWhatsappEvent(\n          session,\n          \"warning\",\n          \"unexpected_401_recovery_started\",\n          message,\n          {\n            statusCode,\n            reasonTag,\n            conflictType,\n            attempt,\n            delayMs,\n            authPreserved: true,\n          }\n        );\n\n        // Do not touch bot_mode, account identity, connected_at, or auth here.\n        await persistSessionState(session, {\n          status: \"RECONNECTING\",\n        });\n\n        await forwardSessionEvent({\n          event: \"session.reconnecting\",\n          session: id,\n          userId: session.userId,\n          timestamp: Date.now(),\n        });\n\n        if (!session.reconnectTimer) {\n          session.reconnectTimer = setTimeout(async () => {\n            session.reconnectTimer = null;\n\n            if (!isCurrentSession(session)) return;\n\n            const userId = session.userId;\n            dropSocketSession(session, {\n              removeAuth: false,\n              reason: \"Recovering from unexpected WhatsApp 401\",\n            });\n\n            try {\n              await startSession(id, { userId });\n            } catch (error) {\n              console.error(\`[\${id}] unexpected 401 recovery failed:\`, error);\n              void writeSystemLog({\n                userId,\n                sessionId: id,\n                level: \"error\",\n                source: \"whatsapp\",\n                event: \"unexpected_401_recovery_start_failed\",\n                message: error.message,\n                details: { authPreserved: true },\n              });\n\n              await repository.updateWhatsappSessionById(id, {\n                status: \"ERROR\",\n              });\n            }\n          }, delayMs);\n        }\n\n        return;\n      }\n\n`;

whatsapp = replaceBetween(
  whatsapp,
  old401Start,
  genericReconnectMarker,
  new401Block,
  "unexpected 401 recovery block"
);

whatsapp = replaceOnce(
  whatsapp,
  `      try {\n        // Match Baileys' own logout semantics exactly. Baileys sends`,
  `      session.logoutRequested = true;\n      session.logoutRequestedAt = new Date().toISOString();\n\n      try {\n        // Match Baileys' own logout semantics exactly. Baileys sends`,
  "legacy explicit logout intent"
);

whatsapp = replaceOnce(
  whatsapp,
  `      } catch (error) {\n        console.warn(\`[\${sessionId}] logout failed:\`, error.message);\n        if (!error.status) {`,
  `      } catch (error) {\n        session.logoutRequested = false;\n        session.logoutRequestedAt = null;\n        console.warn(\`[\${sessionId}] logout failed:\`, error.message);\n        if (!error.status) {`,
  "legacy explicit logout failure reset"
);

whatsapp = replaceOnce(
  whatsapp,
  `    try {\n      if (session.socket) {\n        await session.socket.logout();\n      }`,
  `    try {\n      if (session.socket) {\n        session.logoutRequested = true;\n        session.logoutRequestedAt = new Date().toISOString();\n        await session.socket.logout();\n      }`,
  "best-effort logout intent"
);

await fs.writeFile(whatsappPath, whatsapp, "utf8");

const boundaryPath = "src/whatsapp/managedSessionBoundary.js";
let boundary = await fs.readFile(boundaryPath, "utf8");

boundary = replaceOnce(
  boundary,
  `      await runtimeSession.socket.logout();\n      return finalizeSuccessfulLogout(dbSession, userId, runtimeSession, {`,
  `      // Mark local intent before Baileys emits its 401-style close event.\n      // The connection handler will then defer all irreversible cleanup to this\n      // explicit caller, which finalizes only after logout() resolves.\n      runtimeSession.logoutRequested = true;\n      runtimeSession.logoutRequestedAt = new Date().toISOString();\n      await runtimeSession.socket.logout();\n      return finalizeSuccessfulLogout(dbSession, userId, runtimeSession, {`,
  "managed explicit logout intent"
);

boundary = replaceOnce(
  boundary,
  `    } catch (error) {\n      if (startedRuntimeForLogout) {`,
  `    } catch (error) {\n      if (runtimeSession) {\n        runtimeSession.logoutRequested = false;\n        runtimeSession.logoutRequestedAt = null;\n      }\n\n      if (startedRuntimeForLogout) {`,
  "managed logout failure intent reset"
);

await fs.writeFile(boundaryPath, boundary, "utf8");

const characterizationPath = "test/whatsappCharacterization.test.js";
let characterization = await fs.readFile(characterizationPath, "utf8");
const testMarker = `test("unexpected established 401 preserves auth and uses bounded recovery"`;
if (!characterization.includes(testMarker)) {
  characterization += `\n\ntest("unexpected established 401 preserves auth and uses bounded recovery", async (t) => {\n  const harness = await useHarness(t);\n  const userId = "unexpected-401";\n  const row = await harness.repositoryStub.repository.ensureWhatsappSession(userId);\n  const session = await harness.whatsapp.startSession(row.id, { userId });\n  const socket = session.socket;\n\n  socket.authState.creds.registered = true;\n  socket.user = { id: "37061234567@s.whatsapp.net", name: "Test" };\n  await socket.ev.emit("creds.update", socket.authState.creds);\n  await socket.ev.emit("connection.update", { connection: "open" });\n\n  row.bot_mode = "assist";\n  const connectedAt = row.connected_at;\n  const error = disconnectError(401, "Stream Errored (conflict)");\n  error.data = { tag: "conflict", attrs: { type: "device_removed" } };\n\n  await socket.ev.emit("connection.update", {\n    connection: "close",\n    lastDisconnect: { error },\n  });\n\n  assert.equal(row.status, "RECONNECTING");\n  assert.equal(row.bot_mode, "assist");\n  assert.equal(row.connected_at, connectedAt);\n  assert.equal(socket.authState.creds.registered, true);\n  assert.ok(session.reconnectTimer, "expected a bounded recovery timer");\n  assert.equal(\n    harness.repositoryStub.__getActivities().filter(\n      (entry) => entry.title === "WhatsApp disconnected"\n    ).length,\n    0\n  );\n});\n\ntest("unexpected 401 exhausts into ERROR without deleting registered auth", async (t) => {\n  const harness = await useHarness(t);\n  const userId = "unexpected-401-exhausted";\n  const row = await harness.repositoryStub.repository.ensureWhatsappSession(userId);\n  const session = await harness.whatsapp.startSession(row.id, { userId });\n  const socket = session.socket;\n\n  socket.authState.creds.registered = true;\n  socket.user = { id: "37061234567@s.whatsapp.net", name: "Test" };\n  await socket.ev.emit("creds.update", socket.authState.creds);\n  await socket.ev.emit("connection.update", { connection: "open" });\n  row.bot_mode = "assist";\n\n  for (let index = 0; index < 4; index += 1) {\n    const error = disconnectError(401, "Stream Errored (conflict)");\n    error.data = { tag: "conflict", attrs: { type: "device_removed" } };\n    await socket.ev.emit("connection.update", {\n      connection: "close",\n      lastDisconnect: { error },\n    });\n\n    if (session.reconnectTimer) {\n      clearTimeout(session.reconnectTimer);\n      session.reconnectTimer = null;\n    }\n  }\n\n  assert.equal(row.status, "ERROR");\n  assert.equal(row.bot_mode, "assist");\n  assert.equal(socket.authState.creds.registered, true);\n  assert.equal(harness.whatsapp.__characterization.sessions.has(row.id), false);\n  assert.equal(\n    harness.repositoryStub.__getActivities().filter(\n      (entry) => entry.title === "WhatsApp disconnected"\n    ).length,\n    0\n  );\n});\n\ntest("locally requested logout close is finalized by the caller, not connection.update", async (t) => {\n  const harness = await useHarness(t);\n  const userId = "local-logout-owner";\n  const row = await harness.repositoryStub.repository.ensureWhatsappSession(userId);\n  const session = await harness.whatsapp.startSession(row.id, { userId });\n  const socket = session.socket;\n\n  socket.authState.creds.registered = true;\n  socket.user = { id: "37061234567@s.whatsapp.net", name: "Test" };\n  await socket.ev.emit("creds.update", socket.authState.creds);\n  await socket.ev.emit("connection.update", { connection: "open" });\n\n  session.logoutRequested = true;\n  session.logoutRequestedAt = new Date().toISOString();\n  await socket.ev.emit("connection.update", {\n    connection: "close",\n    lastDisconnect: { error: disconnectError(401, "Intentional Logout") },\n  });\n\n  assert.equal(row.status, "CONNECTED");\n  assert.equal(session.reconnectTimer, null);\n  assert.equal(\n    harness.repositoryStub.__getActivities().filter(\n      (entry) => entry.title === "WhatsApp disconnected"\n    ).length,\n    0\n  );\n});\n`;
}
await fs.writeFile(characterizationPath, characterization, "utf8");

const boundaryTestPath = "test/managedSessionBoundary.test.js";
let boundaryTest = await fs.readFile(boundaryTestPath, "utf8");
boundaryTest = replaceOnce(
  boundaryTest,
  `        calls.push(["logout"]);`,
  `        calls.push(["logout", runtime?.logoutRequested === true]);`,
  "boundary logout intent observation"
);
boundaryTest = replaceOnce(
  boundaryTest,
  `  assert.ok(logout >= 0);\n  assert.ok(update > logout);`,
  `  assert.ok(logout >= 0);\n  assert.equal(calls[logout][1], true, "logout intent must be marked before socket.logout");\n  assert.ok(update > logout);`,
  "boundary logout intent assertion"
);
await fs.writeFile(boundaryTestPath, boundaryTest, "utf8");

console.log("Applied unexpected 401 recovery safety patch.");
