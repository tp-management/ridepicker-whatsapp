import fs from "fs";
import path from "path";
import QRCode from "qrcode";
import { Boom } from "@hapi/boom";

import makeWASocket, {
  DisconnectReason,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";

import {
  DATA_DIR,
  N8N_FORWARD_MEDIA_WITHOUT_TEXT,
  N8N_FORWARD_SESSION_EVENTS,
  N8N_WEBHOOK_URL,
  RESTORE_LEGACY_SESSIONS,
  SESSION_POLICY_CACHE_MS,
} from "./config.js";
import { repository } from "./repository.js";
import { isSupabaseConfigured } from "./supabase.js";
import {
  isoFromWhatsappTimestamp,
  phoneDigits,
  toFrontendWhatsappStatus,
} from "./utils.js";

fs.mkdirSync(DATA_DIR, {
  recursive: true,
});

const sessions = new Map();
const groupNameCache = new Map();
const policyCache = new Map();
const chatWriteCache = new Map();

const GROUP_CACHE_TTL = 10 * 60 * 1000;
const CHAT_WRITE_TTL = 10 * 60 * 1000;
const PAIRING_CODE_DISPLAY_TTL = 5 * 60 * 1000;

const TRACKABLE_MESSAGE_TYPES = new Set([
  "text",
  "image",
  "video",
  "audio",
  "document",
  "sticker",
  "location",
  "contact",
]);

function authPathFor(sessionId) {
  return path.join(DATA_DIR, sessionId);
}

function removeAuthDirectory(sessionId) {
  const authPath = authPathFor(sessionId);

  try {
    fs.rmSync(authPath, {
      recursive: true,
      force: true,
    });
  } catch (error) {
    console.warn(
      `[${sessionId}] could not remove auth directory:`,
      error.message
    );
  }
}

function socketAccount(socket) {
  const jid = socket?.user?.id || null;
  const rawUser = jid ? jid.split("@")[0].split(":")[0] : null;
  const phone = rawUser && /^\d+$/.test(rawUser) ? `+${rawUser}` : null;

  return {
    name: socket?.user?.name || null,
    phone,
  };
}

function clearReconnectTimer(session) {
  if (session?.reconnectTimer) {
    clearTimeout(session.reconnectTimer);
    session.reconnectTimer = null;
  }
}

function clearPolicyCache(sessionId) {
  policyCache.delete(sessionId);
}

export function updatePolicyCache(sessionRow) {
  if (!sessionRow?.id) return;

  policyCache.set(sessionRow.id, {
    expiresAt: Date.now() + SESSION_POLICY_CACHE_MS,
    row: sessionRow,
  });
}

async function getTrackingPolicy(sessionId) {
  const cached = policyCache.get(sessionId);

  if (cached && cached.expiresAt > Date.now()) {
    return cached.row;
  }

  if (!isSupabaseConfigured()) {
    return null;
  }

  const row = await repository.getWhatsappSessionById(sessionId);

  if (row) {
    updatePolicyCache(row);
  }

  return row;
}

async function getGroupName(socket, chatId) {
  const cached = groupNameCache.get(chatId);

  if (cached && Date.now() < cached.expiresAt) {
    return cached.name;
  }

  try {
    const metadata = await socket.groupMetadata(chatId);
    const name = metadata?.subject || null;

    groupNameCache.set(chatId, {
      name,
      expiresAt: Date.now() + GROUP_CACHE_TTL,
    });

    return name;
  } catch (error) {
    console.error(
      `[group] Could not get name for ${chatId}:`,
      error.message
    );

    return null;
  }
}

function getTextFromMessage(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    message?.documentMessage?.caption ||
    ""
  );
}

function getMessageType(message) {
  if (!message) return "unknown";

  if (message.conversation || message.extendedTextMessage) return "text";
  if (message.imageMessage) return "image";
  if (message.videoMessage) return "video";
  if (message.audioMessage) return "audio";
  if (message.documentMessage) return "document";
  if (message.stickerMessage) return "sticker";
  if (message.locationMessage) return "location";
  if (message.contactMessage) return "contact";
  if (message.reactionMessage) return "reaction";

  return Object.keys(message)[0] || "unknown";
}

