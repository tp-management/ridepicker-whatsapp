import { insertRows, isSupabaseConfigured } from "./supabase.js";

const ALLOWED_LEVELS = new Set([
  "debug",
  "info",
  "warning",
  "error",
]);

const REDACTED_KEYS = new Set([
  "authorization",
  "apikey",
  "api_key",
  "token",
  "access_token",
  "refresh_token",
  "secret",
  "password",
  "cookie",
  "set-cookie",
  "pairingcode",
  "pairing_code",
  "qr",
  "qrdata",
  "qr_data",
  "creds",
  "credentials",
  "privatekey",
  "private_key",
]);

const WHATSAPP_JID_PATTERN =
  /(?:[a-z0-9._+-]+|\d+(?::\d+)?)@(?:s\.whatsapp\.net|lid|c\.us|g\.us|broadcast|newsletter)/gi;
const PHONE_IDENTIFIER_PATTERN =
  /(?<![\w@])\+?\d(?:[\s().-]*\d){6,14}(?![\w@])/g;
const BEARER_PATTERN = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const SENSITIVE_QUERY_PATTERN =
  /([?&](?:token|access_token|refresh_token|secret|apikey|api_key)=)[^&#\s]+/gi;

const PROCESS_STARTED_AT = new Date().toISOString();

function sanitizeText(value) {
  return String(value ?? "")
    .replace(WHATSAPP_JID_PATTERN, "[redacted-jid]")
    .replace(PHONE_IDENTIFIER_PATTERN, "[redacted-phone]")
    .replace(BEARER_PATTERN, "Bearer [redacted]")
    .replace(SENSITIVE_QUERY_PATTERN, "$1[redacted]");
}

function safeString(value, maxLength = 1500) {
  const text = sanitizeText(value);

  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}…`;
}

function sanitize(value, depth = 0) {
  if (depth > 5) {
    return "[max-depth]";
  }

  if (value === null || value === undefined) {
    return value ?? null;
  }

  if (value instanceof Error) {
    return {
      name: value.name || "Error",
      message: safeString(value.message || ""),
      status: value.status || value.statusCode || null,
      code:
        value.code ||
        value?.output?.statusCode ||
        value?.output?.payload?.statusCode ||
        null,
      stack: value.stack ? safeString(value.stack, 3000) : null,
    };
  }

  if (Buffer.isBuffer(value)) {
    return `[buffer:${value.length}]`;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "string") {
    return safeString(value);
  }

  if (typeof value === "number" || typeof value === "boolean") {
    return value;
  }

  if (Array.isArray(value)) {
    return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  }

  if (typeof value === "object") {
    const output = {};

    for (const [key, item] of Object.entries(value)) {
      if (REDACTED_KEYS.has(String(key).toLowerCase())) {
        output[key] = "[redacted]";
        continue;
      }

      output[key] = sanitize(item, depth + 1);
    }

    return output;
  }

  return safeString(value);
}

function normalizeSource(source) {
  const value = safeString(source || "backend", 100);

  if (value === "whatsapp") {
    return "ridepicker_whatsapp";
  }

  return value;
}

function runtimeContext() {
  return {
    projectId: process.env.RAILWAY_PROJECT_ID || null,
    environmentId: process.env.RAILWAY_ENVIRONMENT_ID || null,
    serviceId: process.env.RAILWAY_SERVICE_ID || null,
    deploymentId: process.env.RAILWAY_DEPLOYMENT_ID || null,
    replicaId: process.env.RAILWAY_REPLICA_ID || null,
    gitCommit:
      process.env.RAILWAY_GIT_COMMIT_SHA ||
      process.env.RAILWAY_GIT_COMMIT ||
      null,
    node: process.version,
    pid: process.pid,
    processStartedAt: PROCESS_STARTED_AT,
  };
}

function classifyActionability(source, event, level) {
  if (source === "n8n" && event === "n8n_failed") {
    return "expected";
  }

  if (/relink_required|recovery_state_failed|validation_failed/i.test(event)) {
    return "actionable";
  }

  if (source === "baileys_raw" || source === "whatsapp_raw") {
    return level === "error" ? "attention" : "diagnostic";
  }

  if (level === "error") return "actionable";
  if (level === "warning") return "attention";
  return "diagnostic";
}

function provenanceFor(source) {
  if (source === "whatsapp_raw") return "whatsapp_raw";
  if (source === "baileys_raw") return "baileys_raw";
  if (source === "ridepicker_whatsapp") return "ridepicker_whatsapp";
  return "ridepicker_backend";
}

function withProvenance(source, event, level, details) {
  const sanitized = sanitize(details || {});
  const base =
    sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)
      ? sanitized
      : { value: sanitized };

  return {
    ...base,
    provenance:
      base.provenance || provenanceFor(source),
    actionability:
      base.actionability || classifyActionability(source, event, level),
    runtime: {
      ...(base.runtime && typeof base.runtime === "object" ? base.runtime : {}),
      ...runtimeContext(),
    },
    ...(source === "n8n" && event === "n8n_failed"
      ? { expectedByDesign: true }
      : {}),
  };
}

/**
 * Best-effort persistent system logging.
 *
 * The persistent timeline intentionally keeps both native Baileys diagnostics
 * and RidePicker-authored lifecycle events. The latter explain what decision
 * the application made after a low-level protocol event, which is essential
 * when diagnosing reconnect/relink behavior. Logging must never become part of
 * the correctness path: a logging failure is reported to Railway and swallowed.
 */
export async function writeSystemLog({
  userId = null,
  sessionId = null,
  level = "info",
  source = "backend",
  event,
  message = null,
  details = {},
} = {}) {
  if (!isSupabaseConfigured() || !event) {
    return null;
  }

  const normalizedLevel = ALLOWED_LEVELS.has(level)
    ? level
    : "info";
  const normalizedSource = normalizeSource(source);
  const normalizedEvent = safeString(event, 150);

  try {
    const rows = await insertRows("system_logs", [
      {
        user_id: userId || null,
        session_id: sessionId || null,
        level: normalizedLevel,
        source: normalizedSource,
        event: normalizedEvent,
        message: message ? safeString(message, 1500) : null,
        details: withProvenance(
          normalizedSource,
          normalizedEvent,
          normalizedLevel,
          details
        ),
      },
    ]);

    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (error) {
    console.error(
      `[system_logs] write failed for ${normalizedEvent}:`,
      safeString(error.message)
    );
    return null;
  }
}

export const __systemLog = {
  classifyActionability,
  runtimeContext,
  sanitize,
  safeString,
};
