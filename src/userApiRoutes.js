import express from "express";

import { repository } from "./repository.js";
import { isSupabaseConfigured } from "./supabase.js";
import { userApiRepository } from "./userApiRepository.js";
import { sendText } from "./whatsapp.js";

const router = express.Router();

function sendError(res, error) {
  const status = error.status || 500;
  if (status >= 500) console.error(error);
  return res.status(status).json({
    error: error.message || "Unexpected error",
    ...(error.details ? { details: error.details } : {}),
  });
}

function requireSupabase(req, res, next) {
  if (!isSupabaseConfigured()) {
    return res.status(503).json({
      error:
        "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the backend.",
    });
  }
  next();
}

async function requireUser(req, res, next) {
  try {
    // SECURITY BLOCKER: this only proves that the target RidePicker user exists.
    // Replace with Supabase Auth/JWT ownership verification when real app auth
    // is introduced. Do not treat a frontend API key as authentication.
    const user = await repository.getUserById(req.params.userId);
    if (!user) {
      return res.status(404).json({ error: "user not found" });
    }
    req.ridePickerUser = user;
    next();
  } catch (error) {
    sendError(res, error);
  }
}

const userRoute = [requireSupabase, requireUser];

function booleanQuery(value, fallback = null) {
  if (value === undefined) return fallback;
  if (value === "true" || value === true) return true;
  if (value === "false" || value === false) return false;
  const error = new Error("boolean query parameter must be true or false");
  error.status = 400;
  throw error;
}

// ---------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------

router.get(
  "/api/users/:userId/preferences",
  ...userRoute,
  async (req, res) => {
    try {
      const preferences = await userApiRepository.getPreferences(req.params.userId);
      res.json({ preferences });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.patch(
  "/api/users/:userId/preferences",
  ...userRoute,
  async (req, res) => {
    try {
      const preferences = await userApiRepository.updatePreferences(
        req.params.userId,
        req.body || {}
      );
      res.json({ preferences });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// ---------------------------------------------------------------------------
// WhatsApp chats and messages
// ---------------------------------------------------------------------------

router.get(
  "/api/users/:userId/messages",
  ...userRoute,
  async (req, res) => {
    try {
      const messages = await userApiRepository.listMessages(req.params.userId, {
        chatId: req.query.chatId || null,
        limit: req.query.limit,
        before: req.query.before || null,
        after: req.query.after || null,
        fromMe: req.query.fromMe,
        processingStatus: req.query.processingStatus || null,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ messages });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get(
  "/api/users/:userId/messages/:messageId",
  ...userRoute,
  async (req, res) => {
    try {
      const message = await userApiRepository.getMessage(
        req.params.userId,
        req.params.messageId
      );
      if (!message) return res.status(404).json({ error: "message not found" });
      res.setHeader("Cache-Control", "no-store");
      res.json({ message });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get(
  "/api/users/:userId/whatsapp/chats",
  ...userRoute,
  async (req, res) => {
    try {
      const chats = await userApiRepository.listChats(req.params.userId, {
        limit: req.query.limit,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ chats });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get(
  "/api/users/:userId/whatsapp/chats/:chatId/messages",
  ...userRoute,
  async (req, res) => {
    try {
      const messages = await userApiRepository.listMessages(req.params.userId, {
        chatId: req.params.chatId,
        limit: req.query.limit,
        before: req.query.before || null,
        after: req.query.after || null,
        fromMe: req.query.fromMe,
        processingStatus: req.query.processingStatus || null,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ messages });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  "/api/users/:userId/whatsapp/chats/:chatId/messages",
  ...userRoute,
  async (req, res) => {
    try {
      const text = String(req.body?.text || "").trim();
      if (!text) {
        return res.status(400).json({ error: "text is required" });
      }
      if (text.length > 4096) {
        return res.status(400).json({ error: "text is too long" });
      }

      const session = await repository.getWhatsappSessionByUser(req.params.userId);
      if (!session || session.status !== "CONNECTED") {
        return res.status(409).json({ error: "WhatsApp is not connected" });
      }

      const result = await sendText({
        sessionId: session.id,
        chatId: req.params.chatId,
        text,
      });

      res.status(201).json({
        message: {
          whatsappMessageId: result?.key?.id || null,
          chatId: req.params.chatId,
          body: text,
          fromMe: true,
        },
      });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// ---------------------------------------------------------------------------
// Jobs, linked messages and expenses
// ---------------------------------------------------------------------------

router.post(
  "/api/users/:userId/jobs",
  ...userRoute,
  async (req, res) => {
    try {
      const job = await userApiRepository.createJob(
        req.params.userId,
        req.body || {}
      );
      res.status(201).json({ job });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.patch(
  "/api/users/:userId/jobs/:jobId",
  ...userRoute,
  async (req, res) => {
    try {
      const job = await userApiRepository.updateJob(
        req.params.userId,
        req.params.jobId,
        req.body || {}
      );
      if (!job) return res.status(404).json({ error: "job not found" });
      res.json({ job });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.delete(
  "/api/users/:userId/jobs/:jobId",
  ...userRoute,
  async (req, res) => {
    try {
      const deleted = await userApiRepository.deleteJob(
        req.params.userId,
        req.params.jobId
      );
      if (!deleted) return res.status(404).json({ error: "job not found" });
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get(
  "/api/users/:userId/jobs/:jobId/messages",
  ...userRoute,
  async (req, res) => {
    try {
      const messages = await userApiRepository.listJobMessages(
        req.params.userId,
        req.params.jobId
      );
      if (messages === null) {
        return res.status(404).json({ error: "job not found" });
      }
      res.json({ messages });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get(
  "/api/users/:userId/jobs/:jobId/expenses",
  ...userRoute,
  async (req, res) => {
    try {
      const job = await repository.getJob(req.params.userId, req.params.jobId);
      if (!job) return res.status(404).json({ error: "job not found" });
      res.json({ expenses: job.expenses || [] });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.patch(
  "/api/users/:userId/jobs/:jobId/expenses/:expenseId",
  ...userRoute,
  async (req, res) => {
    try {
      const job = await userApiRepository.updateExpense(
        req.params.userId,
        req.params.jobId,
        req.params.expenseId,
        req.body || {}
      );
      if (!job) return res.status(404).json({ error: "job not found" });
      res.json({ job });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// ---------------------------------------------------------------------------
// Activity and billing reads
// ---------------------------------------------------------------------------

router.get(
  "/api/users/:userId/activity",
  ...userRoute,
  async (req, res) => {
    try {
      const includeMessages = booleanQuery(req.query.includeMessages, true);
      const activity = await userApiRepository.listActivity(req.params.userId, {
        limit: req.query.limit,
        includeMessages,
      });
      res.setHeader("Cache-Control", "no-store");
      res.json({ activity });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get(
  "/api/users/:userId/billing/invoices",
  ...userRoute,
  async (req, res) => {
    try {
      const invoices = await userApiRepository.listInvoices(req.params.userId);
      res.json({ invoices });
    } catch (error) {
      sendError(res, error);
    }
  }
);

export default router;
