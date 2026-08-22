import fs from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const whatsappPath = fileURLToPath(new URL("./whatsapp.js", import.meta.url));
const marker = "const WA_PAIRING_FEEDBACK_V1 = true;";

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);

  if (first === -1 || first !== last) {
    throw new Error(
      `WhatsApp pairing feedback target mismatch (${label}). Expected exactly one match.`
    );
  }

  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function applyWhatsappPairingFeedback() {
  const original = fs.readFileSync(whatsappPath, "utf8");

  if (original.includes(marker)) {
    return false;
  }

  let source = original;

  source = replaceExactlyOnce(
    source,
    `const WA_PAIRING_UX_V1 = true;\nconst WA_WEB_VERSION_CACHE_MS = 10 * 60 * 1000;`,
    `const WA_PAIRING_UX_V1 = true;\n${marker}\nconst PAIRING_RATE_LIMIT_COOLDOWN_MS = 5 * 60 * 1000;\nconst WA_WEB_VERSION_CACHE_MS = 10 * 60 * 1000;`,
    "feedback marker"
  );

  // Hardening V1 used to classify every Baileys 408 as ordinary code expiry.
  // That turns transport/handshake timeouts into an unbounded immediate retry
  // loop. Only a code that was actually published and has lived close to the
  // expected WhatsApp expiry window is allowed to take the zero-delay refresh
  // path. Early 408s go through the normal bounded circuit breaker instead.
  source = replaceExactlyOnce(
    source,
    `  const naturalExpiry =\n    statusCode === DisconnectReason.timedOut;`,
    `  const naturalExpiry =\n    statusCode === DisconnectReason.timedOut &&\n    flow.published &&\n    codeAgeMs >= MANAGED_PAIRING_NATURAL_EXPIRY_MIN_AGE_MS;`,
    "bounded 408 expiry classification"
  );

  source = replaceExactlyOnce(
    source,
    `  const phoneChanged = flow.phoneDigits !== digits;\n  const restartingAfterTerminalError = !flow.active;\n\n  if (phoneChanged || restartingAfterTerminalError) {`,
    `  const phoneChanged = flow.phoneDigits !== digits;\n  const restartingAfterTerminalError = !flow.active;\n  const rateLimitUntilMs = flow.rateLimitUntil\n    ? new Date(flow.rateLimitUntil).getTime()\n    : 0;\n\n  if (!phoneChanged && rateLimitUntilMs > Date.now()) {\n    const error = new Error(\n      "WhatsApp is temporarily limiting new connection codes. Please wait a few minutes before trying again."\n    );\n    error.status = 429;\n    error.details = { retryAt: flow.rateLimitUntil };\n    throw error;\n  }\n\n  if (flow.rateLimitUntil && rateLimitUntilMs <= Date.now()) {\n    flow.rateLimitUntil = null;\n  }\n\n  if (phoneChanged) {\n    flow.rateLimitUntil = null;\n  }\n\n  if (phoneChanged || restartingAfterTerminalError) {`,
    "rate-limit cooldown guard"
  );

  source = replaceExactlyOnce(
    source,
    `  const canAutoRetry =\n    naturalExpiry ||\n    flow.failureCount <= MANAGED_PAIRING_MAX_AUTOMATIC_RETRIES;\n\n  // Keep a frontend-safe notification in the same in-memory pairing flow.\n  // This lets polling clients explain a failed first attempt instead of\n  // showing an apparently frozen spinner. Natural code expiry is routine and\n  // therefore does not produce a warning toast.\n  if (!naturalExpiry) {\n    const firstFailure = flow.failureCount === 1;\n    flow.notice = {\n      id: \`pairing_failure_\${flow.lastFailureAt}\`,\n      type: canAutoRetry ? "warning" : "error",\n      title: canAutoRetry\n        ? firstFailure\n          ? "Connection code needs another try"\n          : "Still trying to create your connection code"\n        : "Could not create a connection code",\n      message: canAutoRetry\n        ? firstFailure\n          ? "The first attempt did not complete. RidePicker is retrying automatically."\n          : "WhatsApp did not complete the last attempt. RidePicker is retrying automatically."\n        : "Automatic retries stopped. Tap Generate connection code to try again.",\n      failureCount: flow.failureCount,\n      retrying: canAutoRetry,\n      retryAt: null,\n    };\n  }\n\n  if (session) {`,
    `  const rateLimited =\n    statusCode === 429 ||\n    /rate[-_\\s]?overlimit|rate[-_\\s]?limit/i.test(String(message || ""));\n\n  if (rateLimited) {\n    flow.rateLimitUntil = new Date(\n      Date.now() + PAIRING_RATE_LIMIT_COOLDOWN_MS\n    ).toISOString();\n    flow.lastError = {\n      code: "RATE_LIMITED",\n      message:\n        "WhatsApp is temporarily limiting new connection codes. RidePicker stopped retrying automatically. Please wait a few minutes before trying again.",\n    };\n  }\n\n  const canAutoRetry =\n    naturalExpiry ||\n    (!rateLimited &&\n      flow.failureCount <= MANAGED_PAIRING_MAX_AUTOMATIC_RETRIES);\n\n  // Keep a frontend-safe notification in the same in-memory pairing flow.\n  // Rate limiting is terminal for the current attempt because retrying it\n  // immediately only extends the server-side throttle.\n  if (rateLimited) {\n    flow.notice = {\n      id: \`pairing_rate_limited_\${flow.lastFailureAt}\`,\n      type: "error",\n      title: "WhatsApp temporarily limited new codes",\n      message: flow.lastError.message,\n      failureCount: flow.failureCount,\n      retrying: false,\n      retryAt: flow.rateLimitUntil,\n    };\n  } else if (!naturalExpiry) {\n    const firstFailure = flow.failureCount === 1;\n    flow.notice = {\n      id: \`pairing_failure_\${flow.lastFailureAt}\`,\n      type: canAutoRetry ? "warning" : "error",\n      title: canAutoRetry\n        ? firstFailure\n          ? "Connection code needs another try"\n          : "Still trying to create your connection code"\n        : "Could not create a connection code",\n      message: canAutoRetry\n        ? firstFailure\n          ? "The first attempt did not complete. RidePicker is retrying automatically."\n          : "WhatsApp did not complete the last attempt. RidePicker is retrying automatically."\n        : "Automatic retries stopped. Tap Generate connection code to try again.",\n      failureCount: flow.failureCount,\n      retrying: canAutoRetry,\n      retryAt: null,\n    };\n  }\n\n  if (session) {`,
    "stop retries on rate limit"
  );

  source = replaceExactlyOnce(
    source,
    `export async function refreshManagedSession(userId) {\n  return getManagedSession(userId);\n}\n\nexport async function requestManagedPairingCode(userId, phone = null) {`,
    `export async function refreshManagedSession(userId) {\n  return getManagedSession(userId);\n}\n\nasync function waitForManagedPairingOutcome(flow, timeoutMs = 20_000) {\n  const deadline = Date.now() + timeoutMs;\n\n  while (Date.now() < deadline) {\n    if (managedPairingCodeIsVisible(flow)) {\n      return "code_ready";\n    }\n\n    if (flow?.lastError) {\n      return "error";\n    }\n\n    if (!flow?.active && !flow?.requestInFlight) {\n      return "stopped";\n    }\n\n    await sleep(75);\n  }\n\n  return "timeout";\n}\n\nexport async function requestManagedPairingCode(userId, phone = null) {`,
    "first attempt outcome waiter"
  );

  source = replaceExactlyOnce(
    source,
    `    void ensureManagedPairingAttempt(flow, {\n      reason: hadVisibleCode ? "manual_refresh" : "manual_start",\n      forceNewCode: hadVisibleCode,\n    });\n  }\n\n  const latest = await repository.getWhatsappSessionByUser(userId);\n  return normalizeManagedSession(latest, sessions.get(dbSession.id) || session);\n}`,
    `    void ensureManagedPairingAttempt(flow, {\n      reason: hadVisibleCode ? "manual_refresh" : "manual_start",\n      forceNewCode: hadVisibleCode,\n    });\n  }\n\n  // Keep the POST open just long enough to know whether the first attempt\n  // produced a real code or failed. Existing frontend error handling can then\n  // show a toast immediately instead of leaving the user staring at a spinner.\n  const firstOutcome = await waitForManagedPairingOutcome(flow);\n  const latest = await repository.getWhatsappSessionByUser(userId);\n  const normalized = normalizeManagedSession(\n    latest,\n    sessions.get(dbSession.id) || session\n  );\n\n  if (!normalized?.pairingCode && firstOutcome === "error" && flow.lastError) {\n    const error = new Error(\n      flow.notice?.message ||\n        flow.lastError.message ||\n        "Could not create a WhatsApp connection code."\n    );\n    error.status =\n      flow.lastError.code === "RATE_LIMITED" ? 429 : 503;\n    error.details = {\n      code: flow.lastError.code || null,\n      retrying: Boolean(flow.active && (flow.retryTimer || flow.requestInFlight)),\n      retryAt: flow.notice?.retryAt || flow.retryAt || null,\n    };\n    throw error;\n  }\n\n  return normalized;\n}`,
    "surface first pairing failure to existing frontend"
  );

  fs.writeFileSync(whatsappPath, source);

  const check = spawnSync(process.execPath, ["--check", whatsappPath], {
    encoding: "utf8",
  });

  if (check.status !== 0) {
    fs.writeFileSync(whatsappPath, original);
    throw new Error(
      `Generated WhatsApp pairing feedback patch failed syntax check: ${check.stderr || check.stdout}`
    );
  }

  console.log("[whatsapp] pairing feedback guard applied");
  return true;
}
