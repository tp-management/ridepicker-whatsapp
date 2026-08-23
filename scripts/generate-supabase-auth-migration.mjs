import fs from "node:fs/promises";

function replaceRequired(source, from, to, label) {
  if (!source.includes(from)) {
    throw new Error(`Missing expected source block: ${label}`);
  }
  return source.replace(from, to);
}

function replaceRegexRequired(source, pattern, to, label) {
  if (!pattern.test(source)) {
    throw new Error(`Missing expected source pattern: ${label}`);
  }
  pattern.lastIndex = 0;
  return source.replace(pattern, to);
}

async function patchWhatsapp() {
  const path = "src/whatsapp.js";
  let source = await fs.readFile(path, "utf8");

  source = replaceRequired(
    source,
    "  N8N_WEBHOOK_URL,\n  RESTORE_LEGACY_SESSIONS,\n  SESSION_POLICY_CACHE_MS,",
    "  N8N_WEBHOOK_URL,\n  SESSION_POLICY_CACHE_MS,",
    "remove legacy filesystem restore config import"
  );

  source = replaceRequired(
    source,
    `import {\n  ensureFileAuthRoot,\n  loadFileAuthState,\n} from \"./whatsapp/auth/fileAuthStore.js\";\nimport { removeAuthDirectory } from \"./whatsapp/auth/authCleanup.js\";`,
    `import {\n  clearSupabaseAuthState,\n  hasSupabaseAuthState,\n  loadSupabaseAuthState,\n} from \"./whatsapp/auth/supabaseAuthStore.js\";`,
    "replace filesystem auth imports"
  );

  source = replaceRequired(
    source,
    "\nensureFileAuthRoot();\n",
    "\n",
    "remove filesystem auth root initialization"
  );

  source = source.replaceAll("loadFileAuthState(", "loadSupabaseAuthState(");

  source = replaceRequired(
    source,
    `  if (removeAuth) {\n    removeAuthDirectory(session.id);\n  }`,
    `  if (removeAuth) {\n    void clearSupabaseAuthState(session.id).catch((error) => {\n      console.warn(\n        \`[\${session.id}] could not clear Supabase auth state:\`,\n        error.message\n      );\n    });\n  }`,
    "queue auth clear when dropping a socket"
  );

  source = replaceRequired(
    source,
    "  // A terminal/exhausted previous attempt must start with a completely fresh\n  // auth directory. A registered CONNECTED session is handled above and is\n  // never deleted here.",
    "  // A terminal/exhausted previous attempt must start with completely fresh\n  // Supabase auth state. A registered CONNECTED session is handled above and\n  // is never deleted here.",
    "fresh pairing auth comment"
  );

  source = replaceRequired(
    source,
    `      } else {\n        removeAuthDirectory(dbSession.id);\n      }`,
    `      } else {\n        await clearSupabaseAuthState(dbSession.id);\n      }`,
    "clear stale managed pairing auth"
  );

  source = replaceRequired(
    source,
    `    if (dbSession.status === \"LOGGED_OUT\") {\n      removeAuthDirectory(dbSession.id);\n    }`,
    `    if (dbSession.status === \"LOGGED_OUT\") {\n      await clearSupabaseAuthState(dbSession.id);\n    }`,
    "clear logged out QR auth"
  );

  source = replaceRequired(
    source,
    `      sessions.delete(sessionId);\n      removeAuthDirectory(sessionId);\n      return;`,
    `      sessions.delete(sessionId);\n      await clearSupabaseAuthState(sessionId);\n      return;`,
    "clear auth after remote logout"
  );

  source = replaceRequired(
    source,
    `\n  removeAuthDirectory(sessionId);\n}\n\nexport async function disconnectManagedSession`,
    `\n  await clearSupabaseAuthState(sessionId);\n}\n\nexport async function disconnectManagedSession`,
    "clear auth after disconnect"
  );

  const restoreStart = source.indexOf("\nasync function restoreManagedSessions() {");
  if (restoreStart < 0) {
    throw new Error("Missing restoreManagedSessions tail");
  }

  source =
    source.slice(0, restoreStart) +
    `\nasync function restoreManagedSessions() {\n` +
    `  if (!isSupabaseConfigured()) {\n` +
    `    return false;\n` +
    `  }\n\n` +
    `  const dbSessions = await repository.listWhatsappSessions();\n\n` +
    `  for (const dbSession of dbSessions) {\n` +
    `    const terminal = [\"LOGGED_OUT\", \"DISCONNECTED\"].includes(\n` +
    `      dbSession.status\n` +
    `    );\n\n` +
    `    if (terminal) {\n` +
    `      if (await hasSupabaseAuthState(dbSession.id)) {\n` +
    `        await clearSupabaseAuthState(dbSession.id);\n` +
    `      }\n` +
    `      continue;\n` +
    `    }\n\n` +
    `    const hasAuthState = await hasSupabaseAuthState(dbSession.id);\n\n` +
    `    if (!hasAuthState) {\n` +
    `      void writeSystemLog({\n` +
    `        userId: dbSession.user_id,\n` +
    `        sessionId: dbSession.id,\n` +
    `        level: \"warning\",\n` +
    `        source: \"whatsapp\",\n` +
    `        event: \"auth_state_missing\",\n` +
    `        message: \"WhatsApp auth state is missing from Supabase during restore\",\n` +
    `        details: { previousStatus: dbSession.status },\n` +
    `      });\n\n` +
    `      await repository.updateWhatsappSessionById(dbSession.id, {\n` +
    `        status: \"DISCONNECTED\",\n` +
    `        bot_mode: \"off\",\n` +
    `      });\n\n` +
    `      await addSessionActivity(\n` +
    `        { id: dbSession.id, userId: dbSession.user_id },\n` +
    `        \"WhatsApp disconnected\",\n` +
    `        \"Connection credentials were unavailable after backend restart.\"\n` +
    `      );\n` +
    `      continue;\n` +
    `    }\n\n` +
    `    // Pairing codes and their timers are process-local. Never revive a\n` +
    `    // half-finished pairing attempt after restart, even though its partial\n` +
    `    // cryptographic state is safely stored in Supabase.\n` +
    `    if ([\"STARTING\", \"QR\", \"ERROR\"].includes(dbSession.status)) {\n` +
    `      await clearSupabaseAuthState(dbSession.id);\n\n` +
    `      await repository.updateWhatsappSessionById(dbSession.id, {\n` +
    `        status: \"DISCONNECTED\",\n` +
    `        bot_mode: \"off\",\n` +
    `      });\n\n` +
    `      void writeSystemLog({\n` +
    `        userId: dbSession.user_id,\n` +
    `        sessionId: dbSession.id,\n` +
    `        level: \"info\",\n` +
    `        source: \"whatsapp\",\n` +
    `        event: \"pairing_reset_after_restart\",\n` +
    `        message: \"Incomplete WhatsApp pairing was reset after process restart\",\n` +
    `        details: { previousStatus: dbSession.status },\n` +
    `      });\n\n` +
    `      await addSessionActivity(\n` +
    `        { id: dbSession.id, userId: dbSession.user_id },\n` +
    `        \"WhatsApp disconnected\",\n` +
    `        \"Incomplete WhatsApp connection was reset after backend restart.\"\n` +
    `      );\n` +
    `      continue;\n` +
    `    }\n\n` +
    `    console.log(\`Restoring managed session: \${dbSession.id}\`);\n` +
    `    void writeSystemLog({\n` +
    `      userId: dbSession.user_id,\n` +
    `      sessionId: dbSession.id,\n` +
    `      level: \"info\",\n` +
    `      source: \"whatsapp\",\n` +
    `      event: \"session_restore_started\",\n` +
    `      message: \"Restoring managed WhatsApp session from Supabase auth state\",\n` +
    `      details: { previousStatus: dbSession.status },\n` +
    `    });\n\n` +
    `    try {\n` +
    `      await startSession(dbSession.id, {\n` +
    `        userId: dbSession.user_id,\n` +
    `      });\n` +
    `    } catch (error) {\n` +
    `      console.error(\n` +
    `        \`Failed restoring managed session \${dbSession.id}:\`,\n` +
    `        error\n` +
    `      );\n` +
    `      void writeSystemLog({\n` +
    `        userId: dbSession.user_id,\n` +
    `        sessionId: dbSession.id,\n` +
    `        level: \"error\",\n` +
    `        source: \"whatsapp\",\n` +
    `        event: \"session_restore_failed\",\n` +
    `        message: error.message,\n` +
    `        details: { error },\n` +
    `      });\n` +
    `    }\n` +
    `  }\n\n` +
    `  return true;\n` +
    `}\n\n` +
    `export async function restoreSessions() {\n` +
    `  try {\n` +
    `    await restoreManagedSessions();\n` +
    `  } catch (error) {\n` +
    `    console.error(\"Managed session restore failed:\", error.message);\n` +
    `  }\n` +
    `}\n`;

  for (const forbidden of [
    "fileAuthStore",
    "authCleanup",
    "ensureFileAuthRoot",
    "loadFileAuthState",
    "removeAuthDirectory",
    "authPathFor",
    "fs.existsSync",
    "fs.readdirSync",
    "DATA_DIR",
    "useMultiFileAuthState",
  ]) {
    if (source.includes(forbidden)) {
      throw new Error(`Filesystem auth token survived in whatsapp.js: ${forbidden}`);
    }
  }

  await fs.writeFile(path, source, "utf8");
}

