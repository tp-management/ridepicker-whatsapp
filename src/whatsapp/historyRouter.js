import express from "express";
import { selectRows } from "../supabase.js";
import { repository } from "../repository.js";
import { requestOnDemandHistory } from "./onDemandHistory.js";
import { getSession } from "../whatsapp.js";

const uuid = (s) => typeof s === "string"
  && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
const jid = (s) => typeof s === "string" && s.length <= 128
  && /^[^@\s]+@(s\.whatsapp\.net|lid|g\.us)$/.test(s);
const validBefore = (b) => b && typeof b === "object"
  && typeof b.id === "string" && b.id.length > 0 && b.id.length <= 128
  && Number.isSafeInteger(b.timestampMs) && b.timestampMs > 0
  && typeof b.fromMe === "boolean"
  && (b.participant == null || jid(b.participant));

export function createWhatsappHistoryRouter({
  apiKey = process.env.WHATSAPP_HISTORY_API_KEY || "",
  findSession = (id) => repository.getWhatsappSessionById(id),
  lookupAnchor = (query) => selectRows("messages", query),
  getSocketSession = getSession,
  requestHistory = requestOnDemandHistory,
} = {}) {
  const router = express.Router();

  router.post("/internal/whatsapp/history", async (req, res) => {
    const provided = req.get("x-api-key");
    if (!apiKey) return res.status(503).json({ error: "WHATSAPP_HISTORY_API_KEY is not configured" });
    if (!provided || provided !== apiKey) return res.status(401).json({ error: "Invalid API key" });

    const { userId, sessionId, chatId, before } = req.body || {};
    const count = req.body?.count ?? 50;
    if (!uuid(userId) || !uuid(sessionId) || !jid(chatId)
      || !Number.isInteger(count) || count < 1 || count > 50
      || (before != null && !validBefore(before))) {
      return res.status(400).json({ error: "Invalid userId, sessionId, chatId, count or before cursor" });
    }

    try {
      const session = await findSession(sessionId);
      if (!session || session.user_id !== userId) {
        return res.status(404).json({ error: "WhatsApp session not found for this user" });
      }
      const runtime = getSocketSession(sessionId);
      if (!runtime || runtime.status !== "CONNECTED" || !runtime.socket) {
        return res.status(409).json({ error: "WhatsApp session is not connected" });
      }

      let anchor = before;
      if (!anchor) {
        // Only metadata from an existing message is needed as the cursor.
        // No chat history is stored by this endpoint.
        const rows = await lookupAnchor({
          select: "whatsapp_message_id,message_timestamp,from_me,sender_id",
          session_id: "eq." + sessionId,
          chat_id: "eq." + chatId,
          order: "message_timestamp.desc",
          limit: 1,
        });
        const row = rows[0];
        const time = row && Date.parse(row.message_timestamp);
        if (!row?.whatsapp_message_id || !Number.isFinite(time)) {
          return res.status(422).json({
            error: "No message anchor available for this chat. A chatId alone cannot request older WhatsApp history.",
          });
        }
        anchor = {
          id: row.whatsapp_message_id,
          timestampMs: time,
          fromMe: Boolean(row.from_me),
          participant: chatId.endsWith("@g.us") && !row.from_me ? row.sender_id : null,
        };
      }

      const result = await requestHistory(runtime.socket, {
        chatId,
        oldestKey: {
          remoteJid: chatId,
          id: anchor.id,
          fromMe: anchor.fromMe,
          ...(anchor.participant ? { participant: anchor.participant } : {}),
        },
        oldestTimestampMs: anchor.timestampMs,
        count,
      });

      res.setHeader("Cache-Control", "no-store");
      res.json({ chatId, ...result });
    } catch (error) {
      const status = [400, 409, 422, 502, 504].includes(error?.status) ? error.status : 503;
      console.warn("[whatsapp-history] Request failed:", error?.message || error);
      res.status(status).json({ error: status === 503 ? "Could not request WhatsApp history" : error.message });
    }
  });

  return router;
}

export default createWhatsappHistoryRouter();
