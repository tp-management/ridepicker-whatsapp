import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";

const ROOT = process.cwd();

async function read(relativePath) {
  return fs.readFile(path.join(ROOT, relativePath), "utf8");
}

async function walkRuntimeFiles(relativeDir) {
  const absoluteDir = path.join(ROOT, relativeDir);
  const entries = await fs.readdir(absoluteDir, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const relativePath = path.join(relativeDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await walkRuntimeFiles(relativePath)));
      continue;
    }

    if (/\.(?:js|mjs|cjs)$/.test(entry.name)) {
      files.push(relativePath);
    }
  }

  return files;
}

test("runtime source has no local filesystem persistence dependency", async () => {
  const runtimeFiles = ["index.js", ...(await walkRuntimeFiles("src"))];
  const forbiddenPatterns = [
    {
      label: "filesystem module import",
      pattern:
        /(?:from\s+["'](?:node:)?fs(?:\/promises)?["']|import\s*\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\)|require\s*\(\s*["'](?:node:)?fs(?:\/promises)?["']\s*\))/,
    },
    { label: "Baileys multi-file auth", pattern: /\buseMultiFileAuthState\b/ },
    {
      label: "legacy data directory",
      pattern: /\bDATA_DIR\b/,
      allowedPaths: new Set(["src/config.js"]),
    },
    {
      label: "legacy session restore flag",
      pattern: /\bRESTORE_LEGACY_SESSIONS\b/,
      allowedPaths: new Set(["src/config.js"]),
    },
    {
      label: "runtime source patcher",
      pattern: /\bapply(?:Whatsapp|Baileys)[A-Za-z0-9_]*\b/,
    },
    {
      label: "legacy filesystem auth helper",
      pattern:
        /\b(?:authPathFor|removeAuthDirectory|ensureFileAuthRoot|fileAuthStore|authCleanup)\b/,
    },
  ];

  for (const relativePath of runtimeFiles) {
    const source = await read(relativePath);

    for (const { label, pattern, allowedPaths } of forbiddenPatterns) {
      if (allowedPaths?.has(relativePath)) continue;

      assert.doesNotMatch(
        source,
        pattern,
        `${relativePath} must not contain ${label}`
      );
    }
  }
});

test("WhatsApp auth runtime is Supabase-only", async () => {
  const [whatsappSource, authSource] = await Promise.all([
    read("src/whatsapp.js"),
    read("src/whatsapp/auth/supabaseAuthStore.js"),
  ]);

  assert.match(whatsappSource, /loadSupabaseAuthState/);
  assert.match(whatsappSource, /hasSupabaseAuthState/);
  assert.match(whatsappSource, /clearSupabaseAuthState/);
  assert.match(authSource, /ridepicker_whatsapp_auth_read/);
  assert.match(authSource, /ridepicker_whatsapp_auth_write/);
  assert.match(authSource, /ridepicker_whatsapp_auth_clear/);
});

test("legacy local-storage source artifacts are absent", async () => {
  const runtimeFiles = await walkRuntimeFiles("src");
  const basenames = new Set(runtimeFiles.map((file) => path.basename(file)));

  for (const forbiddenName of [
    "fileAuthStore.js",
    "authCleanup.js",
    "applyWhatsappPairingHardening.js",
    "applyWhatsappPairingHelloAck.js",
    "applyWhatsappPairingUx.js",
    "applyWhatsappPairingFeedback.js",
    "applyBaileysRawUiErrors.js",
    "applyWhatsappRemoteLogout.js",
    "applyBaileysRawLogging.js",
  ]) {
    assert.equal(
      basenames.has(forbiddenName),
      false,
      `obsolete runtime artifact must be deleted: ${forbiddenName}`
    );
  }

  const rootEntries = await fs.readdir(ROOT);
  assert.equal(rootEntries.includes("data"), false, "repository must not contain data/");

  const gitignore = await read(".gitignore");
  assert.doesNotMatch(
    gitignore,
    /^\s*data\/?\s*$/m,
    ".gitignore must not preserve a legacy data/ directory convention"
  );

  const readme = await read("README.md");
  for (const forbiddenDocToken of [
    "DATA_DIR",
    "RESTORE_LEGACY_SESSIONS",
    "Railway Volume mounted at",
  ]) {
    assert.equal(
      readme.includes(forbiddenDocToken),
      false,
      `README must not instruct operators to use legacy local storage: ${forbiddenDocToken}`
    );
  }
});

test("obsolete local-storage environment variables fail closed", () => {
  for (const name of ["DATA_DIR", "RESTORE_LEGACY_SESSIONS"]) {
    const result = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", 'import("./src/config.js")'],
      {
        cwd: ROOT,
        env: {
          ...process.env,
          DATA_DIR: "",
          RESTORE_LEGACY_SESSIONS: "",
          [name]: name === "DATA_DIR" ? "/data" : "true",
        },
        encoding: "utf8",
      }
    );

    assert.notEqual(result.status, 0, `${name} must reject startup`);
    assert.match(
      `${result.stderr}\n${result.stdout}`,
      /Obsolete local WhatsApp storage configuration detected/
    );
  }
});
