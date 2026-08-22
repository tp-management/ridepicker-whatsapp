import fs from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const whatsappPath = fileURLToPath(new URL("./whatsapp.js", import.meta.url));
const marker = "const WA_PAIRING_HARDENING_V1 = true;";

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);

  if (first === -1 || first !== last) {
    throw new Error(
      `WhatsApp pairing hardening target mismatch (${label}). Expected exactly one match.`
    );
  }

  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function applyWhatsappPairingHardening() {
  const original = fs.readFileSync(whatsappPath, "utf8");

  if (original.includes(marker)) {
    return false;
  }

  let source = original;

  source = replaceExactlyOnce(
    source,
    `import makeWASocket, {\n  DisconnectReason,\n  useMultiFileAuthState,\n} from "@whiskeysockets/baileys";`,
    `import makeWASocket, {\n  DisconnectReason,\n  fetchLatestWaWebVersion,\n  useMultiFileAuthState,\n} from "@whiskeysockets/baileys";`,
    "Baileys imports"
  );

  source = replaceExactlyOnce(
    source,
    `const PAIRING_READY_TIMEOUT_MS = 15 * 1000;\nconst REGISTRATION_CONFIRM_TIMEOUT_MS = 5 * 1000;`,
    `const PAIRING_READY_TIMEOUT_MS = 15 * 1000;\nconst REGISTRATION_CONFIRM_TIMEOUT_MS = 5 * 1000;\n${marker}\nconst WA_WEB_VERSION_CACHE_MS = 10 * 60 * 1000;\n\nlet cachedWaWebVersion = null;\nlet cachedWaWebVersionExpiresAt = 0;\n\nasync function resolveWaWebVersion() {\n  if (\n    cachedWaWebVersion &&\n    Date.now() < cachedWaWebVersionExpiresAt\n  ) {\n    return cachedWaWebVersion;\n  }\n\n  try {\n    const result = await fetchLatestWaWebVersion({\n      signal: AbortSignal.timeout(5_000),\n    });\n    const version = Array.isArray(result?.version)\n      ? result.version\n      : null;\n\n    if (version?.length === 3) {\n      cachedWaWebVersion = version;\n      cachedWaWebVersionExpiresAt =\n        Date.now() + WA_WEB_VERSION_CACHE_MS;\n      console.log(\n        \`[whatsapp] using WA Web version \${version.join(".")}\`\n      );\n      return version;\n    }\n  } catch (error) {\n    console.warn(\n      "[whatsapp] could not fetch current WA Web version:",\n      error.message\n    );\n  }\n\n  return null;\n}`,
    "pairing constants"
  );

  source = replaceExactlyOnce(
    source,
    `    registered: Boolean(state?.creds?.registered),\n    reconnectTimer: null,\n    lastError: null,\n    disposed: false,`,
    `    registered: Boolean(state?.creds?.registered),\n    openedOnce: false,\n    passkeyRequired: false,\n    reconnectTimer: null,\n    lastError: null,\n    disposed: false,`,
    "session lifecycle fields"
  );

  source = replaceExactlyOnce(
    source,
    `  // Keep the socket configuration intentionally small and use Baileys defaults.\n  // This is the previously stable RidePicker socket configuration.\n  const socket = makeWASocket({\n    auth: state,\n    markOnlineOnConnect: false,\n    printQRInTerminal: false,\n  });`,
    `  // Use the current WhatsApp Web version for fresh device linking when it\n  // can be resolved. Existing Baileys defaults remain the safe fallback.\n  const waWebVersion = await resolveWaWebVersion();\n  const socket = makeWASocket({\n    auth: state,\n    ...(waWebVersion ? { version: waWebVersion } : {}),\n    markOnlineOnConnect: false,\n    printQRInTerminal: false,\n  });`,
    "socket configuration"
  );

  source = replaceExactlyOnce(
    source,
    `  session.socket = socket;\n\n  socket.ev.on("creds.update", async () => {`,
    `  session.socket = socket;\n\n  // WhatsApp can require an additional passkey/WebAuthn step for selected\n  // accounts after pairing-code companion_finish. Baileys rc14 otherwise ACKs\n  // that notification without completing it, leaving the user waiting until a\n  // misleading 408. Detect the requirement immediately and discard partial\n  // credentials instead of pretending the device is registered.\n  socket.ws?.on?.("CB:notification", (node) => {\n    const notificationType = node?.attrs?.type || null;\n\n    if (\n      ![\n        "passkey_prologue_request",\n        "crsc_continuation",\n      ].includes(notificationType) ||\n      !isCurrentSession(session)\n    ) {\n      return;\n    }\n\n    const hasRequestOptions = Boolean(\n      Array.isArray(node?.content) &&\n        node.content.some(\n          (child) => child?.tag === "passkey_request_options"\n        )\n    );\n    const pairingFlow = managedPairingFlows.get(id) || null;\n\n    session.passkeyRequired = true;\n    session.lastError = {\n      code: "PASSKEY_REQUIRED",\n      message:\n        "WhatsApp requires an additional passkey verification step for this account.",\n    };\n\n    if (pairingFlow) {\n      pairingFlow.lastError = session.lastError;\n    }\n\n    logWhatsappEvent(\n      session,\n      "warning",\n      "pairing_passkey_required",\n      "WhatsApp requires passkey verification during device linking",\n      {\n        notificationType,\n        hasRequestOptions,\n      }\n    );\n\n    stopManagedPairingFlow(id, {\n      keepForError: true,\n    });\n\n    void persistSessionState(session, {\n      status: "ERROR",\n    });\n\n    // Give Baileys' own notification listener time to ACK the stanza before\n    // dropping the unusable partial auth state. No challenge contents are\n    // logged or persisted by RidePicker.\n    setTimeout(() => {\n      if (!isCurrentSession(session) || !session.passkeyRequired) {\n        return;\n      }\n\n      session.registered = false;\n      dropSocketSession(session, {\n        removeAuth: true,\n        reason: "Passkey-required WhatsApp pairing cannot use partial auth",\n      });\n    }, 750);\n  });\n\n  socket.ev.on("creds.update", async () => {`,
    "passkey detection"
  );

  source = replaceExactlyOnce(
    source,
    `    if (!wasRegistered && session.registered) {\n      console.log(\`[\${id}] WhatsApp credentials registered\`);\n      logWhatsappEvent(\n        session,\n        "info",\n        "credentials_registered",\n        "WhatsApp credentials registered"\n      );\n    }`,
    `    if (!wasRegistered && session.registered) {\n      const pairingFlow = managedPairingFlows.get(id) || null;\n\n      // The phone has consumed the pairing code. From this moment the code is\n      // no longer useful to the user, even though the socket may still need a\n      // 515 restart before reaching connection=open. Hide it immediately and\n      // cancel the wall-clock rotation timer. If Baileys later reports 408,\n      // that transport event is the authoritative expiry signal and a fresh\n      // code is generated immediately.\n      if (pairingFlow?.active) {\n        if (pairingFlow.rotateTimer) {\n          clearTimeout(pairingFlow.rotateTimer);\n          pairingFlow.rotateTimer = null;\n        }\n        pairingFlow.published = false;\n        pairingFlow.code = null;\n        pairingFlow.codeRotatesAt = null;\n\n        session.pairingCode = null;\n        session.pairingCodeIssuedAt = null;\n\n        logWhatsappEvent(\n          session,\n          "info",\n          "pairing_code_consumed",\n          "WhatsApp pairing code was consumed by the phone"\n        );\n      }\n\n      console.log(\`[\${id}] WhatsApp credentials registered\`);\n      logWhatsappEvent(\n        session,\n        "info",\n        "credentials_registered",\n        "WhatsApp credentials registered"\n      );\n    }`,
    "hide consumed pairing code"
  );

  source = replaceExactlyOnce(
    source,
    `  const naturalExpiry =\n    statusCode === DisconnectReason.timedOut &&\n    codeAgeMs >= MANAGED_PAIRING_NATURAL_EXPIRY_MIN_AGE_MS;`,
    `  // Baileys' 408/timedOut event is the source of truth for pairing-code\n  // expiry. Do not infer validity from RidePicker's display countdown because\n  // WhatsApp can retire the underlying refs earlier than our nominal timer.\n  const naturalExpiry =\n    statusCode === DisconnectReason.timedOut;`,
    "Baileys authoritative expiry"
  );

  source = replaceExactlyOnce(
    source,
    `  const delay = naturalExpiry\n    ? 1_000\n    : managedPairingRetryDelay(flow.failureCount);\n\n  void writeSystemLog({`,
    `  const delay = naturalExpiry\n    ? 0\n    : managedPairingRetryDelay(flow.failureCount);\n\n  void writeSystemLog({`,
    "zero-delay expiry retry"
  );

  source = replaceExactlyOnce(
    source,
    `  flow.retryTimer = setTimeout(() => {\n    flow.retryTimer = null;\n\n    if (!flow.active) return;\n\n    void ensureManagedPairingAttempt(flow, {\n      reason: naturalExpiry ? 'expired_code_retry' : 'auto_retry',\n      forceNewCode: true,\n    });\n  }, delay);`,
    `  if (naturalExpiry) {\n    // Start the replacement attempt in the same lifecycle turn. Socket setup\n    // and WhatsApp's next QR challenge still take real network time, but there\n    // is no artificial RidePicker delay anymore.\n    void ensureManagedPairingAttempt(flow, {\n      reason: 'expired_code_retry',\n      forceNewCode: true,\n    });\n    return;\n  }\n\n  flow.retryTimer = setTimeout(() => {\n    flow.retryTimer = null;\n\n    if (!flow.active) return;\n\n    void ensureManagedPairingAttempt(flow, {\n      reason: 'auto_retry',\n      forceNewCode: true,\n    });\n  }, delay);`,
    "immediate expired code replacement"
  );

  source = replaceExactlyOnce(
    source,
    `    if (connection === "open") {\n      clearReconnectTimer(session);\n\n      const actuallyRegistered = await waitForRegisteredSession(`,
    `    if (connection === "open") {\n      clearReconnectTimer(session);\n      session.openedOnce = true;\n      session.passkeyRequired = false;\n\n      const actuallyRegistered = await waitForRegisteredSession(`,
    "connection open confirmation"
  );

  source = replaceExactlyOnce(
    source,
    `      const restartRequired =\n        statusCode === DisconnectReason.restartRequired;\n      const managedFlow = managedPairingFlows.get(id) || null;\n\n      // creds.update and connection.update are separate async event streams.`,
    `      const restartRequired =\n        statusCode === DisconnectReason.restartRequired;\n      const managedFlow = managedPairingFlows.get(id) || null;\n\n      // companion_finish can set creds.registered=true before the newly linked\n      // device has ever reached connection=open. A 408/401/428 at this point is\n      // still a failed pairing, not a healthy registered session that should be\n      // reconnected with half-completed credentials.\n      const failedBeforeFirstOpen =\n        managedFlow?.active &&\n        !session.openedOnce &&\n        [\n          DisconnectReason.timedOut,\n          DisconnectReason.loggedOut,\n          DisconnectReason.connectionClosed,\n        ].includes(statusCode);\n\n      if (failedBeforeFirstOpen) {\n        session.registered = false;\n\n        await handleManagedPairingFailure(managedFlow, session, {\n          statusCode,\n          message,\n          phase: "post_registration_pre_open",\n        });\n\n        return;\n      }\n\n      // creds.update and connection.update are separate async event streams.`,
    "pre-open failure classification"
  );

  fs.writeFileSync(whatsappPath, source);

  const check = spawnSync(process.execPath, ["--check", whatsappPath], {
    encoding: "utf8",
  });

  if (check.status !== 0) {
    fs.writeFileSync(whatsappPath, original);
    throw new Error(
      `Generated WhatsApp pairing hardening failed syntax check: ${check.stderr || check.stdout}`
    );
  }

  console.log("[whatsapp] pairing hardening applied");
  return true;
}