function getMediaInfo(message) {
  const media =
    message?.imageMessage ||
    message?.videoMessage ||
    message?.audioMessage ||
    message?.documentMessage ||
    message?.stickerMessage ||
    null;

  if (!media) return null;

  return {
    mimetype: media.mimetype || null,
    fileName: media.fileName || null,
    fileLength:
      media.fileLength?.toString?.() ||
      media.fileLength ||
      null,
    caption: media.caption || null,
    seconds: media.seconds || null,
  };
}

async function sendToN8n(event) {
  if (!N8N_WEBHOOK_URL) {
    return false;
  }

  try {
    const response = await fetch(N8N_WEBHOOK_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify(event),
    });

    if (!response.ok) {
      const body = await response.text();
      console.error(`[n8n] ${response.status}:`, body);
      return false;
    }

    console.log(`[n8n] delivered: ${event.event}`);
    return true;
  } catch (error) {
    console.error("[n8n] webhook error:", error.message);
    return false;
  }
}

async function forwardSessionEvent(event) {
  if (!N8N_FORWARD_SESSION_EVENTS) {
    return false;
  }

  return sendToN8n(event);
}

async function persistSessionState(session, patch) {
  if (!session?.userId || !isSupabaseConfigured()) {
    return null;
  }

  try {
    const updated = await repository.updateWhatsappSessionById(
      session.id,
      patch
    );

    if (updated) {
      updatePolicyCache(updated);
    }

    return updated;
  } catch (error) {
    console.error(
      `[${session.id}] Supabase session update failed:`,
      error.message
    );
    return null;
  }
}

async function addSessionActivity(session, title, detail = "") {
  if (!session?.userId || !isSupabaseConfigured()) {
    return;
  }

  try {
    await repository.addActivity(session.userId, {
      type: "whatsapp",
      title,
      detail,
    });
  } catch (error) {
    console.error(
      `[${session.id}] activity write failed:`,
      error.message
    );
  }
}

async function maybeUpsertChat({
  sessionId,
  chatId,
  isGroup,
  chatName,
  messageTimestamp,
}) {
  if (!isSupabaseConfigured()) return;

  const cacheKey = `${sessionId}:${chatId}:${chatName || ""}`;
  const cachedUntil = chatWriteCache.get(cacheKey);

  if (cachedUntil && cachedUntil > Date.now()) {
    return;
  }

  chatWriteCache.set(cacheKey, Date.now() + CHAT_WRITE_TTL);

  try {
    await repository.upsertChat({
      sessionId,
      chatId,
      chatType: isGroup ? "group" : "private",
      name: chatName,
      lastMessageAt: messageTimestamp,
    });
  } catch (error) {
    chatWriteCache.delete(cacheKey);
    console.error(
      `[${sessionId}] chat metadata write failed:`,
      error.message
    );
  }
}