async function patchHarness() {
  const path = "test/helpers/createWhatsappHarness.js";
  let source = await fs.readFile(path, "utf8");

  source = source.replace(
    `  const dataDir = path.join(tempRoot, \"data\");\n`,
    ""
  );
  source = source.replace(
    `    \`export const DATA_DIR = \${JSON.stringify(dataDir)};\\n\` +\n`,
    ""
  );
  source = source.replace(
    `      \`export const RESTORE_LEGACY_SESSIONS = false;\\n\` +\n`,
    ""
  );

  source = replaceRegexRequired(
    source,
    /  await writeModule\(\n    stubDir,\n    "fileAuthStore\.mjs",[\s\S]*?\n  \);\n\n  await writeModule\(\n    stubDir,\n    "authCleanup\.mjs",[\s\S]*?\n  \);\n/,
    `  await writeModule(\n` +
      `    stubDir,\n` +
      `    \"supabaseAuthStore.mjs\",\n` +
      `    \`const states = new Map();\\n\` +\n` +
      `      \`function freshState() {\\n\` +\n` +
      `      \`  const values = new Map();\\n\` +\n` +
      `      \`  return {\\n\` +\n` +
      `      \`    creds: { registered: false, pairingCode: undefined, pairingEphemeralKeyPair: { public: Buffer.from(\\\"ephemeral\\\") }, noiseKey: { public: Buffer.from(\\\"noise\\\") }, me: null },\\n\` +\n` +
      `      \`    keys: {\\n\` +\n` +
      `      \`      async get(type, ids) { const result = {}; for (const id of ids) result[id] = values.get(\\\`\\\${type}:\\\${id}\\\`) ?? null; return result; },\\n\` +\n` +
      `      \`      async set(data) { for (const type of Object.keys(data || {})) { for (const id of Object.keys(data[type] || {})) { const value = data[type][id]; const key = \\\`\\\${type}:\\\${id}\\\`; if (value == null) values.delete(key); else values.set(key, value); } } },\\n\` +\n` +
      `      \`    },\\n\` +\n` +
      `      \`  };\\n\` +\n` +
      `      \`}\\n\` +\n` +
      `      \`export async function loadSupabaseAuthState(sessionId) { let state = states.get(sessionId); if (!state) { state = freshState(); states.set(sessionId, state); } return { state, saveCreds: async () => {} }; }\\n\` +\n` +
      `      \`export async function clearSupabaseAuthState(sessionId) { states.delete(sessionId); }\\n\` +\n` +
      `      \`export async function hasSupabaseAuthState(sessionId) { return states.has(sessionId); }\\n\`\n` +
      `  );\n`,
    "replace auth harness stubs"
  );

  source = replaceRequired(
    source,
    `    [\"./whatsapp/auth/fileAuthStore.js\", \"./__stubs__/fileAuthStore.mjs\"],\n    [\"./whatsapp/auth/authCleanup.js\", \"./__stubs__/authCleanup.mjs\"],`,
    `    [\"./whatsapp/auth/supabaseAuthStore.js\", \"./__stubs__/supabaseAuthStore.mjs\"],`,
    "replace auth harness import mapping"
  );

  source = replaceRequired(
    source,
    `    \`const sessionsByUser = new Map();\\n\` +\n      \`const sessionsById = new Map();\\n\` +`,
    `    \`const sessionsByUser = new Map();\\n\` +\n      \`const sessionsById = new Map();\\n\` +\n      \`const activities = [];\\n\` +`,
    "capture activity rows in harness"
  );

  source = replaceRequired(
    source,
    `      \`  async addActivity() { return null; },\\n\` +`,
    `      \`  async addActivity(userId, entry) { const row = { userId, ...entry }; activities.push(row); return row; },\\n\` +`,
    "record activity rows in harness"
  );

  source = replaceRequired(
    source,
    `      \`export function __getSessionRow(userId) { return ensureRow(userId); }\\n\`\n`,
    `      \`export function __getSessionRow(userId) { return ensureRow(userId); }\\n\` +\n      \`export function __getActivities() { return activities; }\\n\`\n`,
    "expose harness activities"
  );

  await fs.writeFile(path, source, "utf8");
}

