import test from "node:test";
import assert from "node:assert/strict";

import { createBaileysRawLogger } from "../src/whatsapp/logging/baileysLogger.js";

function captureLogger() {
  const persisted = [];
  const writeLog = (entry) => {
    persisted.push(entry);
    return Promise.resolve(entry);
  };

  return {
    persisted,
    logger: createBaileysRawLogger({ writeLog }),
  };
}

test("Baileys trace logs are not persisted when min level is debug", () => {
  const { logger, persisted } = captureLogger();

  logger.trace("handshake recv from WA");

  assert.equal(persisted.length, 0);
});

test("Baileys debug/info/warn logs are persisted at debug threshold", () => {
  const { logger, persisted } = captureLogger();

  logger.debug("debug message");
  logger.info("info message");
  logger.warn("warn message");

  assert.deepEqual(
    persisted.map((entry) => entry.details.baileysLevel),
    ["debug", "info", "warn"]
  );
});

test("Baileys structured diagnostics never persist raw args", () => {
  const { logger, persisted } = captureLogger();

  logger.warn(
    {
      statusCode: 500,
      jid: "37061234567@s.whatsapp.net",
      arbitraryPayload: { secret: "do-not-store" },
    },
    "connection errored"
  );

  assert.equal(persisted.length, 1);
  assert.equal(persisted[0].details.diagnostics.statusCode, 500);
  assert.equal(Object.hasOwn(persisted[0].details, "args"), false);
  assert.doesNotMatch(JSON.stringify(persisted[0]), /37061234567|do-not-store/);
});

test("Baileys warn logs redact WhatsApp JIDs and phone-like identifiers", () => {
  const { logger, persisted } = captureLogger();

  logger.warn(
    "Invalid LID-PN mapping: 37061234567@s.whatsapp.net, 123456789012345@lid"
  );

  assert.equal(persisted.length, 1);

  const serialized = JSON.stringify(persisted[0]);

  assert.doesNotMatch(serialized, /37061234567/);
  assert.doesNotMatch(serialized, /123456789012345/);
  assert.doesNotMatch(serialized, /@s\.whatsapp\.net/);
  assert.doesNotMatch(serialized, /@lid/);
  assert.match(persisted[0].message, /\[redacted-jid\]/);
});

test("Baileys error diagnostics redact identifiers inside error.message", () => {
  const { logger, persisted } = captureLogger();
  const error = new Error(
    "mapping failed for +37061234567 and 123456789012345@lid"
  );

  logger.warn({ err: error }, "mapping failed");

  assert.equal(persisted.length, 1);

  const serialized = JSON.stringify(persisted[0]);

  assert.doesNotMatch(serialized, /37061234567/);
  assert.doesNotMatch(serialized, /123456789012345/);
  assert.doesNotMatch(serialized, /@lid/);
  assert.equal(
    persisted[0].details.diagnostics.error.message,
    "mapping failed for [redacted-phone] and [redacted-jid]"
  );
});