async function processMessage(session, socket, message) {
  const chatId = message?.key?.remoteJid;
  const whatsappMessageId = message?.key?.id;

  if (!chatId || !whatsappMessageId || !message?.message) {
    return;
  }

  const messageType = getMessageType(message.message);

  if (!TRACKABLE_MESSAGE_TYPES.has(messageType)) {
    return;
  }

  const policy = await getTrackingPolicy(session.id);

  // Legacy/unmanaged sessions and RidePicker OFF never enter the DB or n8n.
  if (!policy || policy.bot_mode === "off") {
    return;
  }

  const messageTimestamp = isoFromWhatsappTimestamp(
    message.messageTimestamp
  );

  if (
    policy.bot_enabled_at &&
    new Date(messageTimestamp).getTime() <
      new Date(policy.bot_enabled_at).getTime()
  ) {
    return;
  }

  const fromMe = Boolean(message.key.fromMe);
  const isGroup = chatId.endsWith("@g.us");
  const participant = message.key.participant || null;
  const participantAlt = message.key.participantAlt || null;
  const sender = participantAlt || participant || chatId;
  const senderName = message.pushName || null;
  const body = getTextFromMessage(message.message);
  const media = getMediaInfo(message.message);

  let chatName = null;

  if (isGroup) {
    chatName = await getGroupName(socket, chatId);
  } else if (!fromMe) {
    chatName = senderName;
  }

  let inserted = null;

  try {
    inserted = await repository.insertMessage({
      session_id: session.id,
      whatsapp_message_id: whatsappMessageId,
      chat_id: chatId,
      chat_name: chatName,
      sender_id: sender,
      sender_name: senderName,
      body: body || null,
      is_group: isGroup,
      from_me: fromMe,
      message_type: messageType,
      has_media: Boolean(media),
      media,
      message_timestamp: messageTimestamp,
      processing_status: fromMe ? "ignored" : "new",
    });
  } catch (error) {
    // The DB trigger is our second line of defence against OFF/history messages.
    console.error(
      `[${session.id}] message insert rejected:`,
      error.message
    );
    return;
  }

  // Ignore duplicates. PostgREST returns no inserted row when
  // resolution=ignore-duplicates matched the unique constraint.
  if (!inserted) {
    return;
  }

  maybeUpsertChat({
    sessionId: session.id,
    chatId,
    isGroup,
    chatName,
    messageTimestamp,
  });

  console.log(
    `[${session.id}]`,
    fromMe ? "ME" : senderName || sender,
    "→",
    chatName || chatId,
    ":",
    body || `[${messageType}]`
  );

  // Outgoing messages are useful conversation context, but they do NOT create
  // n8n executions. This also prevents the bot from replying to itself.
  if (fromMe) {
    return;
  }

  const hasText = Boolean(String(body || "").trim());

  if (!hasText && !N8N_FORWARD_MEDIA_WITHOUT_TEXT) {
    await repository.updateMessage(inserted.id, {
      processing_status: "ignored",
    });
    return;
  }

  const event = {
    event: "message.received",
    userId: policy.user_id,
    session: session.id,
    timestamp: Date.now(),
    payload: {
      id: whatsappMessageId,
      dbMessageId: inserted.id,
      chatId,
      chatName,
      isGroup,
      sender,
      senderName,
      participant,
      participantAlt,
      fromMe: false,
      body,
      type: messageType,
      hasMedia: Boolean(media),
      media,
      messageTimestamp,
    },
  };

  const delivered = await sendToN8n(event);

  if (delivered) {
    await repository.updateMessage(inserted.id, {
      processing_status: "sent_to_ai",
      forwarded_to_n8n_at: new Date().toISOString(),
    });
  }
}

export function getSession(id) {
  return sessions.get(id);
}

export function getSessions() {
  return Array.from(sessions.entries()).map(([id, session]) => ({
    id,
    userId: session.userId || null,
    status: session.status,
    pairingCode: session.pairingCode || null,
  }));
}

