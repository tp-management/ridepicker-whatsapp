import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";

async function listJsFiles(root) {
  const result = [];
  for (const entry of await fs.readdir(root, { withFileTypes: true })) {
    const full = path.join(root, entry.name);
    if (entry.isDirectory()) {
      result.push(...(await listJsFiles(full)));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      result.push(full);
    }
  }
  return result;
}

test("native socket.logout has exactly one production owner", async () => {
  const files = await listJsFiles("src");
  const calls = [];

  for (const file of files) {
    const source = await fs.readFile(file, "utf8");
    const matches = source.match(/\b(?:[A-Za-z_$][\w$]*\.)*logout\s*\(\s*\)/g) || [];
    for (const match of matches) calls.push({ file, match });
  }

  assert.deepEqual(calls, [
    { file: path.join("src", "whatsapp.js"), match: "socket.logout()" },
  ]);

  const whatsapp = await fs.readFile(path.join("src", "whatsapp.js"), "utf8");
  assert.match(
    whatsapp,
    /export async function requestRemoteLogoutForSession\(session\)[\s\S]*?await socket\.logout\(\)/
  );
});
