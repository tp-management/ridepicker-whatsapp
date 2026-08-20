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
  N8N_WEBHOOK_URL,
} from "./config.js";


/**
 * =========================================================
 * STORAGE
 * =========================================================
 */

fs.mkdirSync(DATA_DIR, {
  recursive: true,
});


/**
 * =========================================================
 * SESSIONS
 * =========================================================
 */

const sessions = new Map();


/**
 * =========================================================
 * GROUP METADATA CACHE
 * =========================================================
 *
 * Group names don't change often.
 * No reason to request metadata from WhatsApp
 * for every single incoming message.
 */

const GROUP_CACHE_TTL =
  10 * 60 * 1000;

const groupCache =
  new Map();


function getCachedGroupMetadata(
  jid
) {
  const cached =
    groupCache.get(jid);

  if (!cached) {
    return null;
  }

  if (
    Date.now() >
    cached.expiresAt
  ) {
    groupCache.delete(jid);

    return null;
  }

  return cached.metadata;
}


function setCachedGroupMetadata(
  jid,
  metadata
) {
  groupCache.set(
    jid,
    {
      metadata,

      expiresAt:
        Date.now() +
        GROUP_CACHE_TTL,
    }
  );
}


function clearCachedGroupMetadata(
  jid
) {
  groupCache.delete(jid);
}


/**
 * =========================================================
 * MESSAGE HELPERS
 * =========================================================
 */

function getTextFromMessage(
  message
) {
  return (
    message?.conversation ||
    message
      ?.extendedTextMessage
      ?.text ||
    message
      ?.imageMessage
      ?.caption ||
    message
      ?.videoMessage
      ?.caption ||
    message
      ?.documentMessage
      ?.caption ||
    ""
  );
}


function getMessageType(
  message
) {
  if (!message) {
    return "unknown";
  }

  if (
    message.conversation ||
    message.extendedTextMessage
  ) {
    return "text";
  }

  if (message.imageMessage) {
    return "image";
  }

  if (message.videoMessage) {
    return "video";
  }

  if (message.audioMessage) {
    return "audio";
  }

  if (message.documentMessage) {
    return "document";
  }

  if (message.stickerMessage) {
    return "sticker";
  }

  if (message.locationMessage) {
    return "location";
  }

  if (message.contactMessage) {
    return "contact";
  }

  if (message.contactsArrayMessage) {
    return "contacts";
  }

  if (message.reactionMessage) {
    return "reaction";
  }

  if (message.pollCreationMessage) {
    return "poll";
  }

  return (
    Object.keys(message)[0] ||
    "unknown"
  );
}


function getMediaInfo(
  message
) {
  const media =
    message?.imageMessage ||
    message?.videoMessage ||
    message?.audioMessage ||
    message?.documentMessage ||
    message?.stickerMessage ||
    null;

  if (!media) {
    return null;
  }

  return {
    mimetype:
      media.mimetype ||
      null,

    fileName:
      media.fileName ||
      null,

    fileLength:
      media.fileLength
        ?.toString?.() ||
      media.fileLength ||
      null,

    caption:
      media.caption ||
      null,

    seconds:
      media.seconds ||
      null,
  };
}


/**
 * =========================================================
 * GROUP NAME
 * =========================================================
 */

async function getGroupMetadata(
  socket,
  chatId
) {
  const cached =
    getCachedGroupMetadata(
      chatId
    );

  if (cached) {
    return cached;
  }

  try {
    const metadata =
      await socket
        .groupMetadata(
          chatId
        );

    setCachedGroupMetadata(
      chatId,
      metadata
    );

    return metadata;
  } catch (error) {
    console.error(
      `[group] Cannot get metadata for ${chatId}:`,
      error.message
    );

    return null;
  }
}


async function getChatName({
  socket,
  chatId,
  isGroup,
  pushName,
  fromMe,
}) {
  if (isGroup) {
    const metadata =
      await getGroupMetadata(
        socket,
        chatId
      );

    return (
      metadata?.subject ||
      chatId
    );
  }

  /*
   * Incoming private message:
   * pushName normally represents
   * the sender's WhatsApp profile name.
   */
  if (
    !fromMe &&
    pushName
  ) {
    return pushName;
  }

  /*
   * Outgoing private messages can have
   * unreliable pushName information.
   *
   * Better return null than pretend
   * our own pushName is the recipient.
   */
  return null;
}


/**
 * =========================================================
 * N8N
 * =========================================================
 */