export async function startSession(
  id,
  { userId = null } = {}
) {
  const existing = sessions.get(id);

  if (existing?.socket) {
    if (userId && !existing.userId) {
      existing.userId = userId;
    }
    return existing;
  }

  const authPath = authPathFor(id);
  const { state, saveCreds } = await useMultiFileAuthState(authPath);

  const session = {
    id,
    userId,
    socket: null,
    qr: null,
    qrIssuedAt: null,
    pairingCode: null,
    pairingCodeIssuedAt: null,
    pairingPhone: null,
    status: "STARTING",
    registered: Boolean(state?.creds?.registered),
    reconnectTimer: null,
  };

  sessions.set(id, session);

  // IMPORTANT: keep the known-good socket configuration intentionally small.
  // Pairing-code support is added via socket.requestPairingCode() and does not
  // change the makeWASocket options that already worked for QR pairing.
  const socket = makeWASocket({
    auth: state,
    markOnlineOnConnect: false,
    printQRInTerminal: false,
  });

  session.socket = socket;

  socket.ev.on("creds.update", async () => {
    await saveCreds();
    session.registered = Boolean(state?.creds?.registered);
  });

  socket.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;

    if (qr) {
      session.qr = await QRCode.toDataURL(qr);
      session.qrIssuedAt = new Date().toISOString();
      session.status = "QR";

      console.log(`[${id}] QR ready`);

      await persistSessionState(session, {
        status: "QR",
      });
    }

    if (connection === "open") {
      clearReconnectTimer(session);
      session.qr = null;
      session.qrIssuedAt = null;
      session.pairingCode = null;
      session.pairingCodeIssuedAt = null;
      session.status = "CONNECTED";
      session.registered = true;

      const account = socketAccount(socket);
      const connectedAt = new Date().toISOString();

      console.log(`[${id}] WhatsApp connected`);

      await persistSessionState(session, {
        status: "CONNECTED",
        whatsapp_phone: account.phone,
        display_name: account.name,
        connected_at: connectedAt,
        last_seen_at: connectedAt,
      });

      await addSessionActivity(
        session,
        "WhatsApp connected",
        account.phone || ""
      );

      await forwardSessionEvent({
        event: "session.connected",
        session: id,
        userId: session.userId,
        timestamp: Date.now(),
      });
    }

    if (connection === "close") {
      const statusCode =
        lastDisconnect?.error instanceof Boom
          ? lastDisconnect.error.output.statusCode
          : lastDisconnect?.error?.output?.statusCode;

      session.socket = null;

      if (statusCode === DisconnectReason.loggedOut) {
        clearReconnectTimer(session);
        session.status = "LOGGED_OUT";
        session.qr = null;
        session.pairingCode = null;

        console.log(`[${id}] WhatsApp logged out`);

        await persistSessionState(session, {
          status: "LOGGED_OUT",
          bot_mode: "off",
          whatsapp_phone: null,
          display_name: null,
          connected_at: null,
        });

        await addSessionActivity(session, "WhatsApp disconnected", "");

        await forwardSessionEvent({
          event: "session.logged_out",
          session: id,
          userId: session.userId,
          timestamp: Date.now(),
        });

        return;
      }

      session.status = "RECONNECTING";
      console.log(`[${id}] reconnecting...`);

      // Do NOT change bot_mode here. Assist remains enabled and resumes when
      // WhatsApp comes back.
      await persistSessionState(session, {
        status: "RECONNECTING",
      });

      await forwardSessionEvent({
        event: "session.reconnecting",
        session: id,
        userId: session.userId,
        timestamp: Date.now(),
      });

      if (!session.reconnectTimer) {
        session.reconnectTimer = setTimeout(async () => {
          session.reconnectTimer = null;
          sessions.delete(id);

          try {
            await startSession(id, {
              userId: session.userId,
            });
          } catch (error) {
            console.error(`[${id}] reconnect failed:`, error);

            await persistSessionState(session, {
              status: "ERROR",
            });
          }
        }, 2000);
      }
    }
  });

  socket.ev.on("messages.upsert", async ({ messages, type }) => {
    if (type !== "notify") {
      return;
    }

    for (const message of messages) {
      try {
        await processMessage(session, socket, message);
      } catch (error) {
        console.error(
          `[${id}] message processing failed:`,
          error.message
        );
      }
    }
  });

  await persistSessionState(session, {
    status: "STARTING",
  });

  return session;
}

export async function requestPairingCode({
  sessionId,
  userId = null,
  phone,
}) {
  const session = await startSession(sessionId, {
    userId,
  });

  if (session.registered) {
    const error = new Error(
      "WhatsApp session is already registered. Disconnect it before requesting a new pairing code."
    );
    error.status = 409;
    throw error;
  }

  if (!session.socket?.requestPairingCode) {
    const error = new Error(
      "This Baileys build does not support pairing codes."
    );
    error.status = 501;
    throw error;
  }

  const digits = phoneDigits(phone);
  const code = await session.socket.requestPairingCode(digits);

  session.pairingCode = code;
  session.pairingCodeIssuedAt = new Date().toISOString();
  session.pairingPhone = `+${digits}`;

  console.log(`[${sessionId}] pairing code ready`);

  await persistSessionState(session, {
    status: "STARTING",
  });

  return {
    code,
    issuedAt: session.pairingCodeIssuedAt,
    phone: session.pairingPhone,
  };
}

