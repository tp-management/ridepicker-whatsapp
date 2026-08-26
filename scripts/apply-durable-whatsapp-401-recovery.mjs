import fs from "node:fs/promises";

function replaceOnce(source, search, replacement, label) {
  const index = source.indexOf(search);
  if (index < 0) throw new Error(`Missing patch anchor: ${label}`);
  if (source.indexOf(search, index + search.length) >= 0) {
    throw new Error(`Patch anchor is not unique: ${label}`);
  }
  return source.slice(0, index) + replacement + source.slice(index + search.length);
}

function replaceRegexOnce(source, regex, replacement, label) {
  const matches = [...source.matchAll(new RegExp(regex.source, regex.flags.includes("g") ? regex.flags : `${regex.flags}g`))];
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one regex match for ${label}, found ${matches.length}`);
  }
  return source.replace(regex, replacement);
}

async function patchFile(path, patcher) {
  const original = await fs.readFile(path, "utf8");
  const updated = patcher(original);
  if (updated === original) throw new Error(`Patch produced no change: ${path}`);
  await fs.writeFile(path, updated, "utf8");
}

await patchFile("src/supabase.js", (source) =>
  replaceOnce(
    source,
    `export function isSupabaseConfigured() {\n`,
    `export async function callRpc(functionName, body = {}) {\n  return supabaseRequest(\`rpc/\${functionName}\`, {\n    method: "POST",\n    body,\n  });\n}\n\nexport function isSupabaseConfigured() {\n`,
    "supabase callRpc helper"
  )
);

await patchFile("src/repository.js", (source) => {
  source = replaceOnce(
    source,
    `import {\n  deleteRows,\n  insertRows,\n  selectRows,\n  updateRows,\n} from "./supabase.js";`,
    `import {\n  callRpc,\n  deleteRows,\n  insertRows,\n  selectRows,\n  updateRows,\n} from "./supabase.js";`,
    "repository callRpc import"
  );

  return replaceOnce(
    source,
    `  async getRidePickerState(userId) {\n`,
    `  async registerWhatsappUnexpected401(\n    sessionId,\n    { reasonTag = null, conflictType = null, terminalCandidate = false } = {}\n  ) {\n    const decision = await callRpc("register_whatsapp_unexpected_401", {\n      p_session_id: sessionId,\n      p_reason_tag: reasonTag,\n      p_conflict_type: conflictType,\n      p_terminal_candidate: Boolean(terminalCandidate),\n    });\n\n    const sessionRow = await this.getWhatsappSessionById(sessionId);\n    return { ...(decision || {}), sessionRow };\n  },\n\n  async markWhatsappRecoveryStable(sessionId, connectedAt) {\n    if (!connectedAt) return false;\n    return Boolean(\n      await callRpc("mark_whatsapp_recovery_stable", {\n        p_session_id: sessionId,\n        p_connected_at: connectedAt,\n      })\n    );\n  },\n\n  async getRidePickerState(userId) {\n`,
    "repository recovery methods"
  );
});

await patchFile("src/whatsapp/auth/supabaseAuthStore.js", (source) => {
  source = replaceOnce(
    source,
    `  async function has(sessionId) {\n`,
    `  async function clearForRelink(sessionId) {\n    await enqueue(sessionId, () =>\n      request("rpc/ridepicker_whatsapp_auth_prepare_relink", {\n        method: "POST",\n        body: {\n          p_session_id: sessionId,\n          p_auth_type: SUPABASE_AUTH_TYPE,\n        },\n      })\n    );\n  }\n\n  async function has(sessionId) {\n`,
    "auth store explicit relink clear"
  );

  source = replaceOnce(
    source,
    `    clear,\n    waitForMutations,\n`,
    `    clear,\n    clearForRelink,\n    waitForMutations,\n`,
    "auth store relink return"
  );

  return replaceOnce(
    source,
    `export function clearSupabaseAuthState(sessionId) {\n  return defaultStore.clear(sessionId);\n}\n`,
    `export function clearSupabaseAuthState(sessionId) {\n  return defaultStore.clear(sessionId);\n}\n\nexport function clearSupabaseAuthStateForRelink(sessionId) {\n  return defaultStore.clearForRelink(sessionId);\n}\n`,
    "auth store relink export"
  );
});

await patchFile("src/whatsapp.js", (source) => {
  source = replaceOnce(
    source,
    `import {\n  clearSupabaseAuthState,\n  hasSupabaseAuthState,\n  loadSupabaseAuthState,\n} from "./whatsapp/auth/supabaseAuthStore.js";`,
    `import {\n  clearSupabaseAuthState,\n  clearSupabaseAuthStateForRelink,\n  hasSupabaseAuthState,\n  loadSupabaseAuthState,\n} from "./whatsapp/auth/supabaseAuthStore.js";`,
    "whatsapp relink auth import"
  );

  source = replaceOnce(
    source,
    `const unexpectedLogoutRecoveryAttempts = new Map();\n`,
    ``,
    "remove in-memory 401 budget"
  );

  source = replaceRegexOnce(
    source,
    /\/\/ Unsolicited 401s are ambiguous in Baileys v7\.[\s\S]*?const UNEXPECTED_LOGOUT_RETRY_DELAYS_MS = \[2_000, 10_000, 30_000\];\n/,
    `// A recovery incident is forgiven only after the replacement connection\n// proves useful. A real notify message is immediate proof; this continuous-open\n// timer is the quiet-account fallback. The durable retry budget itself lives in\n// Postgres, so this timer is never permission to delete credentials.\nconst UNEXPECTED_401_STABLE_FALLBACK_MS = 5 * 60 * 1000;\n`,
    "replace 401 retry constant"
  );

  source = replaceOnce(
    source,
    `function clearPolicyCache(sessionId) {\n`,
    `function clearRecoveryStableTimer(session) {\n  if (session?.recoveryStableTimer) {\n    clearTimeout(session.recoveryStableTimer);\n    session.recoveryStableTimer = null;\n  }\n}\n\nasync function markSessionRecoveryHealthy(\n  session,\n  { evidence = "stable_connection" } = {}\n) {\n  if (\n    !isCurrentSession(session) ||\n    session.recoveryHealthyMarked ||\n    session.recoveryHealthyMarkInFlight ||\n    !session.durableConnectedAt\n  ) {\n    return false;\n  }\n\n  session.recoveryHealthyMarkInFlight = true;\n\n  try {\n    const cleared = await repository.markWhatsappRecoveryStable(\n      session.id,\n      session.durableConnectedAt\n    );\n\n    if (!isCurrentSession(session)) return false;\n\n    session.recoveryHealthyMarked = true;\n    clearRecoveryStableTimer(session);\n\n    if (cleared) {\n      logWhatsappEvent(\n        session,\n        "info",\n        "unexpected_401_recovery_stable",\n        "WhatsApp recovery proved stable",\n        { evidence }\n      );\n    }\n\n    return true;\n  } catch (error) {\n    console.warn(\n      \`[\${session.id}] could not mark WhatsApp recovery stable:\`,\n      error.message\n    );\n    logWhatsappEvent(\n      session,\n      "warning",\n      "unexpected_401_recovery_stable_write_failed",\n      error.message,\n      { evidence, authPreserved: true }\n    );\n    return false;\n  } finally {\n    session.recoveryHealthyMarkInFlight = false;\n  }\n}\n\nfunction scheduleRecoveryHealthyFallback(session) {\n  clearRecoveryStableTimer(session);\n\n  if (\n    !isCurrentSession(session) ||\n    session.recoveryHealthyMarked ||\n    !session.durableConnectedAt\n  ) {\n    return;\n  }\n\n  session.recoveryStableTimer = setTimeout(() => {\n    session.recoveryStableTimer = null;\n    if (!isCurrentSession(session) || session.status !== "CONNECTED") return;\n    void markSessionRecoveryHealthy(session, {\n      evidence: "continuous_open_5m",\n    });\n  }, UNEXPECTED_401_STABLE_FALLBACK_MS);\n}\n\nfunction clearPolicyCache(sessionId) {\n`,
    "recovery stability helpers"
  );

  source = replaceOnce(
    source,
    `  clearReconnectTimer(session);\n  session.disposed = true;\n`,
    `  clearReconnectTimer(session);\n  clearRecoveryStableTimer(session);\n  session.disposed = true;\n`,
    "drop socket clears recovery stable timer"
  );

  source = replaceOnce(
    source,
    `    openedOnce: false,\n    openedAtMs: null,\n    passkeyRequired: false,\n    reconnectTimer: null,\n    lastError: null,\n    // This flag is set only by RidePicker immediately before socket.logout().\n    // A remote/unsolicited 401 must never be allowed to impersonate that intent.\n    logoutRequested: false,\n    logoutRequestedAt: null,\n    disposed: false,\n`,
    `    openedOnce: false,\n    openedAtMs: null,\n    durableConnectedAt: null,\n    recoveryStableTimer: null,\n    recoveryHealthyMarked: false,\n    recoveryHealthyMarkInFlight: false,\n    passkeyRequired: false,\n    reconnectTimer: null,\n    lastError: null,\n    // Only requestRemoteLogoutForSession() may set this intent. A remote or\n    // unsolicited 401 must never be allowed to impersonate a user logout.\n    logoutRequested: false,\n    logoutRequestedAt: null,\n    logoutPromise: null,\n    disposed: false,\n`,
    "session recovery and logout fields"
  );

  source = replaceRegexOnce(
    source,
    /      \/\/ Do not reset an unexpected-401 retry budget merely because a recovery\n      \/\/ socket reaches open for a moment\.[\s\S]*?      session\.openedAtMs = Date\.now\(\);\n      session\.logoutRequested = false;\n      session\.logoutRequestedAt = null;\n/,
    `      // Reaching open is not enough to forgive an earlier 401. The durable\n      // recovery budget is cleared only by real message traffic or a continuous\n      // five-minute open window.\n      session.openedAtMs = Date.now();\n      clearRecoveryStableTimer(session);\n      session.recoveryHealthyMarked = false;\n      session.recoveryHealthyMarkInFlight = false;\n      session.logoutRequested = false;\n      session.logoutRequestedAt = null;\n`,
    "connection open recovery preamble"
  );

  source = replaceOnce(
    source,
    `      await persistSessionState(session, {\n        status: "CONNECTED",\n        whatsapp_phone: account.phone,\n        display_name: account.name,\n        connected_at: connectedAt,\n        last_seen_at: connectedAt,\n      });\n`,
    `      const persistedConnection = await persistSessionState(session, {\n        status: "CONNECTED",\n        whatsapp_phone: account.phone,\n        display_name: account.name,\n        connected_at: connectedAt,\n        last_seen_at: connectedAt,\n      });\n\n      session.durableConnectedAt =\n        persistedConnection?.connected_at || connectedAt;\n\n      if (persistedConnection?.recovery_state === "recovering") {\n        scheduleRecoveryHealthyFallback(session);\n      } else {\n        session.recoveryHealthyMarked = true;\n      }\n`,
    "persisted connection recovery state"
  );

  source = replaceOnce(
    source,
    `        clearReconnectTimer(session);\n        unexpectedLogoutRecoveryAttempts.delete(id);\n        session.lastError = null;\n`,
    `        clearReconnectTimer(session);\n        clearRecoveryStableTimer(session);\n        session.lastError = null;\n`,
    "expected logout recovery cleanup"
  );

  source = replaceRegexOnce(
    source,
    /function disconnectDetails\(lastDisconnect\) \{[\s\S]*?\n\}\n\nexport function updatePolicyCache/,
    `function disconnectDetails(lastDisconnect) {\n  const error = lastDisconnect?.error;\n\n  const statusCode =\n    error instanceof Boom\n      ? error.output.statusCode\n      : error?.output?.statusCode ||\n        error?.data?.statusCode ||\n        error?.statusCode ||\n        null;\n\n  const message =\n    error?.message ||\n    error?.output?.payload?.message ||\n    "WhatsApp connection closed";\n\n  // Current Baileys attaches the full stream:error node to Boom.data, while\n  // older/custom wrappers may expose the reason node directly or under\n  // data.reasonNode. Support all three shapes and persist only tiny classifier\n  // fields, never the protocol node itself.\n  const data = error?.data && typeof error.data === "object" ? error.data : null;\n  const fullErrorNode =\n    data?.tag === "stream:error"\n      ? data\n      : data?.fullErrorNode?.tag === "stream:error"\n      ? data.fullErrorNode\n      : null;\n  const directReasonNode =\n    data?.reasonNode && typeof data.reasonNode === "object"\n      ? data.reasonNode\n      : data?.tag && data.tag !== "stream:error"\n      ? data\n      : null;\n  const streamChildren = Array.isArray(fullErrorNode?.content)\n    ? fullErrorNode.content.filter(\n        (child) => child && typeof child === "object" && typeof child.tag === "string"\n      )\n    : [];\n  const reasonNode = directReasonNode || streamChildren[0] || null;\n  const conflictNode =\n    reasonNode?.tag === "conflict"\n      ? reasonNode\n      : streamChildren.find((child) => child.tag === "conflict") || null;\n  const reasonTag = conflictNode?.tag || reasonNode?.tag || null;\n  const conflictType =\n    conflictNode && typeof conflictNode?.attrs?.type === "string"\n      ? conflictNode.attrs.type\n      : null;\n\n  return {\n    statusCode,\n    message,\n    reasonTag,\n    conflictType,\n  };\n}\n\nexport function updatePolicyCache`,
    "disconnect detail parser"
  );

  source = replaceRegexOnce(
    source,
    /      \/\/ An unsolicited 401 is NOT sufficient proof of a terminal logout\.[\s\S]*?\n        return;\n      \}\n\n      session\.status = "RECONNECTING";/,
    `      // An unsolicited 401 is ambiguous. In particular, current Baileys\n      // versions have real-world reports of conflict/device_removed on sessions\n      // that were not actually removed. Postgres owns the retry budget so a\n      // process restart cannot turn this into an infinite retry loop.\n      if (statusCode === DisconnectReason.loggedOut) {\n        clearRecoveryStableTimer(session);\n        session.status = "RECONNECTING";\n\n        const terminalCandidate =\n          reasonTag === "conflict" && conflictType === "device_removed";\n\n        let recoveryDecision;\n        try {\n          recoveryDecision = await repository.registerWhatsappUnexpected401(id, {\n            reasonTag,\n            conflictType,\n            terminalCandidate,\n          });\n          if (recoveryDecision?.sessionRow) {\n            updatePolicyCache(recoveryDecision.sessionRow);\n          }\n        } catch (error) {\n          // If durable accounting is unavailable, do not guess and do not\n          // hammer WhatsApp. Stop locally with auth preserved.\n          session.status = "ERROR";\n          session.lastError = {\n            code: "RECOVERY_STATE_UNAVAILABLE",\n            message: error.message,\n          };\n          logWhatsappEvent(\n            session,\n            "error",\n            "unexpected_401_recovery_state_failed",\n            error.message,\n            { statusCode, reasonTag, conflictType, authPreserved: true }\n          );\n          dropSocketSession(session, {\n            removeAuth: false,\n            reason: "Could not persist unexpected 401 recovery state",\n          });\n          return;\n        }\n\n        const attempt = Number(recoveryDecision?.attemptCount || 0);\n\n        if (recoveryDecision?.action !== "retry") {\n          session.status = "ERROR";\n          session.lastError = {\n            code: "RELINK_REQUIRED",\n            message:\n              "WhatsApp no longer accepts the saved RidePicker link. Generate a new connection code to link it again.",\n          };\n\n          logWhatsappEvent(\n            session,\n            "warning",\n            "unexpected_401_relink_required",\n            message,\n            {\n              statusCode,\n              reasonTag,\n              conflictType,\n              attempt,\n              terminalCandidate,\n              authPreserved: true,\n            }\n          );\n\n          dropSocketSession(session, {\n            removeAuth: false,\n            reason: "WhatsApp relink required after bounded 401 recovery",\n          });\n          return;\n        }\n\n        const delayMs = Math.max(0, Number(recoveryDecision.retryDelayMs || 0));\n\n        console.warn(\n          \`[\${id}] unexpected WhatsApp 401; preserving auth and retrying in \${delayMs}ms\`\n        );\n        logWhatsappEvent(\n          session,\n          "warning",\n          "unexpected_401_recovery_started",\n          message,\n          {\n            statusCode,\n            reasonTag,\n            conflictType,\n            attempt,\n            delayMs,\n            terminalCandidate,\n            authPreserved: true,\n          }\n        );\n\n        await forwardSessionEvent({\n          event: "session.reconnecting",\n          session: id,\n          userId: session.userId,\n          timestamp: Date.now(),\n        });\n\n        if (!session.reconnectTimer) {\n          session.reconnectTimer = setTimeout(async () => {\n            session.reconnectTimer = null;\n\n            if (!isCurrentSession(session)) return;\n\n            const userId = session.userId;\n            dropSocketSession(session, {\n              removeAuth: false,\n              reason: "Recovering from unexpected WhatsApp 401",\n            });\n\n            try {\n              await startSession(id, { userId });\n            } catch (error) {\n              console.error(\`[\${id}] unexpected 401 recovery failed:\`, error);\n              void writeSystemLog({\n                userId,\n                sessionId: id,\n                level: "error",\n                source: "whatsapp",\n                event: "unexpected_401_recovery_start_failed",\n                message: error.message,\n                details: { authPreserved: true },\n              });\n\n              await repository.updateWhatsappSessionById(id, {\n                status: "ERROR",\n              });\n            }\n          }, delayMs);\n        }\n\n        return;\n      }\n\n      session.status = "RECONNECTING";`,
    "durable unexpected 401 branch"
  );

  source = replaceOnce(
    source,
    `    if (type !== "notify") {\n      return;\n    }\n\n    for (const message of messages) {\n`,
    `    if (type !== "notify") {\n      return;\n    }\n\n    if (!session.recoveryHealthyMarked && session.durableConnectedAt) {\n      void markSessionRecoveryHealthy(session, { evidence: "message_notify" });\n    }\n\n    for (const message of messages) {\n`,
    "message traffic proves recovery healthy"
  );

  source = replaceOnce(
    source,
    `export async function startManagedSession(\n`,
    `async function prepareExplicitRelink(dbSession) {\n  if (!dbSession || dbSession.recovery_state !== "relink_required") {\n    return dbSession;\n  }\n\n  stopManagedPairingFlow(dbSession.id);\n  const runtime = sessions.get(dbSession.id) || null;\n  if (runtime && isCurrentSession(runtime)) {\n    dropSocketSession(runtime, {\n      removeAuth: false,\n      reason: "Preparing explicit WhatsApp relink",\n    });\n  }\n\n  // This call is serialized behind any pending auth writes and the database RPC\n  // only permits cleanup for ERROR + relink_required. No healthy link can pass.\n  await clearSupabaseAuthStateForRelink(dbSession.id);\n  const refreshed = await repository.getWhatsappSessionById(dbSession.id);\n  if (refreshed) updatePolicyCache(refreshed);\n  return refreshed || dbSession;\n}\n\nexport async function startManagedSession(\n`,
    "explicit relink helper"
  );

  source = replaceOnce(
    source,
    `  const dbSession = await repository.ensureWhatsappSession(userId);\n\n  if (!dbSession) {\n    throw new Error("Could not create WhatsApp session");\n  }\n\n  const session = await startSession(dbSession.id, {\n`,
    `  let dbSession = await repository.ensureWhatsappSession(userId);\n\n  if (!dbSession) {\n    throw new Error("Could not create WhatsApp session");\n  }\n\n  dbSession = await prepareExplicitRelink(dbSession);\n\n  const session = await startSession(dbSession.id, {\n`,
    "QR start prepares relink"
  );

  source = replaceOnce(
    source,
    `  const dbSession = await repository.ensureWhatsappSession(userId);\n  const user = await repository.getUserRowById(userId);\n`,
    `  let dbSession = await repository.ensureWhatsappSession(userId);\n  const user = await repository.getUserRowById(userId);\n`,
    "pairing db session mutable"
  );

  source = replaceOnce(
    source,
    `  let session = sessions.get(dbSession.id) || null;\n\n  if (session?.registered || dbSession.status === "CONNECTED") {\n`,
    `  dbSession = await prepareExplicitRelink(dbSession);\n  let session = sessions.get(dbSession.id) || null;\n\n  if (session?.registered || dbSession.status === "CONNECTED") {\n`,
    "pairing prepares explicit relink"
  );

  source = replaceOnce(
    source,
    `export async function refreshManagedQr(userId) {\n  const dbSession = await repository.getWhatsappSessionByUser(userId);\n\n  if (!dbSession) {\n`,
    `export async function refreshManagedQr(userId) {\n  let dbSession = await repository.getWhatsappSessionByUser(userId);\n\n  if (!dbSession) {\n`,
    "refresh QR mutable session"
  );

  source = replaceOnce(
    source,
    `  let session = sessions.get(dbSession.id);\n\n  if (!session?.socket) {\n`,
    `  dbSession = await prepareExplicitRelink(dbSession);\n  let session = sessions.get(dbSession.id);\n\n  if (!session?.socket) {\n`,
    "refresh QR prepares relink"
  );

  source = replaceOnce(
    source,
    `export async function retryManagedSession(userId) {\n  const dbSession = await repository.getWhatsappSessionByUser(userId);\n\n  if (!dbSession) {\n`,
    `export async function retryManagedSession(userId) {\n  const dbSession = await repository.getWhatsappSessionByUser(userId);\n\n  if (!dbSession) {\n`,
    "retry anchor"
  );

  source = replaceOnce(
    source,
    `  stopManagedPairingFlow(dbSession.id);\n\n  const current = sessions.get(dbSession.id);\n`,
    `  if (dbSession.recovery_state === "relink_required") {\n    const error = new Error(\n      "WhatsApp needs a new connection code. The old saved link was preserved but is no longer being retried."\n    );\n    error.status = 409;\n    error.details = { code: "RELINK_REQUIRED" };\n    throw error;\n  }\n\n  stopManagedPairingFlow(dbSession.id);\n\n  const current = sessions.get(dbSession.id);\n`,
    "retry refuses stale relink auth"
  );

  source = replaceOnce(
    source,
    `export async function disconnectSession(\n`,
    `export async function requestRemoteLogoutForSession(session) {\n  if (!session?.socket || typeof session.socket.logout !== "function") {\n    const error = new Error("Active WhatsApp socket is unavailable for logout.");\n    error.status = 409;\n    throw error;\n  }\n\n  if (session.logoutPromise) {\n    return session.logoutPromise;\n  }\n\n  const socket = session.socket;\n  session.logoutRequested = true;\n  session.logoutRequestedAt = new Date().toISOString();\n\n  session.logoutPromise = (async () => {\n    try {\n      await socket.logout();\n    } catch (error) {\n      session.logoutRequested = false;\n      session.logoutRequestedAt = null;\n      throw error;\n    } finally {\n      session.logoutPromise = null;\n    }\n  })();\n\n  return session.logoutPromise;\n}\n\nexport async function disconnectSession(\n`,
    "central remote logout helper"
  );

  source = replaceRegexOnce(
    source,
    /      session\.logoutRequested = true;\n      session\.logoutRequestedAt = new Date\(\)\.toISOString\(\);\n\n      try \{[\s\S]*?        await session\.socket\.logout\(\);\n      \} catch \(error\) \{\n        session\.logoutRequested = false;\n        session\.logoutRequestedAt = null;/,
    `      try {\n        // requestRemoteLogoutForSession is the only production primitive that\n        // may mark a close as intentional.\n        await requestRemoteLogoutForSession(session);\n      } catch (error) {`,
    "disconnectSession uses central logout helper"
  );

  source = replaceOnce(
    source,
    `      if (session.socket) {\n        session.logoutRequested = true;\n        session.logoutRequestedAt = new Date().toISOString();\n        await session.socket.logout();\n      }\n`,
    `      if (session.socket) {\n        await requestRemoteLogoutForSession(session);\n      }\n`,
    "best effort logout uses central helper"
  );

  source = replaceOnce(
    source,
    `let status =\n  dbStatus && terminalDbStatus.has(dbStatus)\n    ? dbStatus\n    : memorySession?.status || dbStatus || "DISCONNECTED";\n`,
    `let status =\n  dbStatus && terminalDbStatus.has(dbStatus)\n    ? dbStatus\n    : memorySession?.status || dbStatus || "DISCONNECTED";\nconst relinkRequired = dbSession?.recovery_state === "relink_required";\n\n// Internally this remains ERROR so restart recovery never trusts the stale\n// credentials. User-facing state is disconnected so the pairing UI offers a\n// fresh connection code immediately.\nif (relinkRequired) {\n  status = "DISCONNECTED";\n}\n`,
    "relink user-facing status"
  );

  source = replaceOnce(
    source,
    `    error:\n      managedFlow?.lastError || memorySession?.lastError || null,\n`,
    `    error:\n      managedFlow?.lastError ||\n      memorySession?.lastError ||\n      (relinkRequired\n        ? {\n            code: "RELINK_REQUIRED",\n            message:\n              "WhatsApp needs a new connection code. Your old saved link was preserved and will not be retried again.",\n          }\n        : null),\n`,
    "durable relink error"
  );

  if (source.includes("unexpectedLogoutRecoveryAttempts")) {
    throw new Error("in-memory unexpected 401 budget still present");
  }
  return source;
});

await patchFile("src/whatsapp/managedSessionBoundary.js", (source) => {
  source = replaceOnce(
    source,
    `  getSession,\n  startSession,\n  updatePolicyCache,\n`,
    `  getSession,\n  requestRemoteLogoutForSession,\n  startSession,\n  updatePolicyCache,\n`,
    "managed boundary central logout import"
  );

  source = replaceOnce(
    source,
    `  startSession: startSessionAdapter,\n  updatePolicyCache: updatePolicyCacheAdapter = () => {},\n`,
    `  startSession: startSessionAdapter,\n  requestRemoteLogoutForSession: requestRemoteLogoutForSessionAdapter =\n    requestRemoteLogoutForSession,\n  updatePolicyCache: updatePolicyCacheAdapter = () => {},\n`,
    "managed boundary logout adapter"
  );

  source = replaceOnce(
    source,
    `      connected_at: null,\n    });\n`,
    `      connected_at: null,\n      recovery_state: "idle",\n      recovery_attempt_count: 0,\n      recovery_incident_started_at: null,\n      recovery_last_event_at: null,\n      recovery_reason_tag: null,\n      recovery_conflict_type: null,\n    });\n`,
    "manual logout resets recovery metadata"
  );

  source = replaceOnce(
    source,
    `      // Mark local intent before Baileys emits its 401-style close event.\n      // The connection handler will then defer all irreversible cleanup to this\n      // explicit caller, which finalizes only after logout() resolves.\n      runtimeSession.logoutRequested = true;\n      runtimeSession.logoutRequestedAt = new Date().toISOString();\n      await runtimeSession.socket.logout();\n`,
    `      // Centralized helper marks intent before Baileys can emit its\n      // 401-style close. No other production call site owns this flag.\n      await requestRemoteLogoutForSessionAdapter(runtimeSession);\n`,
    "managed boundary centralized logout"
  );

  source = replaceOnce(
    source,
    `      if (runtimeSession) {\n        runtimeSession.logoutRequested = false;\n        runtimeSession.logoutRequestedAt = null;\n      }\n\n`,
    ``,
    "remove duplicated logout flag cleanup"
  );

  source = replaceOnce(
    source,
    `    if (["CONNECTED", "RECONNECTING"].includes(dbSession.status)) {\n      return dbSession;\n    }\n`,
    `    if (dbSession.recovery_state === "relink_required") {\n      // Ordinary GET/POST reconciliation must not revive credentials that the\n      // bounded recovery state has already quarantined for explicit relinking.\n      return dbSession;\n    }\n\n    if (["CONNECTED", "RECONNECTING"].includes(dbSession.status)) {\n      return dbSession;\n    }\n`,
    "relink state blocks automatic reconciliation"
  );

  return source;
});

await patchFile("src/whatsapp/restartRecovery.js", (source) => {
  source = replaceOnce(
    source,
    `    // Registered Baileys credentials are stronger evidence than a transient DB\n`,
    `    // relink_required is a durable quarantine, not a transient ERROR snapshot.\n    // Preserve the registered auth for explicit user relinking, but never revive\n    // it automatically after a process restart.\n    if (dbSession.recovery_state === "relink_required") {\n      await log({\n        userId,\n        sessionId: dbSession.id,\n        level: "warning",\n        source: "whatsapp",\n        event: "session_restore_relink_required",\n        message: "WhatsApp session requires an explicit new pairing code",\n        details: {\n          previousStatus: dbSession.status,\n          authExists: auth.exists,\n          authRegistered: auth.registered,\n          authPreserved: true,\n        },\n      });\n      return { sessionId: dbSession.id, action: "relink_required_auth_preserved" };\n    }\n\n    // Registered Baileys credentials are stronger evidence than a transient DB\n`,
    "restart recovery honors relink quarantine"
  );

  source = replaceOnce(
    source,
    `    if (session.reconnectTimer) {\n      clearTimeout(session.reconnectTimer);\n      session.reconnectTimer = null;\n    }\n\n    session.disposed = true;\n`,
    `    if (session.reconnectTimer) {\n      clearTimeout(session.reconnectTimer);\n      session.reconnectTimer = null;\n    }\n    if (session.recoveryStableTimer) {\n      clearTimeout(session.recoveryStableTimer);\n      session.recoveryStableTimer = null;\n    }\n\n    session.disposed = true;\n`,
    "shutdown clears recovery stable timer"
  );

  return source;
});

await patchFile("test/helpers/createWhatsappHarness.js", (source) => {
  source = replaceOnce(
    source,
    `      ` + "`export async function clearSupabaseAuthState(sessionId) { states.delete(sessionId); }\\n` +\n" +
      `      ` + "`export async function hasSupabaseAuthState(sessionId) { return states.has(sessionId); }\\n`\n",
    `      ` + "`export async function clearSupabaseAuthState(sessionId) { states.delete(sessionId); }\\n` +\n" +
      `      ` + "`export async function clearSupabaseAuthStateForRelink(sessionId) { states.delete(sessionId); }\\n` +\n" +
      `      ` + "`export async function hasSupabaseAuthState(sessionId) { return states.has(sessionId); }\\n`\n",
    "harness relink auth export"
  );

  source = replaceOnce(
    source,
    `      ` + "`    row = { id: \\`session-\\${userId}\\`, user_id: userId, status: \\\"DISCONNECTED\\\", bot_mode: \\\"off\\\", whatsapp_phone: null, display_name: null, connected_at: null, last_seen_at: null };\\n` +\n",
    `      ` + "`    row = { id: \\`session-\\${userId}\\`, user_id: userId, status: \\\"DISCONNECTED\\\", bot_mode: \\\"off\\\", whatsapp_phone: null, display_name: null, connected_at: null, last_seen_at: null, recovery_state: \\\"idle\\\", recovery_attempt_count: 0, recovery_incident_started_at: null, recovery_last_event_at: null, recovery_reason_tag: null, recovery_conflict_type: null };\\n` +\n",
    "harness recovery row defaults"
  );

  source = replaceOnce(
    source,
    `      ` + "`  async addActivity(userId, entry) { const row = { userId, ...entry }; activities.push(row); return row; },\\n` +\n",
    `      ` + "`  async registerWhatsappUnexpected401(sessionId, { reasonTag = null, conflictType = null, terminalCandidate = false } = {}) { const row = sessionsById.get(sessionId); if (!row) throw new Error(\\\"session not found\\\"); if (row.recovery_state === \\\"relink_required\\\") return { action: \\\"relink_required\\\", attemptCount: row.recovery_attempt_count, retryDelayMs: null, recoveryState: row.recovery_state, sessionRow: row }; if (row.recovery_state !== \\\"recovering\\\") { row.recovery_attempt_count = 0; row.recovery_incident_started_at = new Date().toISOString(); } row.recovery_attempt_count += 1; row.recovery_last_event_at = new Date().toISOString(); row.recovery_reason_tag = reasonTag; row.recovery_conflict_type = conflictType; let delay = null; if (terminalCandidate) { delay = row.recovery_attempt_count === 1 ? 2000 : null; } else { delay = [2000, 10000, 30000][row.recovery_attempt_count - 1] ?? null; } row.recovery_state = delay === null ? \\\"relink_required\\\" : \\\"recovering\\\"; row.status = delay === null ? \\\"ERROR\\\" : \\\"RECONNECTING\\\"; return { action: delay === null ? \\\"relink_required\\\" : \\\"retry\\\", attemptCount: row.recovery_attempt_count, retryDelayMs: delay, recoveryState: row.recovery_state, sessionRow: row }; },\\n` +\n" +
      `      ` + "`  async markWhatsappRecoveryStable(sessionId, connectedAt) { const row = sessionsById.get(sessionId); if (!row || row.status !== \\\"CONNECTED\\\" || row.connected_at !== connectedAt || row.recovery_state === \\\"idle\\\") return false; row.recovery_state = \\\"idle\\\"; row.recovery_attempt_count = 0; row.recovery_incident_started_at = null; row.recovery_last_event_at = null; row.recovery_reason_tag = null; row.recovery_conflict_type = null; return true; },\\n` +\n" +
      `      ` + "`  async addActivity(userId, entry) { const row = { userId, ...entry }; activities.push(row); return row; },\\n` +\n",
    "harness recovery repository methods"
  );

  return source;
});

await patchFile("test/whatsappCharacterization.test.js", (source) =>
  replaceOnce(
    source,
    `    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);\n    session.reconnectTimer = null;\n`,
    `    if (session.reconnectTimer) clearTimeout(session.reconnectTimer);\n    if (session.recoveryStableTimer) clearTimeout(session.recoveryStableTimer);\n    session.reconnectTimer = null;\n    session.recoveryStableTimer = null;\n`,
    "characterization recovery timer cleanup"
  )
);

console.log("Durable WhatsApp 401 recovery patch applied.");
