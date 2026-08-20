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

function getTextFromMessage(message) {
  return (
    message?.conversation ||
    message?.extendedTextMessage?.text ||
    message?.imageMessage?.caption ||
    message?.videoMessage?.caption ||
    ""
  );
}

async function sendToN8n(event) {
  if (!N8N_WEBHOOK_URL) {
    return;
  }

  try {
    const response = await fetch(
      N8N_WEBHOOK_URL,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify(event),
      }
    );

    if (!response.ok) {
      console.error(
        `n8n webhook returned ${response.status}`
      );
    }
  } catch (error) {
    console.error(
      "n8n webhook error:",
      error.message
    );
  }
}

export function getSession(id) {
  return sessions.get(id);
}

export function getSessions() {
  return Array.from(
    sessions.entries()
  ).map(([id, session]) => ({
    id,
    status: session.status,
  }));
}

export async function startSession(id) {
  const existing = sessions.get(id);

  if (existing?.socket) {
    return existing;
  }

  const authPath = path.join(
    DATA_DIR,
    id
  );

  const {
    state,
    saveCreds,
  } = await useMultiFileAuthState(
    authPath
  );

  const session = {
    id,
    socket: null,
    qr: null,
    status: "STARTING",
  };

  sessions.set(id, session);

  const socket = makeWASocket({
    auth: state,
    markOnlineOnConnect: false,
    printQRInTerminal: false,
  });

  session.socket = socket;

  socket.ev.on(
    "creds.update",
    saveCreds
  );

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
          await QRCode.toDataURL(qr);

        session.status = "QR";

        console.log(
          `[${id}] QR ready`
        );
      }

      if (connection === "open") {
        session.qr = null;
        session.status =
          "CONNECTED";

        console.log(
          `[${id}] WhatsApp connected`
        );
      }

      if (connection === "close") {
        const statusCode =
          lastDisconnect?.error instanceof Boom
            ? lastDisconnect.error.output
                .statusCode
            : lastDisconnect?.error?.output
                ?.statusCode;

        session.socket = null;

        if (
          statusCode ===
          DisconnectReason.loggedOut
        ) {
          session.status =
            "LOGGED_OUT";

          console.log(
            `[${id}] WhatsApp logged out`
          );

          return;
        }

        session.status =
          "RECONNECTING";

        console.log(
          `[${id}] reconnecting...`
        );

        setTimeout(async () => {
          sessions.delete(id);

          try {
            await startSession(id);
          } catch (error) {
            console.error(
              `[${id}] reconnect failed:`,
              error
            );
          }
        }, 2000);
      }
    }
  );

  socket.ev.on(
    "messages.upsert",
    async ({
      messages,
      type,
    }) => {
      if (type !== "notify") {
        return;
      }

      for (const message of messages) {
        // Prevent outgoing messages from triggering reply loops.
        // if (message.key.fromMe) {
        //   continue;
        // }

        const chatId =
          message.key.remoteJid;

        if (!chatId) {
          continue;
        }

        const isGroup =
          chatId.endsWith("@g.us");

        const participant =
          message.key.participant ||
          null;

        const participantAlt =
          message.key.participantAlt ||
          null;

        const sender =
          participantAlt ||
          participant ||
          chatId;

        const body =
          getTextFromMessage(
            message.message
          );

        const event = {
          event: "message",
          session: id,
          payload: {
            id:
              message.key.id ||
              null,
            chatId,
            sender,
            participant,
            participantAlt,
            fromMe: false,
            isGroup,
            pushName:
              message.pushName ||
              null,
            body,
          },
        };

        console.log(
          `[${id}]`,
          event.payload.pushName ||
            sender,
          ":",
          body
        );

        await sendToN8n(event);
      }
    }
  );

  return session;
}

export async function sendText({
  sessionId,
  chatId,
  text,
}) {
  const session =
    sessions.get(sessionId);

  if (
    !session ||
    !session.socket ||
    session.status !== "CONNECTED"
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
    await session.socket.sendMessage(
      chatId,
      {
        text,
      }
    );

  return result;
}

export async function restoreSessions() {
  if (!fs.existsSync(DATA_DIR)) {
    return;
  }

  const entries =
    fs.readdirSync(
      DATA_DIR,
      {
        withFileTypes: true,
      }
    );

  for (const entry of entries) {
    if (!entry.isDirectory()) {
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