export async function startManagedSession(
  userId,
  { method = "qr", phone = null } = {}
) {
  if (!isSupabaseConfigured()) {
    const error = new Error("Supabase is not configured");
    error.status = 503;
    throw error;
  }

  const user = await repository.getUserRowById(userId);

  if (!user) {
    const error = new Error("user not found");
    error.status = 404;
    throw error;
  }

  let dbSession = await repository.ensureWhatsappSession(userId);

  if (!dbSession) {
    throw new Error("Could not create WhatsApp session");
  }

  if (
    dbSession.status === "LOGGED_OUT" ||
    dbSession.status === "DISCONNECTED" ||
    dbSession.status === "ERROR"
  ) {
    const memorySession = sessions.get(dbSession.id);

    if (!memorySession?.socket && dbSession.status === "LOGGED_OUT") {
      removeAuthDirectory(dbSession.id);
    }
  }

  const session = await startSession(dbSession.id, {
    userId,
  });

  if (method === "pairing_code") {
    const pairingPhone = phone || user.phone_e164;

    await requestPairingCode({
      sessionId: dbSession.id,
      userId,
      phone: pairingPhone,
    });
  }

  dbSession = await repository.getWhatsappSessionByUser(userId);
  return normalizeManagedSession(dbSession, session);
}

export async function getManagedSession(userId) {
  if (!isSupabaseConfigured()) {
    const error = new Error("Supabase is not configured");
    error.status = 503;
    throw error;
  }

  const dbSession = await repository.getWhatsappSessionByUser(userId);

  if (!dbSession) {
    return null;
  }

  const memorySession = sessions.get(dbSession.id) || null;

  return normalizeManagedSession(dbSession, memorySession);
}

export async function refreshManagedSession(userId) {
  return getManagedSession(userId);
}

export async function requestManagedPairingCode(userId, phone = null) {
  const dbSession = await repository.ensureWhatsappSession(userId);
  const user = await repository.getUserRowById(userId);

  if (!user) {
    const error = new Error("user not found");
    error.status = 404;
    throw error;
  }

  const session = await startSession(dbSession.id, {
    userId,
  });

  const pairing = await requestPairingCode({
    sessionId: dbSession.id,
    userId,
    phone: phone || user.phone_e164,
  });

  const latest = await repository.getWhatsappSessionByUser(userId);
  return {
    ...normalizeManagedSession(latest, session),
    pairingCode: pairing,
  };
}

export async function refreshManagedQr(userId) {
  const dbSession = await repository.getWhatsappSessionByUser(userId);

  if (!dbSession) {
    return startManagedSession(userId, {
      method: "qr",
    });
  }

  let session = sessions.get(dbSession.id);

  if (!session?.socket) {
    if (dbSession.status === "LOGGED_OUT") {
      removeAuthDirectory(dbSession.id);
    }

    session = await startSession(dbSession.id, {
      userId,
    });
  }

  const latest = await repository.getWhatsappSessionByUser(userId);
  return normalizeManagedSession(latest, session);
}

export async function retryManagedSession(userId) {
  const dbSession = await repository.getWhatsappSessionByUser(userId);

  if (!dbSession) {
    return startManagedSession(userId, {
      method: "qr",
    });
  }

  const current = sessions.get(dbSession.id);

  if (current) {
    clearReconnectTimer(current);
    try {
      current.socket?.end?.(new Error("manual reconnect"));
    } catch {
      // Socket may already be closed.
    }
    sessions.delete(dbSession.id);
  }

  const session = await startSession(dbSession.id, {
    userId,
  });

  const latest = await repository.getWhatsappSessionByUser(userId);
  return normalizeManagedSession(latest, session);
}

export async function disconnectSession(sessionId) {
  const session = sessions.get(sessionId);

  if (session) {
    clearReconnectTimer(session);

    try {
      if (session.socket) {
        await session.socket.logout();
      }
    } catch (error) {
      console.warn(`[${sessionId}] logout warning:`, error.message);
    }

    sessions.delete(sessionId);
  }

  removeAuthDirectory(sessionId);
}

