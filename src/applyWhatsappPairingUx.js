import fs from "fs";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const whatsappPath = fileURLToPath(new URL("./whatsapp.js", import.meta.url));
const marker = "const WA_PAIRING_UX_V1 = true;";

function replaceExactlyOnce(source, before, after, label) {
  const first = source.indexOf(before);
  const last = source.lastIndexOf(before);

  if (first === -1 || first !== last) {
    throw new Error(
      `WhatsApp pairing UX target mismatch (${label}). Expected exactly one match.`
    );
  }

  return source.slice(0, first) + after + source.slice(first + before.length);
}

export function applyWhatsappPairingUx() {
  const original = fs.readFileSync(whatsappPath, "utf8");

  if (original.includes(marker)) {
    return false;
  }

  let source = original;

  source = replaceExactlyOnce(
    source,
    `const WA_PAIRING_QUERY_ACK_V2 = true;\nconst WA_WEB_VERSION_CACHE_MS = 10 * 60 * 1000;`,
    `const WA_PAIRING_QUERY_ACK_V2 = true;\n${marker}\nconst WA_WEB_VERSION_CACHE_MS = 10 * 60 * 1000;`,
    "UX marker"
  );

  source = replaceExactlyOnce(
    source,
    `      published: false,\n      lastError: null,\n      lastFailureAt: null,`,
    `      published: false,\n      lastError: null,\n      lastFailureAt: null,\n      retryAt: null,\n      notice: null,`,
    "pairing flow UX state"
  );

  source = replaceExactlyOnce(
    source,
    `    flow.failureCount = 0;\n    flow.lastError = null;\n    flow.lastFailureAt = null;`,
    `    flow.failureCount = 0;\n    flow.lastError = null;\n    flow.lastFailureAt = null;\n    flow.retryAt = null;\n    flow.notice = null;`,
    "reset pairing UX state"
  );

  source = replaceExactlyOnce(
    source,
    `  const canAutoRetry =\n    naturalExpiry ||\n    flow.failureCount <= MANAGED_PAIRING_MAX_AUTOMATIC_RETRIES;\n\n  if (session) {`,
    `  const canAutoRetry =\n    naturalExpiry ||\n    flow.failureCount <= MANAGED_PAIRING_MAX_AUTOMATIC_RETRIES;\n\n  // Keep a frontend-safe notification in the same in-memory pairing flow.\n  // This lets polling clients explain a failed first attempt instead of\n  // showing an apparently frozen spinner. Natural code expiry is routine and\n  // therefore does not produce a warning toast.\n  if (!naturalExpiry) {\n    const firstFailure = flow.failureCount === 1;\n    flow.notice = {\n      id: \`pairing_failure_\${flow.lastFailureAt}\`,\n      type: canAutoRetry ? "warning" : "error",\n      title: canAutoRetry\n        ? firstFailure\n          ? "Connection code needs another try"\n          : "Still trying to create your connection code"\n        : "Could not create a connection code",\n      message: canAutoRetry\n        ? firstFailure\n          ? "The first attempt did not complete. RidePicker is retrying automatically."\n          : "WhatsApp did not complete the last attempt. RidePicker is retrying automatically."\n        : "Automatic retries stopped. Tap Generate connection code to try again.",\n      failureCount: flow.failureCount,\n      retrying: canAutoRetry,\n      retryAt: null,\n    };\n  }\n\n  if (session) {`,
    "pairing failure notice"
  );

  source = replaceExactlyOnce(
    source,
    `  const delay = naturalExpiry\n    ? 0\n    : managedPairingRetryDelay(flow.failureCount);\n\n  void writeSystemLog({`,
    `  const delay = naturalExpiry\n    ? 0\n    : managedPairingRetryDelay(flow.failureCount);\n\n  flow.retryAt = new Date(Date.now() + delay).toISOString();\n  if (flow.notice?.retrying) {\n    flow.notice.retryAt = flow.retryAt;\n  }\n\n  void writeSystemLog({`,
    "pairing retry ETA"
  );

  source = replaceExactlyOnce(
    source,
    `  if (naturalExpiry) {\n    // Start the replacement attempt in the same lifecycle turn. Socket setup\n    // and WhatsApp's next QR challenge still take real network time, but there\n    // is no artificial RidePicker delay anymore.\n    void ensureManagedPairingAttempt(flow, {`,
    `  if (naturalExpiry) {\n    // Start the replacement attempt in the same lifecycle turn. Socket setup\n    // and WhatsApp's next QR challenge still take real network time, but there\n    // is no artificial RidePicker delay anymore.\n    flow.retryAt = null;\n    void ensureManagedPairingAttempt(flow, {`,
    "clear instant retry ETA"
  );

  source = replaceExactlyOnce(
    source,
    `  flow.retryTimer = setTimeout(() => {\n    flow.retryTimer = null;\n\n    if (!flow.active) return;`,
    `  flow.retryTimer = setTimeout(() => {\n    flow.retryTimer = null;\n    flow.retryAt = null;\n\n    if (!flow.active) return;`,
    "clear scheduled retry ETA"
  );

  source = replaceExactlyOnce(
    source,
    `    flow.codeRotatesAt = new Date(\n      issuedAt.getTime() + MANAGED_PAIRING_ROTATE_MS\n    ).toISOString();\n    flow.published = true;\n    flow.lastError = null;`,
    `    flow.codeRotatesAt = new Date(\n      issuedAt.getTime() + MANAGED_PAIRING_ROTATE_MS\n    ).toISOString();\n    flow.published = true;\n    flow.lastError = null;\n    flow.retryAt = null;\n\n    if (flow.failureCount > 0) {\n      flow.notice = {\n        id: \`pairing_recovered_\${flow.codeIssuedAt}\`,\n        type: "success",\n        title: "Connection code ready",\n        message:\n          flow.failureCount === 1\n            ? "The first attempt did not complete, but RidePicker created a fresh code automatically."\n            : \`RidePicker created a fresh code automatically after \${flow.failureCount} failed attempts.\`,\n        failureCount: flow.failureCount,\n        retrying: false,\n        retryAt: null,\n      };\n    }`,
    "pairing recovered notice"
  );

  source = replaceExactlyOnce(
    source,
    `    error:\n      managedFlow?.lastError || memorySession?.lastError || null,\n  };`,
    `    error:\n      managedFlow?.lastError || memorySession?.lastError || null,\n    pairingProgress: managedFlow\n      ? {\n          phase: pairingCode\n            ? "code_ready"\n            : managedFlow.active\n            ? managedFlow.retryAt\n              ? "retry_wait"\n              : managedFlow.requestInFlight\n              ? "generating"\n              : "starting"\n            : managedFlow.lastError\n            ? "failed"\n            : "idle",\n          attempt: Math.max(1, (managedFlow.failureCount || 0) + 1),\n          failureCount: managedFlow.failureCount || 0,\n          retryAt: managedFlow.retryAt || null,\n        }\n      : null,\n    pairingNotice: managedFlow?.notice || null,\n  };`,
    "frontend pairing progress"
  );

  fs.writeFileSync(whatsappPath, source);

  const check = spawnSync(process.execPath, ["--check", whatsappPath], {
    encoding: "utf8",
  });

  if (check.status !== 0) {
    fs.writeFileSync(whatsappPath, original);
    throw new Error(
      `Generated WhatsApp pairing UX patch failed syntax check: ${check.stderr || check.stdout}`
    );
  }

  console.log("[whatsapp] pairing UX notices applied");
  return true;
}
