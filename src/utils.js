export function normalizePhoneE164(value) {
  const raw = String(value || "").trim();

  if (!raw) {
    throw new Error("phone is required");
  }

  let normalized = raw.replace(/[\s().-]/g, "");

  if (normalized.startsWith("00")) {
    normalized = `+${normalized.slice(2)}`;
  }

  if (!normalized.startsWith("+")) {
    normalized = `+${normalized.replace(/\D/g, "")}`;
  }

  if (!/^\+[1-9][0-9]{7,14}$/.test(normalized)) {
    throw new Error(
      "phone must use international E.164 format, e.g. +447700900123"
    );
  }

  return normalized;
}

export function phoneDigits(value) {
  return normalizePhoneE164(value).slice(1);
}

export function isoFromWhatsappTimestamp(value) {
  let seconds = null;

  if (typeof value === "number") {
    seconds = value;
  } else if (typeof value === "bigint") {
    seconds = Number(value);
  } else if (typeof value === "string") {
    seconds = Number(value);
  } else if (value && typeof value.toNumber === "function") {
    seconds = value.toNumber();
  } else if (value && typeof value.low === "number") {
    seconds = value.low;
  }

  if (!Number.isFinite(seconds) || seconds <= 0) {
    return new Date().toISOString();
  }

  return new Date(seconds * 1000).toISOString();
}

export function toFrontendWhatsappStatus(status) {
  const map = {
    DISCONNECTED: "logged_out",
    STARTING: "starting",
    QR: "qr",
    CONNECTED: "connected",
    RECONNECTING: "reconnecting",
    LOGGED_OUT: "logged_out",
    ERROR: "logged_out",
  };

  return map[status] || "logged_out";
}

export function createHttpError(status, message, details = null) {
  const error = new Error(message);
  error.status = status;
  error.details = details;
  return error;
}

export function safeJson(value, fallback = null) {
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}