export async function disconnectManagedSession(userId) {
  const dbSession = await repository.getWhatsappSessionByUser(userId);

  if (!dbSession) {
    return null;
  }

  await disconnectSession(dbSession.id);

  const updated = await repository.updateWhatsappSessionById(
    dbSession.id,
    {
      status: "LOGGED_OUT",
      bot_mode: "off",
      whatsapp_phone: null,
      display_name: null,
      connected_at: null,
    }
  );

  updatePolicyCache(updated);

  await repository.addActivity(userId, {
    type: "whatsapp",
    title: "WhatsApp disconnected",
    detail: "",
  });

  return normalizeManagedSession(updated, null);
}

function normalizeManagedSession(dbSession, memorySession) {
  if (!dbSession && !memorySession) {
    return null;
  }

  const status = memorySession?.status || dbSession?.status || "DISCONNECTED";
  const qrDataUrl = memorySession?.qr || null;
  const qrIssuedAt = memorySession?.qrIssuedAt || null;
  const pairingCode = memorySession?.pairingCode || null;
  const pairingIssuedAt = memorySession?.pairingCodeIssuedAt || null;

  return {
    sessionId: memorySession?.id || dbSession?.id || null,
    status: toFrontendWhatsappStatus(status),
    account:
      dbSession?.whatsapp_phone || dbSession?.display_name
        ? {
            name: dbSession.display_name || "WhatsApp account",
            phone: dbSession.whatsapp_phone || null,
          }
        : null,
    connectedAt: dbSession?.connected_at || null,
    qr: qrDataUrl
      ? {
          id: `qr_${qrIssuedAt || Date.now()}`,
          payload: null,
          imageDataUrl: qrDataUrl,
          issuedAt: qrIssuedAt,
          expiresAt: null,
        }
      : null,
    pairingCode: pairingCode
      ? {
          code: pairingCode,
          phone: memorySession?.pairingPhone || null,
          issuedAt: pairingIssuedAt,
          // Informational UI TTL only. WhatsApp owns the real validity window.
          displayExpiresAt: pairingIssuedAt
            ? new Date(
                new Date(pairingIssuedAt).getTime() +
                  PAIRING_CODE_DISPLAY_TTL
              ).toISOString()
            : null,
        }
      : null,
  };
}

export async function sendText({
  sessionId,
  chatId,
  text,
}) {
  const session = sessions.get(sessionId);

  if (
    !session ||
    !session.socket ||
    session.status !== "CONNECTED"
  ) {
    throw new Error("Session is not connected");
  }

  if (!chatId) {
    throw new Error("chatId is required");
  }

  if (!text) {
    throw new Error("text is required");
  }

  return session.socket.sendMessage(chatId, {
    text,
  });
}

async function restoreManagedSessions() {
  if (!isSupabaseConfigured()) {
    return false;
  }

  const dbSessions = await repository.listWhatsappSessions();

  for (const dbSession of dbSessions) {
    const authPath = authPathFor(dbSession.id);

    if (!fs.existsSync(authPath)) {
      if (
        !["LOGGED_OUT", "DISCONNECTED"].includes(dbSession.status)
      ) {
        await repository.updateWhatsappSessionById(dbSession.id, {
          status: "DISCONNECTED",
        });
      }
      continue;
    }

    if (["LOGGED_OUT", "DISCONNECTED"].includes(dbSession.status)) {
      continue;
    }

    console.log(`Restoring managed session: ${dbSession.id}`);

    try {
      await startSession(dbSession.id, {
        userId: dbSession.user_id,
      });
    } catch (error) {
      console.error(
        `Failed restoring managed session ${dbSession.id}:`,
        error
      );
    }
  }

  return true;
}

async function restoreLegacySessions() {
  if (!RESTORE_LEGACY_SESSIONS) {
    return;
  }

  if (!fs.existsSync(DATA_DIR)) {
    return;
  }

  const entries = fs.readdirSync(DATA_DIR, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    if (!entry.isDirectory() || sessions.has(entry.name)) {
      continue;
    }

    console.log(`Restoring legacy session: ${entry.name}`);

    try {
      await startSession(entry.name);
    } catch (error) {
      console.error(
        `Failed restoring legacy session ${entry.name}:`,
        error
      );
    }
  }
}

export async function restoreSessions() {
  try {
    await restoreManagedSessions();
  } catch (error) {
    console.error("Managed session restore failed:", error.message);
  }

  await restoreLegacySessions();
}