async function patchCharacterization() {
  const path = "test/whatsappCharacterization.test.js";
  let source = await fs.readFile(path, "utf8");

  source = replaceRequired(
    source,
    `  assert.equal(session.status, \"RECONNECTING\");\n  assert.ok(session.reconnectTimer, \"expected lifecycle reconnect timer\");\n});`,
    `  assert.equal(session.status, \"RECONNECTING\");\n  assert.ok(session.reconnectTimer, \"expected lifecycle reconnect timer\");\n\n  await waitFor(() => harness.baileys.__getSockets().length === 2);\n  const replacementSocket = harness.baileys.__getSockets()[1];\n  const replacementSession =\n    harness.whatsapp.__characterization.sessions.get(\"session-restart-515\");\n\n  assert.notEqual(replacementSocket, socket);\n  assert.ok(replacementSession, \"expected replacement session\");\n  assert.notEqual(replacementSession, session);\n  assert.equal(replacementSession.registered, true);\n  assert.equal(replacementSocket.authState.creds.registered, true);\n  assert.equal(\n    replacementSocket.authState.creds.me?.id,\n    socket.authState.creds.me?.id\n  );\n});`,
    "strengthen 515 restart characterization"
  );

  source += `\n` +
    `test(\"restore without Supabase auth records an infrastructure disconnect\", async (t) => {\n` +
    `  const harness = await useHarness(t);\n` +
    `  const userId = \"restore-missing-auth\";\n` +
    `  await harness.repositoryStub.repository.ensureWhatsappSession(userId);\n` +
    `  harness.repositoryStub.__setSessionStatus(userId, \"CONNECTED\");\n\n` +
    `  await harness.whatsapp.restoreSessions();\n\n` +
    `  assert.equal(harness.repositoryStub.__getSessionRow(userId).status, \"DISCONNECTED\");\n` +
    `  assert.ok(\n` +
    `    harness.repositoryStub.__getActivities().some(\n` +
    `      (entry) =>\n` +
    `        entry.userId === userId &&\n` +
    `        entry.type === \"whatsapp\" &&\n` +
    `        entry.title === \"WhatsApp disconnected\"\n` +
    `    ),\n` +
    `    \"expected restore disconnect to be visible in Activity\"\n` +
    `  );\n` +
    `});\n`;

  await fs.writeFile(path, source, "utf8");
}

