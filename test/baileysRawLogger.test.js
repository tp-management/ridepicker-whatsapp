import test from "node:test";
import assert from "node:assert/strict";

import { createBaileysRawLogger } from "../src/baileysRawLogger.js";

test("Baileys warn logs redact WhatsApp JIDs and phone-like identifiers", () => {
  const persisted = [];
  const writeLog = (entry) => {
    persisted.push(entry);
    return Promise.resolve(entry);
  };

  const logger = createBaileysRawLogger({ writeLog });

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
  const persisted = [];
  const writeLog = (entry) => {
    persisted.push(entry);
    return Promise.resolve(entry);
  };

  const logger = createBaileysRawLogger({ writeLog });
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