async function sendToN8n(
  event
) {
  if (!N8N_WEBHOOK_URL) {
    console.warn(
      "N8N_WEBHOOK_URL is not configured"
    );

    return;
  }

  try {
    const response =
      await fetch(
        N8N_WEBHOOK_URL,
        {
          method: "POST",

          headers: {
            "Content-Type":
              "application/json",
          },

          body:
            JSON.stringify(
              event
            ),
        }
      );

    if (!response.ok) {
      const responseBody =
        await response.text();

      console.error(
        "[n8n] webhook failed:",
        response.status,
        responseBody
      );

      return;
    }

    console.log(
      `[n8n] delivered: ${event.event}`
    );
  } catch (error) {
    console.error(
      "[n8n] webhook error:",
      error.message
    );
  }
}


/**
 * =========================================================
 * PUBLIC SESSION HELPERS
 * =========================================================
 */

export function getSession(
  id
) {
  return sessions.get(id);
}


export function getSessions() {
  return Array.from(
    sessions.entries()
  ).map(
    ([id, session]) => ({
      id,

      status:
        session.status,
    })
  );
}


/**
 * =========================================================
 * START WHATSAPP SESSION
 * =========================================================
 */

export async function startSession(
  id
) {
  const existing =
    sessions.get(id);

  if (
    existing?.socket
  ) {
    return existing;
  }


  const authPath =
    path.join(
      DATA_DIR,
      id
    );


  const {
    state,
    saveCreds,
  } =
    await useMultiFileAuthState(
      authPath
    );


  const session = {
    id,

    socket:
      null,

    qr:
      null,

    status:
      "STARTING",
  };


  sessions.set(
    id,
    session
  );


  /**
   * Baileys can itself use our
   * group metadata cache too.
   */
  const socket =
    makeWASocket({
      auth:
        state,

      markOnlineOnConnect:
        false,

      printQRInTerminal:
        false,

      cachedGroupMetadata:
        async (
          jid
        ) => {
          return (
            getCachedGroupMetadata(
              jid
            ) ||
            undefined
          );
        },
    });


  session.socket =
    socket;


  /**
   * Save updated WhatsApp keys
   */
  socket.ev.on(
    "creds.update",
    saveCreds
  );


  /**
   * =======================================================
   * GROUP UPDATES
   * =======================================================
   *
   * If group name/settings/members change,
   * invalidate cache so next message reloads it.
   */

  socket.ev.on(
    "groups.update",
    (updates) => {
      for (
        const update
        of updates
      ) {
        if (
          update.id
        ) {
          clearCachedGroupMetadata(
            update.id
          );
        }
      }
    }
  );


  socket.ev.on(
    "group-participants.update",
    (update) => {
      if (
        update?.id
      ) {
        clearCachedGroupMetadata(
          update.id
        );
      }
    }
  );


  /**
   * =======================================================
   * CONNECTION EVENTS
   * =======================================================
   */

  socket.ev.on(
    "connection.update",
    async (
      update
    ) => {
      const {
        connection,
        qr,
        lastDisconnect,
      } = update;


      /**
       * New QR
       */
      if (qr) {
        session.qr =
          await QRCode
            .toDataURL(
              qr
            );

        session.status =
          "QR";

        console.log(
          `[${id}] QR ready`
        );
      }


      /**
       * Connected
       */
      if (
        connection ===
        "open"
      ) {
        session.qr =
          null;

        session.status =
          "CONNECTED";

        console.log(
          `[${id}] WhatsApp connected`
        );

        await sendToN8n({
          event:
            "session.connected",

          session:
            id,

          timestamp:
            Date.now(),
        });
      }


      /**
       * Connection closed
       */
      if (
        connection ===
        "close"
      ) {
        const statusCode =
          lastDisconnect
            ?.error instanceof Boom
            ? lastDisconnect
                .error
                .output
                .statusCode
            : lastDisconnect
                ?.error
                ?.output
                ?.statusCode;


        session.socket =
          null;


        /**
         * User intentionally logged out
         */
        if (
          statusCode ===
          DisconnectReason
            .loggedOut
        ) {
          session.status =
            "LOGGED_OUT";

          console.log(
            `[${id}] WhatsApp logged out`
          );


          await sendToN8n({
            event:
              "session.logged_out",

            session:
              id,

            timestamp:
              Date.now(),
          });

          return;
        }


        /**
         * Temporary disconnect
         */
        session.status =
          "RECONNECTING";


        console.log(
          `[${id}] reconnecting...`
        );


        await sendToN8n({
          event:
            "session.reconnecting",

          session:
            id,

          timestamp:
            Date.now(),
        });


        setTimeout(
          async () => {
            sessions.delete(
              id
            );

            try {
              await startSession(
                id
              );
            } catch (error) {
              console.error(
                `[${id}] reconnect failed:`,
                error
              );
            }
          },
          2000
        );
      }
    }
  );


  /**
   * =======================================================
   * WHATSAPP MESSAGES
   * =======================================================
   *
   * ALL live messages go to n8n.
   *
   * Incoming:
   * message.received
   *
   * Outgoing:
   * message.sent
   */

  socket.ev.on(
    "messages.upsert",
    async ({
      messages,
      type,
    }) => {
      if (
        type !==
        "notify"
      ) {
        return;
      }


      for (
        const message
        of messages
      ) {
        const chatId =
          message
            .key
            .remoteJid;


        if (!chatId) {
          continue;
        }


        const fromMe =
          Boolean(
            message
              .key
              .fromMe
          );


        const isGroup =
          chatId.endsWith(
            "@g.us"
          );


        const participant =
          message
            .key
            .participant ||
          null;


        const participantAlt =
          message
            .key
            .participantAlt ||
          null;


        /**
         * Group incoming:
         * sender is participant.
         *
         * Private incoming:
         * sender is chatId.
         *
         * Outgoing:
         * sender is our account.
         */
        const sender =
          fromMe
            ? null
            : (
                participantAlt ||
                participant ||
                chatId
              );


        const pushName =
          message
            .pushName ||
          null;


        const body =
          getTextFromMessage(
            message.message
          );


        const messageType =
          getMessageType(
            message.message
          );


        const media =
          getMediaInfo(
            message.message
          );


        /**
         * GROUP NAME / PRIVATE CHAT NAME
         */
        const chatName =
          await getChatName({
            socket,

            chatId,

            isGroup,

            pushName,

            fromMe,
          });


        /**
         * For incoming messages,
         * pushName = sender name.
         */
        const senderName =
          fromMe
            ? null
            : pushName;


        /**
         * Complete event for n8n
         */
        const event = {
          event:
            fromMe
              ? "message.sent"
              : "message.received",

          session:
            id,

          timestamp:
            Date.now(),

          payload: {
            id:
              message
                .key
                .id ||
              null,


            /**
             * CHAT
             */
            chatId,

            chatName,

            isGroup,


            /**
             * SENDER
             */
            sender,

            senderName,

            participant,

            participantAlt,


            /**
             * DIRECTION
             */
            fromMe,


            /**
             * MESSAGE
             */
            body,

            type:
              messageType,

            hasMedia:
              Boolean(
                media
              ),

            media,
          },
        };


        console.log(
          `[${id}]`,
          fromMe
            ? "ME"
            : (
                senderName ||
                sender
              ),
          "→",
          chatName ||
            chatId,
          ":",
          body ||
            `[${messageType}]`
        );


        /**
         * Everything goes to n8n.
         */
        await sendToN8n(
          event
        );
      }
    }
  );


  return session;
}


