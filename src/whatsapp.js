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
  N8N_FORWARD_FROM_ME,
  N8N_FORWARD_SESSION_EVENTS,
  N8N_WEBHOOK_URL,
  RESTORE_LEGACY_SESSIONS,
  SESSION_POLICY_CACHE_MS,
} from "./config.js";
import { repository } from "./repository.js";
import { writeSystemLog } from "./systemLog.js";
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
const PAIRING_READY_TIMEOUT_MS = 15 * 1000;
const REGISTRATION_CONFIRM_TIMEOUT_MS = 5 * 1000;

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

function logWhatsappEvent(
  session,
  level,
  event,
  message = null,
  details = {}
) {
  // Do not await persistent logging inside Baileys lifecycle handlers.
  // Logging must never slow down or break the WhatsApp handshake.
  void writeSystemLog({
    userId: session?.userId || null,
    sessionId: session?.userId ? session?.id || null : null,
    level,
    source: "whatsapp",
    event,
    message,
    details,
  });
}

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

function resolvePairingReady(session) {
  if (!session || session.pairingReady) {
    return;
  }

  session.pairingReady = true;

  for (const resolve of session.pairingReadyResolvers || []) {
    resolve();
  }

  session.pairingReadyResolvers = [];
}

function waitForPairingReady(session) {
  if (session?.pairingReady) {
    return Promise.resolve();
  }

  if (!session?.socket) {
    return Promise.reject(
      Object.assign(new Error("WhatsApp socket is not available"), {
        status: 409,
      })
    );
  }

  return new Promise((resolve, reject) => {
    let settled = false;

    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;

      session.pairingReadyResolvers = (
        session.pairingReadyResolvers || []
      ).filter((item) => item !== finish);

      reject(
        Object.assign(
          new Error(
            "WhatsApp connection was not ready for pairing. Generate a new code and try again."
          ),
          { status: 504 }
        )
      );
    }, PAIRING_READY_TIMEOUT_MS);

    session.pairingReadyResolvers ||= [];
    session.pairingReadyResolvers.push(finish);
  });
}

