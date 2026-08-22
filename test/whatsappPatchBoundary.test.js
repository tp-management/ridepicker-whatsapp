import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

import { materializeCurrentPatchedWhatsapp } from "./helpers/materializePatchedWhatsapp.js";

test("canonical whatsapp.js is byte-for-byte identical to materialized final patched source", async (t) => {
  const materialized = await materializeCurrentPatchedWhatsapp();
  t.after(materialized.cleanup);

  const canonical = await fs.readFile(
    path.join(process.cwd(), "src", "whatsapp.js")
  );
  const expected = Buffer.from(materialized.source, "utf8");

  assert.equal(
    canonical.equals(expected),
    true,
    "src/whatsapp.js must exactly equal the FINAL legacy patch-chain output"
  );
});

test("index.js no longer imports or executes runtime WhatsApp source patches", async () => {
  const indexSource = await fs.readFile(
    path.join(process.cwd(), "index.js"),
    "utf8"
  );

  assert.doesNotMatch(indexSource, /apply(?:Whatsapp|Baileys)\w+/);
  assert.match(indexSource, /import\("\.\/src\/whatsapp\.js"\)/);
});