async function patchConfigAndPackage() {
  let config = await fs.readFile("src/config.js", "utf8");
  config = replaceRequired(
    config,
    `\nexport const DATA_DIR = process.env.DATA_DIR || \"./data\";\n`,
    "\n",
    "remove DATA_DIR config"
  );
  config = replaceRegexRequired(
    config,
    /\nexport const RESTORE_LEGACY_SESSIONS = parseBoolean\(\n  process\.env\.RESTORE_LEGACY_SESSIONS,\n  false\n\);\n/,
    "\n",
    "remove legacy restore config"
  );
  await fs.writeFile("src/config.js", config, "utf8");

  let env = await fs.readFile(".env.example", "utf8");
  env = env.replace("DATA_DIR=./data\n", "");
  env = env.replace("RESTORE_LEGACY_SESSIONS=false\n", "");
  await fs.writeFile(".env.example", env, "utf8");

  const pkg = JSON.parse(await fs.readFile("package.json", "utf8"));
  pkg.scripts.check =
    "node --check index.js && node --check src/app.js && node --check src/config.js && node --check src/routes.js && node --check src/whatsapp.js && node --check src/repository.js && node --check src/supabase.js && node --check src/utils.js && node --check src/baileysRawLogger.js && node --check src/whatsapp/logging/baileysLogger.js && node --check src/whatsapp/auth/supabaseAuthStore.js";
  delete pkg.nodemonConfig;
  await fs.writeFile("package.json", `${JSON.stringify(pkg, null, 2)}\n`, "utf8");
}

await patchWhatsapp();
await patchHarness();
await patchCharacterization();
await patchConfigAndPackage();

await fs.rm("src/whatsapp/auth/fileAuthStore.js", { force: true });
await fs.rm("src/whatsapp/auth/authCleanup.js", { force: true });

console.log("Generated Supabase-only WhatsApp auth migration.");