/**
 * =========================================================
 * SEND MESSAGE
 * =========================================================
 */

export async function sendText({
  sessionId,
  chatId,
  text,
}) {
  const session =
    sessions.get(
      sessionId
    );


  if (
    !session ||
    !session.socket ||
    session.status !==
      "CONNECTED"
  ) {
    throw new Error(
      "Session is not connected"
    );
  }


  if (!chatId) {
    throw new Error(
      "chatId is required"
    );
  }


  if (!text) {
    throw new Error(
      "text is required"
    );
  }


  const result =
    await session
      .socket
      .sendMessage(
        chatId,
        {
          text,
        }
      );


  return result;
}


/**
 * =========================================================
 * RESTORE SESSIONS AFTER RESTART
 * =========================================================
 */

export async function restoreSessions() {
  if (
    !fs.existsSync(
      DATA_DIR
    )
  ) {
    return;
  }


  const entries =
    fs.readdirSync(
      DATA_DIR,
      {
        withFileTypes:
          true,
      }
    );


  for (
    const entry
    of entries
  ) {
    if (
      !entry.isDirectory()
    ) {
      continue;
    }


    console.log(
      `Restoring session: ${entry.name}`
    );


    try {
      await startSession(
        entry.name
      );
    } catch (error) {
      console.error(
        `Failed restoring ${entry.name}:`,
        error
      );
    }
  }
}