import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

async function writeModule(directory, fileName, content) {
  const filePath = path.join(directory, fileName);
  await fs.writeFile(filePath, content, "utf8");
  return filePath;
}

function replaceImportSpecifier(source, from, to) {
  const quotedFrom = from.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`([\"'])${quotedFrom}\\1`, "g");
  return source.replace(pattern, `"${to}"`);
}

export async function createWhatsappHarnessFromSource({
  source: sourceInput,
  tempRoot,
  cleanup = async () => {},
}) {
  const srcDir = path.join(tempRoot, "src");
  const stubDir = path.join(srcDir, "__stubs__");
  const dataDir = path.join(tempRoot, "data");
  await fs.mkdir(stubDir, { recursive: true });

  await writeModule(
    stubDir,
    "config.mjs",
    `export const DATA_DIR = ${JSON.stringify(dataDir)};\n` +
      `export const N8N_FORWARD_MEDIA_WITHOUT_TEXT = false;\n` +
      `export const N8N_FORWARD_FROM_ME = false;\n` +
      `export const N8N_FORWARD_SESSION_EVENTS = false;\n` +
      `export const N8N_WEBHOOK_URL = \"\";\n` +
      `export const RESTORE_LEGACY_SESSIONS = false;\n` +
      `export const SESSION_POLICY_CACHE_MS = 1000;\n`
  );

  await writeModule(
    stubDir,
    "utils.mjs",
    `export function phoneDigits(value) { return String(value || \"\").replace(/\\D/g, \"\"); }\n` +
      `export function toFrontendWhatsappStatus(value) { return value; }\n` +
      `export function isoFromWhatsappTimestamp(value) { return new Date(Number(value || Date.now())).toISOString(); }\n`
  );

  await writeModule(
    stubDir,
    "supabase.mjs",
    `export function isSupabaseConfigured() { return true; }\n`
  );

  await writeModule(
    stubDir,
    "systemLog.mjs",
    `const entries = [];\n` +
      `export async function writeSystemLog(entry) { entries.push(entry); return entry; }\n` +
      `export function __getSystemLogs() { return entries; }\n`
  );

  await writeModule(
    stubDir,
    "baileysRawLogger.mjs",
    `export function createBaileysRawLogger() {\n` +
      `  const logger = { level: \"debug\", trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {} };\n` +
      `  logger.child = () => logger;\n` +
      `  return logger;\n` +
      `}\n`
  );

  await writeModule(
    stubDir,
    "qrcode.mjs",
    `export default { async toDataURL(value) { return \`data:image/png;base64,\${String(value)}\`; } };\n`
  );

  await writeModule(
    stubDir,
    "boom.mjs",
    `export class Boom extends Error {\n` +
      `  constructor(message = \"Boom\", { statusCode = 500 } = {}) {\n` +
      `    super(message);\n` +
      `    this.output = { statusCode, payload: { message } };\n` +
      `  }\n` +
      `}\n`
  );

  await writeModule(
    stubDir,
    "repository.mjs",
    `const sessionsByUser = new Map();\n` +
      `const sessionsById = new Map();\n` +
      `function ensureRow(userId) {\n` +
      `  let row = sessionsByUser.get(userId);\n` +
      `  if (!row) {\n` +
      `    row = { id: \`session-\${userId}\`, user_id: userId, status: \"DISCONNECTED\", bot_mode: \"off\", whatsapp_phone: null, display_name: null, connected_at: null, last_seen_at: null };\n` +
      `    sessionsByUser.set(userId, row);\n` +
      `    sessionsById.set(row.id, row);\n` +
      `  }\n` +
      `  return row;\n` +
      `}\n` +
      `export const repository = {\n` +
      `  async ensureWhatsappSession(userId) { return ensureRow(userId); },\n` +
      `  async getUserRowById(userId) { return { id: userId, phone_e164: \"+37061234567\" }; },\n` +
      `  async getWhatsappSessionByUser(userId) { return sessionsByUser.get(userId) || null; },\n` +
      `  async getWhatsappSessionById(sessionId) { return sessionsById.get(sessionId) || null; },\n` +
      `  async listWhatsappSessions() { return Array.from(sessionsById.values()); },\n` +
      `  async updateWhatsappSessionById(sessionId, patch) { const row = sessionsById.get(sessionId); if (!row) return null; Object.assign(row, patch); return row; },\n` +
      `  async updateWhatsappSessionByUser(userId, patch) { const row = ensureRow(userId); Object.assign(row, patch); return row; },\n` +
      `  async addActivity() { return null; },\n` +
      `  async upsertChat() { return null; },\n` +
      `  async insertMessage() { return null; },\n` +
      `  async updateMessage() { return null; },\n` +
      `};\n` +
      `export function __setSessionStatus(userId, status) { const row = ensureRow(userId); row.status = status; return row; }\n` +
      `export function __getSessionRow(userId) { return ensureRow(userId); }\n`
  );

  await writeModule(
    stubDir,
    "baileys.mjs",
    `const sockets = [];\n` +
      `let queryHandler = async () => ({ tag: \"iq\", attrs: {}, content: [{ tag: \"link_code_companion_reg\", attrs: {}, content: [{ tag: \"link_code_pairing_ref\", attrs: {}, content: Buffer.from(\"ref\") }] }] });\n` +
      `class EventBus {\n` +
      `  constructor() { this.handlers = new Map(); }\n` +
      `  on(name, handler) { const list = this.handlers.get(name) || []; list.push(handler); this.handlers.set(name, list); return this; }\n` +
      `  async emit(name, ...args) { for (const handler of [...(this.handlers.get(name) || [])]) { await handler(...args); } }\n` +
      `}\n` +
      `export const DisconnectReason = { timedOut: 408, loggedOut: 401, connectionClosed: 428, restartRequired: 515 };\n` +
      `export const S_WHATSAPP_NET = \"s.whatsapp.net\";\n` +
      `export async function fetchLatestWaWebVersion() { return { version: [2, 3000, 1015901307] }; }\n` +
      `export async function useMultiFileAuthState() { return { state: { creds: { registered: false, pairingCode: undefined, pairingEphemeralKeyPair: { public: Buffer.from(\"ephemeral\") }, noiseKey: { public: Buffer.from(\"noise\") }, me: null } }, saveCreds: async () => {} }; }\n` +
      `export function bytesToCrockford() { return \"ABCDEFGH\"; }\n` +
      `export async function derivePairingCodeKey() { return Buffer.alloc(32, 1); }\n` +
      `export function aesEncryptCTR(value) { return Buffer.from(value || []); }\n` +
      `export function jidEncode(user, server) { return \`${"${user}"}@${"${server}"}\`; }\n` +
      `export function getBinaryNodeChild(node, tag) { return Array.isArray(node?.content) ? node.content.find((child) => child?.tag === tag) || null : null; }\n` +
      `export default function makeWASocket(options) {\n` +
      `  const ev = new EventBus();\n` +
      `  const ws = new EventBus();\n` +
      `  const socket = {\n` +
      `    ev, ws, authState: options.auth, user: null, queryCalls: 0, logoutCalls: 0, endCalls: 0,\n` +
      `    async query(node, timeoutMs) { this.queryCalls += 1; return queryHandler({ socket: this, node, timeoutMs }); },\n` +
      `    async logout() { this.logoutCalls += 1; },\n` +
      `    end() { this.endCalls += 1; },\n` +
      `    async sendMessage() { return { key: { id: \"message-id\" } }; },\n` +
      `    async groupMetadata() { return { subject: \"Group\" }; },\n` +
      `  };\n` +
      `  sockets.push(socket);\n` +
      `  setTimeout(() => { void ev.emit(\"connection.update\", { qr: \`qr-\${sockets.length}\` }); }, 0);\n` +
      `  return socket;\n` +
      `}\n` +
      `export function __getSockets() { return sockets; }\n` +
      `export function __setQueryHandler(handler) { queryHandler = handler; }\n` +
      `export function __defaultPairingResponse() { return { tag: \"iq\", attrs: {}, content: [{ tag: \"link_code_companion_reg\", attrs: {}, content: [{ tag: \"link_code_pairing_ref\", attrs: {}, content: Buffer.from(\"ref\") }] }] }; }\n`
  );

  let source = sourceInput;
  const replacements = [
    ["qrcode", "./__stubs__/qrcode.mjs"],
    ["@hapi/boom", "./__stubs__/boom.mjs"],
    ["@whiskeysockets/baileys", "./__stubs__/baileys.mjs"],
    ["./config.js", "./__stubs__/config.mjs"],
    ["./repository.js", "./__stubs__/repository.mjs"],
    ["./systemLog.js", "./__stubs__/systemLog.mjs"],
    ["./supabase.js", "./__stubs__/supabase.mjs"],
    ["./utils.js", "./__stubs__/utils.mjs"],
    ["./whatsapp/logging/baileysLogger.js", "./__stubs__/baileysRawLogger.mjs"],
    ["./baileysRawLogger.js", "./__stubs__/baileysRawLogger.mjs"],
  ];

  for (const [from, to] of replacements) {
    source = replaceImportSpecifier(source, from, to);
  }

  source += `\nexport const __characterization = { sessions, managedPairingFlows };\n`;
  const modulePath = path.join(srcDir, "whatsapp.characterization.mjs");
  await fs.writeFile(modulePath, source, "utf8");

  const [whatsapp, baileys, repositoryStub] = await Promise.all([
    import(pathToFileURL(modulePath).href),
    import(pathToFileURL(path.join(stubDir, "baileys.mjs")).href),
    import(pathToFileURL(path.join(stubDir, "repository.mjs")).href),
  ]);

  return {
    whatsapp,
    baileys,
    repositoryStub,
    cleanup,
  };
}
