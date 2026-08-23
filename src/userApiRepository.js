import {
  deleteRows,
  selectRows,
  updateRows,
} from "./supabase.js";
import { repository } from "./repository.js";

const EXPENSE_CATEGORIES = new Set([
  "fuel",
  "parking",
  "tolls",
  "congestion",
  "commission",
  "other",
]);

const MESSAGE_PROCESSING_STATUSES = new Set([
  "new",
  "sent_to_ai",
  "parsed",
  "ignored",
  "error",
]);

function first(rows) {
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function boundedLimit(value, fallback = 100, max = 500) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

function dateFilter(value, operator) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    const error = new Error(`invalid ${operator === "lt" ? "before" : "after"} cursor`);
    error.status = 400;
    throw error;
  }
  return `${operator}.${date.toISOString()}`;
}

function numberOrNull(value, field) {
  if (value === null || value === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    const error = new Error(`${field} must be a number`);
    error.status = 400;
    throw error;
  }
  return parsed;
}

export function preferencesToApi(row) {
  if (!row) return null;
  return {
    userId: row.user_id,
    baseLocation: row.base_location || "",
    defaultVehicle: row.default_vehicle || "",
    minimumJobPrice:
      row.minimum_job_price === null || row.minimum_job_price === undefined
        ? null
        : Number(row.minimum_job_price),
    preferredAreas: row.preferred_areas || [],
    blockedAreas: row.blocked_areas || [],
    workingHours: row.working_hours || {},
    autopilotRules: row.autopilot_rules || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function chatToApi(row) {
  if (!row) return null;
  return {
    id: row.chat_id,
    chatId: row.chat_id,
    type: row.chat_type,
    name: row.name || null,
    lastMessageAt: row.last_message_at || null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function messageToApi(row) {
  if (!row) return null;
  return {
    id: String(row.id),
    whatsappMessageId: row.whatsapp_message_id,
    chatId: row.chat_id,
    chatName: row.chat_name || null,
    senderId: row.sender_id || null,
    senderName: row.sender_name || null,
    body: row.body || "",
    isGroup: Boolean(row.is_group),
    fromMe: Boolean(row.from_me),
    type: row.message_type,
    hasMedia: Boolean(row.has_media),
    media: row.media || null,
    timestamp: row.message_timestamp,
    processingStatus: row.processing_status,
    forwardedToN8nAt: row.forwarded_to_n8n_at || null,
    createdAt: row.created_at,
  };
}

export function messageActivityToApi(row) {
  const message = messageToApi(row);
  const sender = row.sender_name || row.chat_name || "WhatsApp";
  const detail =
    row.body ||
    (row.has_media ? `[${row.message_type || "media"}]` : "");

  return {
    id: `message:${row.id}`,
    time: row.message_timestamp || row.created_at,
    type: "message",
    title: row.from_me ? "WhatsApp message sent" : `Message from ${sender}`,
    detail,
    jobId: null,
    metadata: {
      messageId: message.id,
      whatsappMessageId: message.whatsappMessageId,
      chatId: message.chatId,
      chatName: message.chatName,
      senderId: message.senderId,
      senderName: message.senderName,
      fromMe: message.fromMe,
      messageType: message.type,
      hasMedia: message.hasMedia,
      processingStatus: message.processingStatus,
    },
  };
}

function preferencePatchToRow(patch = {}) {
  const body = {};
  const fields = [
    ["baseLocation", "base_location"],
    ["defaultVehicle", "default_vehicle"],
    ["minimumJobPrice", "minimum_job_price"],
    ["preferredAreas", "preferred_areas"],
    ["blockedAreas", "blocked_areas"],
    ["workingHours", "working_hours"],
    ["autopilotRules", "autopilot_rules"],
  ];

  for (const [apiKey, dbKey] of fields) {
    if (patch[apiKey] !== undefined) body[dbKey] = patch[apiKey];
    if (patch[dbKey] !== undefined) body[dbKey] = patch[dbKey];
  }

  if (body.minimum_job_price !== undefined) {
    body.minimum_job_price = numberOrNull(
      body.minimum_job_price,
      "minimumJobPrice"
    );
    if (body.minimum_job_price !== null && body.minimum_job_price < 0) {
      const error = new Error("minimumJobPrice cannot be negative");
      error.status = 400;
      throw error;
    }
  }

  for (const key of ["preferred_areas", "blocked_areas"]) {
    if (body[key] !== undefined && !Array.isArray(body[key])) {
      const error = new Error(`${key} must be an array`);
      error.status = 400;
      throw error;
    }
  }

  for (const key of ["working_hours", "autopilot_rules"]) {
    if (
      body[key] !== undefined &&
      (body[key] === null || Array.isArray(body[key]) || typeof body[key] !== "object")
    ) {
      const error = new Error(`${key} must be an object`);
      error.status = 400;
      throw error;
    }
  }

  return body;
}

function jobPatchToRow(patch = {}) {
  const body = {};
  const scalarFields = [
    ["pickup", "pickup"],
    ["dropoff", "dropoff"],
    ["pickupAt", "pickup_at"],
    ["pickup_at", "pickup_at"],
    ["currency", "currency"],
    ["vehicle", "vehicle"],
    ["flightNumber", "flight_number"],
    ["flight_number", "flight_number"],
    ["notes", "notes"],
  ];

  for (const [apiKey, dbKey] of scalarFields) {
    if (patch[apiKey] !== undefined) body[dbKey] = patch[apiKey] || null;
  }

  if (patch.price !== undefined) {
    body.price = numberOrNull(patch.price, "price");
  }

  if (patch.passengers !== undefined) {
    const passengers = numberOrNull(patch.passengers, "passengers");
    if (passengers !== null && (!Number.isInteger(passengers) || passengers < 0)) {
      const error = new Error("passengers must be a non-negative integer");
      error.status = 400;
      throw error;
    }
    body.passengers = passengers;
  }

  if (patch.confidence !== undefined || patch.ai_confidence !== undefined) {
    const value = patch.confidence ?? patch.ai_confidence;
    const confidence = numberOrNull(value, "confidence");
    if (confidence !== null && (confidence < 0 || confidence > 1)) {
      const error = new Error("confidence must be between 0 and 1");
      error.status = 400;
      throw error;
    }
    body.ai_confidence = confidence;
  }

  return body;
}

function expensePatchToRow(patch = {}) {
  const body = {};

  if (patch.category !== undefined) {
    const category = String(patch.category || "").toLowerCase();
    if (!EXPENSE_CATEGORIES.has(category)) {
      const error = new Error("invalid expense category");
      error.status = 400;
      throw error;
    }
    body.category = category;
  }

  if (patch.amount !== undefined) {
    const amount = numberOrNull(patch.amount, "amount");
    if (amount === null || amount < 0) {
      const error = new Error("expense amount must be a non-negative number");
      error.status = 400;
      throw error;
    }
    body.amount = amount;
  }

  if (patch.currency !== undefined) body.currency = patch.currency || "GBP";
  if (patch.note !== undefined || patch.description !== undefined) {
    body.description = patch.note ?? patch.description ?? null;
  }
  if (patch.expenseAt !== undefined || patch.expense_at !== undefined) {
    const raw = patch.expenseAt ?? patch.expense_at;
    const date = new Date(raw);
    if (Number.isNaN(date.getTime())) {
      const error = new Error("invalid expenseAt");
      error.status = 400;
      throw error;
    }
    body.expense_at = date.toISOString();
  }

  return body;
}

export function createUserApiRepository({
  coreRepository = repository,
  select = selectRows,
  update = updateRows,
  remove = deleteRows,
} = {}) {
  async function sessionForUser(userId) {
    return coreRepository.getWhatsappSessionByUser(userId);
  }

  return {
    async getPreferences(userId) {
      return preferencesToApi(await coreRepository.getDriverPreferences(userId));
    },

    async updatePreferences(userId, patch) {
      const body = preferencePatchToRow(patch);
      if (!Object.keys(body).length) {
        return this.getPreferences(userId);
      }

      const rows = await update("driver_preferences", body, {
        user_id: `eq.${userId}`,
      });
      return preferencesToApi(first(rows));
    },

    async listChats(userId, { limit = 100 } = {}) {
      const session = await sessionForUser(userId);
      if (!session) return [];

      const rows = await select("whatsapp_chats", {
        select: "*",
        session_id: `eq.${session.id}`,
        order: "last_message_at.desc.nullslast",
        limit: boundedLimit(limit),
      });
      return rows.map(chatToApi);
    },

    async listMessages(
      userId,
      {
        chatId = null,
        limit = 100,
        before = null,
        after = null,
        fromMe = null,
        processingStatus = null,
      } = {}
    ) {
      if (before && after) {
        const error = new Error("use either before or after, not both");
        error.status = 400;
        throw error;
      }

      if (
        processingStatus &&
        !MESSAGE_PROCESSING_STATUSES.has(processingStatus)
      ) {
        const error = new Error("invalid processingStatus");
        error.status = 400;
        throw error;
      }

      const session = await sessionForUser(userId);
      if (!session) return [];

      const query = {
        select: "*",
        session_id: `eq.${session.id}`,
        order: "message_timestamp.desc",
        limit: boundedLimit(limit),
      };

      if (chatId) query.chat_id = `eq.${chatId}`;
      if (before) query.message_timestamp = dateFilter(before, "lt");
      if (after) {
        query.message_timestamp = dateFilter(after, "gt");
        query.order = "message_timestamp.asc";
      }
      if (fromMe !== null && fromMe !== undefined && fromMe !== "") {
        query.from_me = `eq.${String(fromMe) === "true" || fromMe === true}`;
      }
      if (processingStatus) {
        query.processing_status = `eq.${processingStatus}`;
      }

      const rows = await select("messages", query);
      return rows.map(messageToApi);
    },

    async getMessage(userId, messageId) {
      const session = await sessionForUser(userId);
      if (!session) return null;

      const rows = await select("messages", {
        select: "*",
        session_id: `eq.${session.id}`,
        id: `eq.${messageId}`,
        limit: 1,
      });
      return messageToApi(first(rows));
    },

    async listJobMessages(userId, jobId) {
      const job = await coreRepository.getJob(userId, jobId);
      if (!job) return null;

      const links = await select("job_messages", {
        select: "*",
        job_id: `eq.${jobId}`,
        order: "created_at.asc",
      });
      if (!links.length) return [];

      const ids = links.map((link) => link.message_id);
      const messages = await select("messages", {
        select: "*",
        id: `in.(${ids.join(",")})`,
      });
      const byId = new Map(messages.map((row) => [String(row.id), row]));

      return links
        .map((link) => {
          const row = byId.get(String(link.message_id));
          if (!row) return null;
          return {
            relationType: link.relation_type,
            linkedAt: link.created_at,
            message: messageToApi(row),
          };
        })
        .filter(Boolean);
    },

    async createJob(userId, input) {
      return coreRepository.createJob(userId, input || {});
    },

    async updateJob(userId, jobId, patch) {
      const existing = await coreRepository.getJob(userId, jobId);
      if (!existing) return null;

      const body = jobPatchToRow(patch);
      if (!Object.keys(body).length) return existing;

      const rows = await update("jobs", body, {
        id: `eq.${jobId}`,
        user_id: `eq.${userId}`,
      });
      if (!first(rows)) return null;

      await coreRepository.addActivity(userId, {
        jobId,
        type: "job",
        title: "Job details updated",
        detail: `${body.pickup ?? existing.pickup ?? "Pickup"} → ${
          body.dropoff ?? existing.dropoff ?? "Dropoff"
        }`,
      });

      return coreRepository.getJob(userId, jobId);
    },

    async deleteJob(userId, jobId) {
      const existing = await coreRepository.getJob(userId, jobId);
      if (!existing) return false;

      const rows = await remove("jobs", {
        id: `eq.${jobId}`,
        user_id: `eq.${userId}`,
      });
      return rows.length > 0;
    },

    async listExpenses(userId, jobId) {
      const job = await coreRepository.getJob(userId, jobId);
      if (!job) return null;

      return select("job_expenses", {
        select: "*",
        job_id: `eq.${jobId}`,
        order: "expense_at.asc",
      });
    },

    async updateExpense(userId, jobId, expenseId, patch) {
      const job = await coreRepository.getJob(userId, jobId);
      if (!job) return null;

      const body = expensePatchToRow(patch);
      if (Object.keys(body).length) {
        await update("job_expenses", body, {
          id: `eq.${expenseId}`,
          job_id: `eq.${jobId}`,
        });
      }

      return coreRepository.getJob(userId, jobId);
    },

    async listActivity(userId, { limit = 200, includeMessages = true } = {}) {
      const capped = boundedLimit(limit, 200, 500);
      const activityRows = await select("activity", {
        select: "*",
        user_id: `eq.${userId}`,
        order: "created_at.desc",
        limit: capped,
      });
      const activity = activityRows.map((row) => ({
        id: String(row.id),
        time: row.created_at,
        type: row.type,
        title: row.title,
        detail: row.description || "",
        jobId: row.job_id || null,
        metadata: row.metadata || {},
      }));

      if (!includeMessages) return activity;

      const session = await sessionForUser(userId);
      if (!session) return activity;

      const messageRows = await select("messages", {
        select: "*",
        session_id: `eq.${session.id}`,
        order: "message_timestamp.desc",
        limit: capped,
      });

      return [...activity, ...messageRows.map(messageActivityToApi)]
        .sort(
          (a, b) =>
            new Date(b.time || 0).getTime() - new Date(a.time || 0).getTime()
        )
        .slice(0, capped);
    },

    async listInvoices(userId) {
      const subscription = await coreRepository.getSubscription(userId);
      return subscription?.invoices || [];
    },
  };
}

export const userApiRepository = createUserApiRepository();
