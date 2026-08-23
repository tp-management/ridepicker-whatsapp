import { writeSystemLog } from "../../systemLog.js";

const LEVEL_MAP = {
  trace: "debug",
  debug: "debug",
  info: "info",
  warn: "warning",
  error: "error",
  fatal: "error",
};

const LEVEL_VALUE = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

const MIN_LEVEL = "debug";

const DIAGNOSTIC_KEYS = new Set([
  "statusCode",
  "code",
  "reason",
  "type",
  "tag",
  "xmlns",
  "msgId",
  "connection",
  "retryCount",
  "attempt",
  "timeoutMs",
  "isOnline",
  "isNewLogin",
  "receivedPendingNotifications",
  "shouldSyncHistoryMessage",
]);

const BINDING_KEYS = new Set([
  "class",
  "component",
  "module",
  "scope",
]);

const WHATSAPP_JID_PATTERN =
  /(?:[a-z0-9._+-]+|\d+(?::\d+)?)@(?:s\.whatsapp\.net|lid|c\.us|g\.us|broadcast|newsletter)/gi;
const PHONE_IDENTIFIER_PATTERN =
  /(?<![\w@])\+?\d(?:[\s().-]*\d){6,14}(?![\w@])/g;

export function sanitizeBaileysLogText(value) {
  if (typeof value !== "string") {
    return value ?? null;
  }

  return value
    .replace(WHATSAPP_JID_PATTERN, "[redacted-jid]")
    .replace(PHONE_IDENTIFIER_PATTERN, "[redacted-phone]");
}

function exactMessage(args) {
  for (let index = args.length - 1; index >= 0; index -= 1) {
    if (typeof args[index] === "string") {
      return args[index];
    }
  }

  const first = args[0];
  if (first && typeof first === "object" && typeof first.msg === "string") {
    return first.msg;
  }

  return null;
}

function scalar(value) {
  return ["string", "number", "boolean"].includes(typeof value)
    ? value
    : null;
}

function errorDiagnostics(error) {
  if (!error || typeof error !== "object") {
    return null;
  }

  const output = {};
  const name = scalar(error.name);
  const rawMessage = scalar(error.message);
  const message =
    typeof rawMessage === "string"
      ? sanitizeBaileysLogText(rawMessage)
      : rawMessage;
  const code = scalar(error.code);
  const statusCode =
    scalar(error.statusCode) ??
    scalar(error.status) ??
    scalar(error?.output?.statusCode) ??
    scalar(error?.output?.payload?.statusCode);

  if (name !== null) output.name = name;
  if (message !== null) output.message = message;
  if (code !== null) output.code = code;
  if (statusCode !== null) output.statusCode = statusCode;

  return Object.keys(output).length ? output : null;
}

function pickDiagnostics(args) {
  const diagnostics = {};

  for (const arg of args) {
    if (!arg || typeof arg !== "object") continue;

    const directError = arg instanceof Error ? errorDiagnostics(arg) : null;
    if (directError) {
      diagnostics.error = directError;
      continue;
    }

    for (const key of DIAGNOSTIC_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(arg, key)) continue;

      const value = scalar(arg[key]);
      if (value !== null) {
        diagnostics[key] = value;
      }
    }

    const nestedError = errorDiagnostics(arg.err || arg.error);
    if (nestedError) {
      diagnostics.error = nestedError;
    }
  }

  return diagnostics;
}

function pickBindings(bindings) {
  const output = {};

  for (const key of BINDING_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(bindings, key)) continue;

    const value = scalar(bindings[key]);
    if (value !== null) {
      output[key] = value;
    }
  }

  return output;
}

function makeLogger({
  userId,
  sessionId,
  bindings = {},
  minLevel = MIN_LEVEL,
  writeLog = writeSystemLog,
}) {
  const threshold = LEVEL_VALUE[minLevel] ?? LEVEL_VALUE.debug;
  const enabled = (level) => (LEVEL_VALUE[level] ?? Infinity) >= threshold;

  const emit = (baileysLevel, args) => {
    if (!enabled(baileysLevel)) return;

    const diagnostics = pickDiagnostics(args);
    const safeBindings = pickBindings(bindings);

    void writeLog({
      userId,
      sessionId,
      level: LEVEL_MAP[baileysLevel] || "info",
      source: "baileys_raw",
      event: "log",
      message: sanitizeBaileysLogText(exactMessage(args)),
      details: {
        baileysLevel,
        ...(Object.keys(safeBindings).length ? { bindings: safeBindings } : {}),
        ...(Object.keys(diagnostics).length ? { diagnostics } : {}),
      },
    });
  };

  return {
    // Baileys uses logger.level for a few explicit guards, but also contains
    // unguarded logger.trace() calls. The methods below therefore enforce the
    // threshold themselves as the actual persistence boundary.
    level: minLevel,

    child(childBindings = {}) {
      return makeLogger({
        userId,
        sessionId,
        minLevel,
        writeLog,
        bindings: {
          ...bindings,
          ...childBindings,
        },
      });
    },

    trace(...args) {
      emit("trace", args);
    },
    debug(...args) {
      emit("debug", args);
    },
    info(...args) {
      emit("info", args);
    },
    warn(...args) {
      emit("warn", args);
    },
    error(...args) {
      emit("error", args);
    },
    fatal(...args) {
      emit("fatal", args);
    },
  };
}

export function createBaileysRawLogger({
  userId = null,
  sessionId = null,
  writeLog = writeSystemLog,
} = {}) {
  return makeLogger({
    userId,
    sessionId,
    bindings: {},
    writeLog,
  });
}
