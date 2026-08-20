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


fs.mkdirSync(DATA_DIR, {
  recursive: true,
});


const sessions = new Map();


/**
 * ---------------------------------------------------------
 * GROUP NAME CACHE
 * ---------------------------------------------------------
 *
 * Kad neklaustume WhatsApp groupMetadata()
 * ant kiekvienos žinutės.
 */

const groupNameCache = new Map();

const GROUP_CACHE_TTL =
  10 * 60 * 1000;


async function getGroupName(
  socket,
  chatId
) {
  const cached =
    groupNameCache.get(chatId);

  if (
    cached &&
    Date.now() < cached.expiresAt
  ) {
    return cached.name;
  }

  try {
    const metadata =
      await socket.groupMetadata(
        chatId
      );

    const name =
      metadata?.subject ||
      null;

    groupNameCache.set(
      chatId,
      {
        name,
        expiresAt:
          Date.now() +
          GROUP_CACHE_TTL,
      }
    );

    return name;
  } catch (error) {
    console.error(
      `[group] Could not get name for ${chatId}:`,
      error.message
    );

    return null;
  }
}


/**
 * ---------------------------------------------------------
 * MESSAGE HELPERS
 * ---------------------------------------------------------
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

  if (message.reactionMessage) {
    return "reaction";
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
 * ---------------------------------------------------------
 * N8N
 * ---------------------------------------------------------
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
      const body =
        await response.text();

      console.error(
        `[n8n] ${response.status}:`,
        body
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
 * ---------------------------------------------------------
 * SESSION GETTERS
 * ---------------------------------------------------------
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
 * ---------------------------------------------------------
 * START SESSION
 * ---------------------------------------------------------
 */

export async function startSession(
  id
) {
  const existing =
    sessions.get(id);

  if (existing?.socket) {
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
    socket: null,
    qr: null,
    status: "STARTING",
  };


  sessions.set(
    id,
    session
  );


  /**
   * SVARBU:
   * čia paliekam paprastą veikiančią
   * makeWASocket konfiguraciją.
   *
   * Jokio cachedGroupMetadata,
   * jokio pairing eksperimento.
   */

  const socket =
    makeWASocket({
      auth: state,

      markOnlineOnConnect:
        false,

      printQRInTerminal:
        false,
    });


  session.socket =
    socket;


  socket.ev.on(
    "creds.update",
    saveCreds
  );


  /**
   * -------------------------------------------------------
   * CONNECTION
   * -------------------------------------------------------
   */

  socket.ev.on(
    "connection.update",
    async (update) => {
      const {
        connection,
        qr,
        lastDisconnect,
      } = update;


      if (qr) {
        session.qr =
          await QRCode.toDataURL(
            qr
          );

        session.status =
          "QR";

        console.log(
          `[${id}] QR ready`
        );
      }


      if (
        connection === "open"
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


      if (
        connection === "close"
      ) {
        const statusCode =
          lastDisconnect?.error
            instanceof Boom
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
   * -------------------------------------------------------
   * MESSAGES
   * -------------------------------------------------------
   *
   * Siunčiam į n8n ir received,
   * ir sent žinutes.
   *
   * n8n pats nuspręs ką daryti.
   */

  socket.ev.on(
    "messages.upsert",
    async ({
      messages,
      type,
    }) => {
      if (
        type !== "notify"
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
         * Kas parašė.
         *
         * Grupėje:
         * participant / participantAlt
         *
         * Private:
         * chatId
         */

        const sender =
          participantAlt ||
          participant ||
          chatId;


        const senderName =
          message.pushName ||
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
         * ČIA vienintelis realus naujas dalykas.
         *
         * Jei grupė:
         * pasiimam jos subject.
         *
         * Jei private:
         * naudojam pushName, kai turim.
         */

        let chatName =
          null;


        if (isGroup) {
          chatName =
            await getGroupName(
              socket,
              chatId
            );
        } else if (
          !fromMe
        ) {
          chatName =
            senderName;
        }


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


            chatId,

            chatName,

            isGroup,


            sender,

            senderName,

            participant,

            participantAlt,


            fromMe,


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


        await sendToN8n(
          event
        );
      }
    }
  );


  return session;
}


/**
 * ---------------------------------------------------------
 * SEND TEXT
 * ---------------------------------------------------------
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
 * ---------------------------------------------------------
 * RESTORE SESSIONS
 * ---------------------------------------------------------
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