import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import {
  PATCH_CHAIN,
  materializeCurrentPatchedWhatsapp,
  patchCallOrderFromIndex,
} from "./helpers/materializePatchedWhatsapp.js";

const EXPECTED_PATCH_ORDER = PATCH_CHAIN.map(([, exportName]) => exportName);

test("index.js applies WhatsApp source patches in the characterized order", async () => {
  const indexSource = await fs.readFile(path.join(process.cwd(), "index.js"), "utf8");
  assert.deepEqual(patchCallOrderFromIndex(indexSource), EXPECTED_PATCH_ORDER);
});

test("current patch chain materializes the final production WhatsApp source", async (t) => {
  const materialized = await materializeCurrentPatchedWhatsapp();
  t.after(materialized.cleanup);

  const source = materialized.source;

  for (const marker of [
    "WA_PAIRING_HARDENING_V1",
    "WA_PAIRING_QUERY_ACK_V2",
    "WA_PAIRING_UX_V1",
    "WA_PAIRING_FEEDBACK_V1",
    "BAILEYS_RAW_UI_ERRORS_V1",
    "WA_REMOTE_LOGOUT_V2",
    "BAILEYS_RAW_LOGGING_V1",
  ]) {
    assert.match(source, new RegExp(marker));
  }

  assert.match(
    source,
    /statusCode === DisconnectReason\.timedOut\s*&&\s*flow\.published\s*&&\s*codeAgeMs >= MANAGED_PAIRING_NATURAL_EXPIRY_MIN_AGE_MS/
  );
  assert.match(source, /if \(flow\.requestInFlight\) \{\s*return null;\s*\}/);
  assert.match(source, /rate\[-_\\s\]\?overlimit\|rate\[-_\\s\]\?limit/i);
  assert.match(source, /const candidateCode = await requestVerifiedPairingCode\(/);
  assert.match(source, /await session\.socket\.logout\(\);/);
  assert.match(source, /logger: createBaileysRawLogger\(/);
  assert.doesNotMatch(source, /WhatsApp confirmed linked-device removal/);
});