async function waitForRegisteredSession(session, socket) {
  const startedAt = Date.now();

  while (
    Date.now() - startedAt < REGISTRATION_CONFIRM_TIMEOUT_MS
  ) {
    if (session?.registered && socket?.user?.id) {
      return true;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  return Boolean(session?.registered && socket?.user?.id);
}

function pairingCodeIsFresh(session) {
  if (!session?.pairingCode || !session?.pairingCodeIssuedAt) {
    return false;
  }

  const issuedAt = new Date(session.pairingCodeIssuedAt).getTime();
  return (
    Number.isFinite(issuedAt) &&
    Date.now() - issuedAt < PAIRING_CODE_DISPLAY_TTL
  );
}

function resetFailedPairingSession(sessionId) {
  const existing = sessions.get(sessionId);

  if (existing) {
    clearReconnectTimer(existing);

    try {
      existing.socket?.end?.(new Error("Resetting failed pairing session"));
    } catch {
      // Socket may already be closed.
    }

    sessions.delete(sessionId);
  }

  removeAuthDirectory(sessionId);
}

function disconnectDetails(lastDisconnect) {
  const error = lastDisconnect?.error;

  const statusCode =
    error instanceof Boom
      ? error.output.statusCode
      : error?.output?.statusCode ||
        error?.data?.statusCode ||
        error?.statusCode ||
        null;

  const message =
    error?.message ||
    error?.output?.payload?.message ||
    "WhatsApp connection closed";

  return {
    statusCode,
    message,
  };
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

      void writeSystemLog({
        userId: event?.userId || null,
        sessionId: event?.session || null,
        level: "error",
        source: "n8n",
        event: "n8n_failed",
        message: `n8n returned HTTP ${response.status}`,
        details: {
          httpStatus: response.status,
          outboundEvent: event?.event || null,
          dbMessageId: event?.payload?.dbMessageId || null,
        },
      });

      return false;
    }

    console.log(`[n8n] delivered: ${event.event}`);

    void writeSystemLog({
      userId: event?.userId || null,
      sessionId: event?.session || null,
      level: "info",
      source: "n8n",
      event:
        event?.event === "message.received"
          ? "message_forwarded_to_n8n"
          : "event_forwarded_to_n8n",
      message: `Delivered ${event?.event || "event"} to n8n`,
      details: {
        outboundEvent: event?.event || null,
        dbMessageId: event?.payload?.dbMessageId || null,
      },
    });

    return true;
  } catch (error) {
    console.error("[n8n] webhook error:", error.message);

    void writeSystemLog({
      userId: event?.userId || null,
      sessionId: event?.session || null,
      level: "error",
      source: "n8n",
      event: "n8n_failed",
      message: error.message,
      details: {
        outboundEvent: event?.event || null,
        dbMessageId: event?.payload?.dbMessageId || null,
      },
    });

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
      processing_status:
        fromMe && !N8N_FORWARD_FROM_ME ? "ignored" : "new",
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

  // By default outgoing messages are context-only. For temporary testing,
  // N8N_FORWARD_FROM_ME=true also forwards manually sent messages to n8n.
  // IMPORTANT: turn this back off before automated replies/autopilot are enabled
  // to avoid feeding bot-generated outbound messages back into the AI pipeline.
  if (fromMe && !N8N_FORWARD_FROM_ME) {
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
      fromMe,
      direction: fromMe ? "outgoing" : "incoming",
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
    pairingReady: false,
    pairingReadyResolvers: [],
    pairingRequestInFlight: false,
    pairingAttemptActive: false,
    status: "STARTING",
    registered: Boolean(state?.creds?.registered),
    reconnectTimer: null,
    lastError: null,
  };

  sessions.set(id, session);

  // Keep the socket configuration intentionally small and use Baileys defaults.
  // This is the previously stable RidePicker socket configuration.
  const socket = makeWASocket({
    auth: state,
    markOnlineOnConnect: false,
    printQRInTerminal: false,
  });

  session.socket = socket;

  socket.ev.on("creds.update", async () => {
    await saveCreds();

    const wasRegistered = session.registered;
    session.registered = Boolean(state?.creds?.registered);

    if (!wasRegistered && session.registered) {
      console.log(`[${id}] WhatsApp credentials registered`);
      logWhatsappEvent(
        session,
        "info",
        "credentials_registered",
        "WhatsApp credentials registered"
      );
    }
  });

  socket.ev.on("connection.update", async (update) => {
    const { connection, qr, lastDisconnect } = update;

    // Pairing-code auth must wait for the first QR challenge. This mirrors
    // the official Baileys example and avoids asking for a phone code while
    // the socket is only in the generic `connecting` phase.
    if (qr && !session.registered) {
      resolvePairingReady(session);
    }

    if (qr) {
      session.qr = await QRCode.toDataURL(qr);
      session.qrIssuedAt = new Date().toISOString();
      session.status = "QR";

      console.log(`[${id}] QR ready`);
      logWhatsappEvent(
        session,
        "info",
        "qr_ready",
        "WhatsApp QR fallback is ready"
      );

      await persistSessionState(session, {
        status: "QR",
      });
    }

    if (connection === "open") {
      clearReconnectTimer(session);

      const actuallyRegistered = await waitForRegisteredSession(
        session,
        socket
      );

      if (!actuallyRegistered) {
        session.status = "ERROR";
        session.lastError = {
          code: "UNREGISTERED_OPEN",
          message:
            "WhatsApp socket opened without confirmed registered credentials.",
        };

        console.error(
          `[${id}] refusing false CONNECTED state: credentials are not registered`
        );

        logWhatsappEvent(
          session,
          "error",
          "connection_validation_failed",
          "Socket opened without confirmed registered credentials",
          { code: "UNREGISTERED_OPEN" }
        );

        await persistSessionState(session, {
          status: "ERROR",
        });

        return;
      }

      session.qr = null;
      session.qrIssuedAt = null;
      session.pairingCode = null;
      session.pairingCodeIssuedAt = null;
      session.pairingPhone = null;
      session.pairingAttemptActive = false;
      session.status = "CONNECTED";
      session.lastError = null;

      const account = socketAccount(socket);
      const connectedAt = new Date().toISOString();

      console.log(`[${id}] WhatsApp connected`);
      logWhatsappEvent(
        session,
        "info",
        "whatsapp_connected",
        "WhatsApp connected"
      );

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
      const { statusCode, message } = disconnectDetails(lastDisconnect);

      console.warn(
        `[${id}] WhatsApp connection closed`,
        JSON.stringify({
          statusCode,
          message,
          registered: session.registered,
          pairingAttemptActive: session.pairingAttemptActive,
        })
      );

      logWhatsappEvent(
        session,
        "warning",
        "whatsapp_connection_closed",
        message,
        {
          statusCode,
          registered: session.registered,
          pairingAttemptActive: session.pairingAttemptActive,
        }
      );

      session.socket = null;
      session.lastError = {
        code: statusCode,
        message,
      };

      const restartRequired =
        statusCode === DisconnectReason.restartRequired;

      // A 515/restartRequired is part of the normal Baileys pairing flow after
      // credentials have been accepted. Recreate the socket with the saved
      // credentials instead of treating it as a failed pairing.
      if (restartRequired) {
        session.status = "RECONNECTING";

        console.log(
          `[${id}] WhatsApp requested restart after pairing/authentication`
        );
        logWhatsappEvent(
          session,
          "info",
          "whatsapp_restart_required",
          "WhatsApp requested restart after pairing/authentication",
          { statusCode }
        );

        await persistSessionState(session, {
          status: "RECONNECTING",
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
              console.error(`[${id}] restart failed:`, error);
              logWhatsappEvent(
                session,
                "error",
                "restart_failed",
                error.message,
                { error }
              );

              await persistSessionState(session, {
                status: "ERROR",
              });
            }
          }, 750);
        }

        return;
      }

      // During an unregistered pairing attempt, a close is a pairing failure,
      // not a real user logout. Keep the last code in memory for the display
      // TTL so polling cannot make it vanish while the user is typing. Do not
      // destroy partial auth asynchronously here. The NEXT explicit request
      // for a new code resets failed auth before creating a fresh socket.
      if (!session.registered && session.pairingAttemptActive) {
        clearReconnectTimer(session);
        session.status = "ERROR";
        session.pairingAttemptActive = false;
        session.pairingRequestInFlight = false;

        console.error(
          `[${id}] pairing failed before credentials were registered`,
          JSON.stringify({ statusCode, message })
        );
        logWhatsappEvent(
          session,
          "error",
          "pairing_failed",
          message,
          {
            statusCode,
            registered: session.registered,
            authReset: false,
            codePreservedForDisplay: Boolean(session.pairingCode),
          }
        );

        await persistSessionState(session, {
          status: "ERROR",
        });

        return;
      }

      // Only a non-pairing 401 is a genuine WhatsApp logout.
      if (statusCode === DisconnectReason.loggedOut) {
        clearReconnectTimer(session);
        session.status = "LOGGED_OUT";
        session.qr = null;
        session.pairingCode = null;
        session.pairingCodeIssuedAt = null;
        session.pairingPhone = null;
        session.pairingAttemptActive = false;

        console.log(`[${id}] WhatsApp logged out`);
        logWhatsappEvent(
          session,
          "info",
          "whatsapp_logged_out",
          "WhatsApp logged out",
          { statusCode }
        );

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
      logWhatsappEvent(
        session,
        "warning",
        "reconnect_started",
        "WhatsApp reconnect started",
        { statusCode, reason: message }
      );

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
            logWhatsappEvent(
              session,
              "error",
              "reconnect_failed",
              error.message,
              { error }
            );

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
        logWhatsappEvent(
          session,
          "error",
          "message_processing_failed",
          error.message,
          { whatsappMessageId: message?.key?.id || null }
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

  if (session.pairingRequestInFlight) {
    const error = new Error(
      "A WhatsApp pairing code request is already in progress."
    );
    error.status = 409;
    throw error;
  }

  const digits = phoneDigits(phone);

  // Wait for the QR challenge. The official Baileys example requests the
  // phone pairing code from the QR update, which is a stronger readiness
  // signal than the generic `connecting` state.
  await waitForPairingReady(session);

  if (session.registered) {
    const error = new Error(
      "WhatsApp session became registered while preparing the pairing code."
    );
    error.status = 409;
    throw error;
  }

  session.pairingRequestInFlight = true;
  session.pairingAttemptActive = true;
  session.lastError = null;

  try {
    console.log(
      `[${sessionId}] requesting pairing code for +${digits}`
    );
    logWhatsappEvent(
      session,
      "info",
      "pairing_started",
      "WhatsApp pairing code requested"
    );

    const code = await session.socket.requestPairingCode(digits);

    session.pairingCode = code;
    session.pairingCodeIssuedAt = new Date().toISOString();
    session.pairingPhone = `+${digits}`;

    console.log(`[${sessionId}] pairing code ready`);
    logWhatsappEvent(
      session,
      "info",
      "pairing_code_created",
      "WhatsApp pairing code created"
    );

    // Return the pairing code immediately. The frontend should show it as soon
    // as Baileys creates it while the connection lifecycle continues normally.

    await persistSessionState(session, {
      status: "STARTING",
    });

    return {
      code,
      issuedAt: session.pairingCodeIssuedAt,
      phone: session.pairingPhone,
    };
  } catch (error) {
    session.pairingAttemptActive = false;
    session.pairingCode = null;
    session.pairingCodeIssuedAt = null;
    session.pairingPhone = null;
    session.lastError = {
      code: error?.output?.statusCode || error?.statusCode || null,
      message: error.message,
    };

    console.error(
      `[${sessionId}] pairing code request failed:`,
      error
    );
    logWhatsappEvent(
      session,
      "error",
      "pairing_failed",
      error.message,
      {
        statusCode:
          error?.output?.statusCode || error?.statusCode || null,
      }
    );

    await persistSessionState(session, {
      status: "ERROR",
    });

    throw error;
  } finally {
    session.pairingRequestInFlight = false;
  }
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

  if (method === "pairing_code" && dbSession.status === "ERROR") {
    resetFailedPairingSession(dbSession.id);
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

  let memorySession = sessions.get(dbSession.id) || null;

  // Repeated taps while the current attempt is healthy return the SAME fresh
  // code. We never rotate a live code under the user's fingers.
  if (
    memorySession?.socket &&
    memorySession.pairingAttemptActive &&
    !memorySession.lastError &&
    pairingCodeIsFresh(memorySession)
  ) {
    const latest = await repository.getWhatsappSessionByUser(userId);

    return {
      ...normalizeManagedSession(latest, memorySession),
      pairingCode: {
        code: memorySession.pairingCode,
        issuedAt: memorySession.pairingCodeIssuedAt,
        phone: memorySession.pairingPhone,
      },
    };
  }

  // If the previous attempt failed, clean its temporary auth only when the
  // user explicitly requests a new code. This prevents the current code from
  // disappearing due to an async connection-close event.
  const failedAttempt =
    dbSession.status === "ERROR" ||
    (memorySession &&
      !memorySession.registered &&
      (memorySession.status === "ERROR" || memorySession.lastError));

  if (failedAttempt) {
    resetFailedPairingSession(dbSession.id);
    memorySession = null;
  }

  const session =
    memorySession ||
    (await startSession(dbSession.id, {
      userId,
    }));

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

  void writeSystemLog({
    userId,
    sessionId: dbSession.id,
    level: "info",
    source: "whatsapp",
    event: "whatsapp_disconnected",
    message: "WhatsApp disconnected by user",
    details: { reason: "manual_disconnect" },
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
  const pairingCode = pairingCodeIsFresh(memorySession)
    ? memorySession.pairingCode
    : null;
  const pairingIssuedAt = pairingCode
    ? memorySession?.pairingCodeIssuedAt || null
    : null;

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
    error: memorySession?.lastError || null,
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
        void writeSystemLog({
          userId: dbSession.user_id,
          sessionId: dbSession.id,
          level: "warning",
          source: "whatsapp",
          event: "auth_state_missing",
          message: "WhatsApp auth directory is missing during restore",
          details: { previousStatus: dbSession.status },
        });

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
    void writeSystemLog({
      userId: dbSession.user_id,
      sessionId: dbSession.id,
      level: "info",
      source: "whatsapp",
      event: "session_restore_started",
      message: "Restoring managed WhatsApp session",
      details: { previousStatus: dbSession.status },
    });

    try {
      await startSession(dbSession.id, {
        userId: dbSession.user_id,
      });
    } catch (error) {
      console.error(
        `Failed restoring managed session ${dbSession.id}:`,
        error
      );
      void writeSystemLog({
        userId: dbSession.user_id,
        sessionId: dbSession.id,
        level: "error",
        source: "whatsapp",
        event: "session_restore_failed",
        message: error.message,
        details: { error },
      });
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