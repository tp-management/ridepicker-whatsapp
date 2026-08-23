import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { materializeCurrentPatchedWhatsapp } from "./helpers/materializePatchedWhatsapp.js";

const CANONICALIZATION_PROOF_SHA256 =
  "e639e4806d2e7ff291f8ddccf2246e06922d176ebe095a31a377e1099ef05480";

test("archived patch chain still reproduces the canonicalization proof source", async (t) => {
  const materialized = await materializeCurrentPatchedWhatsapp();
  t.after(materialized.cleanup);

  const digest = createHash("sha256")
    .update(materialized.source, "utf8")
    .digest("hex");

  assert.equal(digest, CANONICALIZATION_PROOF_SHA256);
});

test("index.js no longer imports or executes runtime WhatsApp source patches", async () => {
  const indexSource = await fs.readFile(
    path.join(process.cwd(), "index.js"),
    "utf8"
  );

  assert.doesNotMatch(indexSource, /apply(?:Whatsapp|Baileys)\w+/);
  assert.match(indexSource, /import\("\.\/src\/whatsapp\.js"\)/);
});
