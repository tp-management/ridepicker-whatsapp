import { writeSystemLog } from "./systemLog.js";

const LEVEL_MAP = {
  trace: "debug",
  debug: "debug",
  info: "info",
  warn: "warning",
  error: "error",
  fatal: "error",
};

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

function makeLogger({ userId, sessionId, bindings = {} }) {
  const emit = (baileysLevel, args) => {
    void writeSystemLog({
      userId,
      sessionId,
      level: LEVEL_MAP[baileysLevel] || "info",
      source: "baileys_raw",
      event: "log",
      message: exactMessage(args),
      details: {
        baileysLevel,
        bindings,
        args,
      },
    });
  };

  return {
    // Baileys checks logger.level in a few hot paths. Keep trace disabled so
    // encrypted/XMPP wire dumps are not persisted, while native debug/info/
    // warn/error logger calls are captured exactly as Baileys emitted them.
    level: "debug",

    child(childBindings = {}) {
      return makeLogger({
        userId,
        sessionId,
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

export function createBaileysRawLogger({ userId = null, sessionId = null } = {}) {
  return makeLogger({
    userId,
    sessionId,
    bindings: {},
  });
}
