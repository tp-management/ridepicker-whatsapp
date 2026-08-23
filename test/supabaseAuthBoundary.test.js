import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

async function read(relativePath) {
  return fs.readFile(path.join(process.cwd(), relativePath), "utf8");
}

test("current WhatsApp runtime has no filesystem auth dependency", async () => {
  const [whatsappSource, authSource] = await Promise.all([
    read("src/whatsapp.js"),
    read("src/whatsapp/auth/supabaseAuthStore.js"),
  ]);
  const runtime = `${whatsappSource}\n${authSource}`;

  for (const forbidden of [
    "useMultiFileAuthState",
    "DATA_DIR",
    "authPathFor",
    "removeAuthDirectory",
    "ensureFileAuthRoot",
    "fileAuthStore",
    "authCleanup",
    "fs.existsSync",
    "fs.readdirSync",
  ]) {
    assert.equal(
      runtime.includes(forbidden),
      false,
      `filesystem auth token should be absent: ${forbidden}`
    );
  }

  assert.match(whatsappSource, /loadSupabaseAuthState/);
  assert.match(whatsappSource, /hasSupabaseAuthState/);
  assert.match(whatsappSource, /clearSupabaseAuthState/);
});
