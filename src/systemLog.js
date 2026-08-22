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
  "secret",
  "password",
  "cookie",
  "pairingcode",
  "pairing_code",
  "qr",
  "qrdata",
  "qr_data",
]);

function safeString(value, maxLength = 1500) {
  const text = String(value ?? "");

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
      status: value.status || null,
      code:
        value.code ||
        value?.output?.statusCode ||
        value?.output?.payload?.statusCode ||
        null,
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

function withProvenance(source, details) {
  const sanitized = sanitize(details || {});

  if (!sanitized || typeof sanitized !== "object" || Array.isArray(sanitized)) {
    return sanitized;
  }

  if (Object.prototype.hasOwnProperty.call(sanitized, "provenance")) {
    return sanitized;
  }

  if (source === "whatsapp_raw") {
    return { ...sanitized, provenance: "whatsapp_raw" };
  }

  if (source === "baileys_raw") {
    return { ...sanitized, provenance: "baileys_raw" };
  }

  return sanitized;
}

/**
 * Best-effort persistent system logging.
 *
 * WhatsApp diagnostics in Supabase must come from the native Baileys logger.
 * RidePicker-authored WhatsApp lifecycle sentences are intentionally not
 * persisted here. Other application sources such as n8n/backend remain valid.
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

  if (normalizedSource === "ridepicker_whatsapp") {
    return null;
  }

  try {
    const rows = await insertRows("system_logs", [
      {
        user_id: userId || null,
        session_id: sessionId || null,
        level: normalizedLevel,
        source: normalizedSource,
        event: safeString(event, 150),
        message: message ? safeString(message, 1500) : null,
        details: withProvenance(normalizedSource, details),
      },
    ]);

    return Array.isArray(rows) && rows.length ? rows[0] : null;
  } catch (error) {
    console.error(
      `[system_logs] write failed for ${event}:`,
      error.message
    );
    return null;
  }
}
