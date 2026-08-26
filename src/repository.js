import {
  callRpc,
  deleteRows,
  insertRows,
  selectRows,
  updateRows,
} from "./supabase.js";
import { normalizePhoneE164 } from "./utils.js";

const PLAN = {
  name: "RidePicker Premium",
  price: 180,
  currency: "EUR",
  interval: "month",
};

function first(rows) {
  return Array.isArray(rows) && rows.length ? rows[0] : null;
}

function userToApi(row) {
  if (!row) return null;

  const profile = {
    name: row.name || "",
    phone: row.phone_e164 || "",
    email: row.email || "",
  };

  return {
    id: row.id,
    full_name: row.name,
    name: row.name,
    phone: row.phone_e164,
    email: row.email || "",
    createdAt: row.created_at,
    profile,
  };
}

function expenseToApi(row) {
  return {
    id: row.id,
    category: row.category,
    amount: Number(row.amount || 0),
    currency: row.currency || "GBP",
    note: row.description || "",
    expenseAt: row.expense_at,
    createdAt: row.created_at,
  };
}

function activityToApi(row) {
  return {
    id: String(row.id),
    time: row.created_at,
    type: row.type,
    title: row.title,
    detail: row.description || "",
    jobId: row.job_id || null,
    metadata: row.metadata || {},
  };
}

function statusTimeline(activityRows = []) {
  return [...activityRows]
    .sort(
      (a, b) =>
        new Date(a.created_at).getTime() -
        new Date(b.created_at).getTime()
    )
    .map((row) => ({
      label: row.title,
      done: true,
      time: row.created_at,
    }));
}

function jobToApi(row, expenses = [], timeline = []) {
  return {
    id: row.id,
    pickup: row.pickup,
    dropoff: row.dropoff,
    pickupTime: row.pickup_at,
    price:
      row.price === null || row.price === undefined
        ? null
        : Number(row.price),
    currency: row.currency || "GBP",
    status: row.status,
    paymentStatus: row.payment_status,
    paymentMethod: row.payment_method,
    paymentReceivedAt: row.payment_received_at,
    vehicle: row.vehicle,
    passengers: row.passengers,
    flightNumber: row.flight_number,
    source: row.source_chat_name || row.source_chat_id || null,
    sourceChatId: row.source_chat_id,
    sourceChatName: row.source_chat_name,
    sender: row.sender_name || row.sender_id || null,
    senderId: row.sender_id,
    senderName: row.sender_name,
    originalMessage: row.original_message,
    confidence:
      row.ai_confidence === null || row.ai_confidence === undefined
        ? null
        : Number(row.ai_confidence),
    notes: row.notes,
    expenses: expenses.map(expenseToApi),
    timeline,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function subscriptionToApi(row, invoices = []) {
  if (!row) return null;

  return {
    status: row.status,
    plan: {
      ...PLAN,
      name:
        row.plan_name === "premium"
          ? PLAN.name
          : row.plan_name,
      price: Number(row.price_monthly || PLAN.price),
      currency: row.currency || PLAN.currency,
    },
    startedAt: row.current_period_start,
    nextPaymentDate: row.next_payment_at,
    activeUntil:
      row.status === "cancelled"
        ? row.current_period_end
        : null,
    paymentMethod:
      row.payment_method_brand || row.payment_method_last4
        ? {
            type: "card",
            brand: row.payment_method_brand || "Card",
            last4: row.payment_method_last4 || "",
          }
        : null,
    invoices: invoices.map((invoice) => ({
      id:
        invoice.provider_invoice_id ||
        invoice.id,
      date: invoice.paid_at || invoice.created_at,
      amount: Number(invoice.amount || 0),
      currency: invoice.currency,
      status: invoice.status,
      invoiceUrl: invoice.invoice_url,
    })),
  };
}

export const repository = {
  PLAN,

  async getUserById(userId) {
    const rows = await selectRows("users", {
      select: "*",
      id: `eq.${userId}`,
      limit: 1,
    });

    return userToApi(first(rows));
  },

  async getUserRowById(userId) {
    const rows = await selectRows("users", {
      select: "*",
      id: `eq.${userId}`,
      limit: 1,
    });

    return first(rows);
  },

  async getUserByPhone(phone) {
    const phoneE164 = normalizePhoneE164(phone);
    const rows = await selectRows("users", {
      select: "*",
      phone_e164: `eq.${phoneE164}`,
      limit: 1,
    });

    return userToApi(first(rows));
  },

  async createUser({ name, phone, email = null }) {
    const phoneE164 = normalizePhoneE164(phone);
    const cleanName = String(name || "").trim();

    if (!cleanName) {
      const error = new Error("name is required");
      error.status = 400;
      throw error;
    }

    const existing = await this.getUserByPhone(phoneE164);

    if (existing) {
      return existing;
    }

    const rows = await insertRows("users", [
      {
        phone_e164: phoneE164,
        name: cleanName,
        email: email || null,
      },
    ]);

    const user = userToApi(first(rows));

    if (!user) {
      throw new Error("Could not create user");
    }

    await insertRows("driver_preferences", [
      {
        user_id: user.id,
      },
    ]);

    await insertRows("subscriptions", [
      {
        user_id: user.id,
        plan_name: "premium",
        price_monthly: 180,
        currency: "EUR",
        status: "payment_required",
      },
    ]);

    await this.addActivity(user.id, {
      type: "ridepicker",
      title: "Account created",
      detail: "",
    });

    return user;
  },

  async getProfile(userId) {
    const user = await this.getUserById(userId);
    return user?.profile || null;
  },

  async updateProfile(userId, patch) {
    const body = {};

    if (patch.name !== undefined) {
      const name = String(patch.name || "").trim();
      if (!name) {
        const error = new Error("name cannot be empty");
        error.status = 400;
        throw error;
      }
      body.name = name;
    }

    if (patch.phone !== undefined) {
      body.phone_e164 = normalizePhoneE164(patch.phone);
    }

    if (patch.email !== undefined) {
      body.email = patch.email || null;
    }

    const rows = await updateRows("users", body, {
      id: `eq.${userId}`,
    });

    return userToApi(first(rows));
  },

  async getDriverPreferences(userId) {
    const rows = await selectRows("driver_preferences", {
      select: "*",
      user_id: `eq.${userId}`,
      limit: 1,
    });

    return first(rows);
  },

  async updateDriverPreferences(userId, patch) {
    const rows = await updateRows(
      "driver_preferences",
      patch,
      {
        user_id: `eq.${userId}`,
      }
    );

    return first(rows);
  },

  async getWhatsappSessionByUser(userId) {
    const rows = await selectRows("whatsapp_sessions", {
      select: "*",
      user_id: `eq.${userId}`,
      limit: 1,
    });

    return first(rows);
  },

  async getWhatsappSessionById(sessionId) {
    const rows = await selectRows("whatsapp_sessions", {
      select: "*",
      id: `eq.${sessionId}`,
      limit: 1,
    });

    return first(rows);
  },

  async listWhatsappSessions() {
    return selectRows("whatsapp_sessions", {
      select: "*",
      order: "created_at.asc",
    });
  },

  async ensureWhatsappSession(userId) {
    const existing = await this.getWhatsappSessionByUser(userId);

    if (existing) {
      return existing;
    }

    try {
      const rows = await insertRows("whatsapp_sessions", [
        {
          user_id: userId,
          status: "DISCONNECTED",
          bot_mode: "off",
        },
      ]);

      return first(rows);
    } catch (error) {
      if (error.code === "23505") {
        return this.getWhatsappSessionByUser(userId);
      }

      throw error;
    }
  },

  async updateWhatsappSessionById(sessionId, patch) {
    const rows = await updateRows(
      "whatsapp_sessions",
      patch,
      {
        id: `eq.${sessionId}`,
      }
    );

    return first(rows);
  },

  async updateWhatsappSessionByUser(userId, patch) {
    const rows = await updateRows(
      "whatsapp_sessions",
      patch,
      {
        user_id: `eq.${userId}`,
      }
    );

    return first(rows);
  },

  async registerWhatsappUnexpected401(
    sessionId,
    { reasonTag = null, conflictType = null, terminalCandidate = false } = {}
  ) {
    const decision = await callRpc("register_whatsapp_unexpected_401", {
      p_session_id: sessionId,
      p_reason_tag: reasonTag,
      p_conflict_type: conflictType,
      p_terminal_candidate: Boolean(terminalCandidate),
    });

    const sessionRow = await this.getWhatsappSessionById(sessionId);
    return { ...(decision || {}), sessionRow };
  },

  async markWhatsappRecoveryStable(sessionId, connectedAt) {
    if (!connectedAt) return false;
    return Boolean(
      await callRpc("mark_whatsapp_recovery_stable", {
        p_session_id: sessionId,
        p_connected_at: connectedAt,
      })
    );
  },

  async getRidePickerState(userId) {
    const session = await this.getWhatsappSessionByUser(userId);

    return {
      mode: session?.bot_mode || "off",
      botStartedAt: session?.bot_enabled_at || null,
    };
  },

  async getSubscriptionRow(userId) {
    const rows = await selectRows("subscriptions", {
      select: "*",
      user_id: `eq.${userId}`,
      limit: 1,
    });

    return first(rows);
  },

  async getSubscription(userId) {
    const subscription = await this.getSubscriptionRow(userId);

    if (!subscription) {
      return null;
    }

    const invoices = await selectRows("billing_invoices", {
      select: "*",
      subscription_id: `eq.${subscription.id}`,
      order: "created_at.desc",
    });

    return subscriptionToApi(subscription, invoices);
  },

  async updateSubscription(userId, patch) {
    const rows = await updateRows(
      "subscriptions",
      patch,
      {
        user_id: `eq.${userId}`,
      }
    );

    return first(rows);
  },


  async createJob(userId, input) {
    const row = {
      user_id: userId,
      source_message_id: input.sourceMessageId || input.source_message_id || null,
      pickup: input.pickup || null,
      dropoff: input.dropoff || null,
      pickup_at: input.pickupAt || input.pickup_at || input.pickupTime || null,
      price:
        input.price === null || input.price === undefined || input.price === ""
          ? null
          : Number(input.price),
      currency: input.currency || "GBP",
      vehicle: input.vehicle || null,
      passengers:
        input.passengers === null || input.passengers === undefined
          ? null
          : Number(input.passengers),
      flight_number: input.flightNumber || input.flight_number || null,
      source_chat_id: input.sourceChatId || input.source_chat_id || null,
      source_chat_name: input.sourceChatName || input.source_chat_name || input.source || null,
      sender_id: input.senderId || input.sender_id || null,
      sender_name: input.senderName || input.sender_name || input.sender || null,
      original_message: input.originalMessage || input.original_message || null,
      status: input.status || "new",
      payment_status: input.paymentStatus || input.payment_status || "unpaid",
      payment_method: input.paymentMethod || input.payment_method || null,
      ai_confidence:
        input.confidence === null || input.confidence === undefined
          ? null
          : Number(input.confidence),
      notes: input.notes || null,
    };

    const rows = await insertRows("jobs", [row]);
    const created = first(rows);

    if (!created) {
      throw new Error("Could not create job");
    }

    if (created.source_message_id) {
      try {
        await insertRows(
          "job_messages",
          [
            {
              job_id: created.id,
              message_id: created.source_message_id,
              relation_type: "source",
            },
          ],
          {
            query: { on_conflict: "job_id,message_id" },
            prefer: "resolution=ignore-duplicates,return=representation",
          }
        );
      } catch {
        // The main job is already created; this link is helpful but non-critical.
      }

      await this.updateMessage(created.source_message_id, {
        processing_status: "parsed",
      });
    }

    await this.addActivity(userId, {
      jobId: created.id,
      type: "job",
      title: "New job detected",
      detail: `${created.pickup || "Pickup"} → ${created.dropoff || "Dropoff"}`,
    });

    return this.getJob(userId, created.id);
  },

  async listJobs(userId) {
    const jobs = await selectRows("jobs", {
      select: "*",
      user_id: `eq.${userId}`,
      order: "created_at.desc",
    });

    if (!jobs.length) {
      return [];
    }

    const jobIds = jobs.map((job) => job.id);
    const inFilter = `in.(${jobIds.join(",")})`;

    const [expenses, activity] = await Promise.all([
      selectRows("job_expenses", {
        select: "*",
        job_id: inFilter,
        order: "expense_at.asc",
      }),
      selectRows("activity", {
        select: "*",
        job_id: inFilter,
        order: "created_at.asc",
      }),
    ]);

    return jobs.map((job) =>
      jobToApi(
        job,
        expenses.filter((expense) => expense.job_id === job.id),
        statusTimeline(
          activity.filter((entry) => entry.job_id === job.id)
        )
      )
    );
  },

  async getJob(userId, jobId) {
    const jobs = await selectRows("jobs", {
      select: "*",
      id: `eq.${jobId}`,
      user_id: `eq.${userId}`,
      limit: 1,
    });

    const job = first(jobs);
    if (!job) return null;

    const [expenses, activity] = await Promise.all([
      selectRows("job_expenses", {
        select: "*",
        job_id: `eq.${jobId}`,
        order: "expense_at.asc",
      }),
      selectRows("activity", {
        select: "*",
        job_id: `eq.${jobId}`,
        order: "created_at.asc",
      }),
    ]);

    return jobToApi(job, expenses, statusTimeline(activity));
  },

  async updateJobStatus(userId, jobId, status) {
    const allowed = new Set([
      "new",
      "interested",
      "contacted",
      "negotiating",
      "won",
      "completed",
      "lost",
      "ignored",
    ]);

    if (!allowed.has(status)) {
      const error = new Error("invalid job status");
      error.status = 400;
      throw error;
    }

    const rows = await updateRows(
      "jobs",
      { status },
      {
        id: `eq.${jobId}`,
        user_id: `eq.${userId}`,
      }
    );

    const row = first(rows);
    if (!row) return null;

    await this.addActivity(userId, {
      jobId,
      type: "job",
      title: `Job status changed to ${status}`,
      detail: `${row.pickup || "Pickup"} → ${row.dropoff || "Dropoff"}`,
    });

    return this.getJob(userId, jobId);
  },

  async updateJobPayment(userId, jobId, patch) {
    const body = {};

    if (patch.paymentStatus !== undefined) {
      if (!["paid", "unpaid"].includes(patch.paymentStatus)) {
        const error = new Error("invalid payment status");
        error.status = 400;
        throw error;
      }

      body.payment_status = patch.paymentStatus;
      body.payment_received_at =
        patch.paymentStatus === "paid"
          ? new Date().toISOString()
          : null;
    }

    if (patch.paymentMethod !== undefined) {
      const method = patch.paymentMethod || null;
      const aliases = {
        transfer: "account",
      };
      const normalized = aliases[method] || method;

      if (
        normalized !== null &&
        !["cash", "card", "invoice", "account"].includes(normalized)
      ) {
        const error = new Error("invalid payment method");
        error.status = 400;
        throw error;
      }

      body.payment_method = normalized;
    }

    const rows = await updateRows("jobs", body, {
      id: `eq.${jobId}`,
      user_id: `eq.${userId}`,
    });

    const row = first(rows);
    if (!row) return null;

    if (patch.paymentStatus === "paid") {
      await this.addActivity(userId, {
        jobId,
        type: "job",
        title: "Payment marked as paid",
        detail:
          row.price !== null
            ? `${row.currency || "GBP"} ${row.price}`
            : "",
      });
    }

    return this.getJob(userId, jobId);
  },

  async addExpense(userId, jobId, expense) {
    const job = await this.getJob(userId, jobId);
    if (!job) return null;

    const amount = Number(expense.amount);
    if (!Number.isFinite(amount) || amount < 0) {
      const error = new Error("expense amount must be a positive number");
      error.status = 400;
      throw error;
    }

    const category = String(expense.category || "other").toLowerCase();
    const allowed = new Set([
      "fuel",
      "parking",
      "tolls",
      "congestion",
      "commission",
      "other",
    ]);

    if (!allowed.has(category)) {
      const error = new Error("invalid expense category");
      error.status = 400;
      throw error;
    }

    await insertRows("job_expenses", [
      {
        job_id: jobId,
        category,
        amount,
        currency: expense.currency || job.currency || "GBP",
        description: expense.note || expense.description || null,
        expense_at: expense.expenseAt || new Date().toISOString(),
      },
    ]);

    await this.addActivity(userId, {
      jobId,
      type: "job",
      title: "Expense added",
      detail: `${category} · ${amount}`,
    });

    return this.getJob(userId, jobId);
  },

  async removeExpense(userId, jobId, expenseId) {
    const job = await this.getJob(userId, jobId);
    if (!job) return null;

    await deleteRows("job_expenses", {
      id: `eq.${expenseId}`,
      job_id: `eq.${jobId}`,
    });

    return this.getJob(userId, jobId);
  },

  async listActivity(userId) {
    const rows = await selectRows("activity", {
      select: "*",
      user_id: `eq.${userId}`,
      order: "created_at.desc",
    });

    return rows.map(activityToApi);
  },

  async addActivity(userId, entry) {
    if (!userId) return null;

    const rows = await insertRows("activity", [
      {
        user_id: userId,
        job_id: entry.jobId || entry.job_id || null,
        type: entry.type || "ridepicker",
        title: entry.title || "RidePicker activity",
        description: entry.detail || entry.description || null,
        metadata: entry.metadata || {},
      },
    ]);

    return activityToApi(first(rows));
  },

  async getDashboardSummary(userId) {
    const rows = await selectRows("dashboard_summary", {
      select: "*",
      user_id: `eq.${userId}`,
      limit: 1,
    });

    const row = first(rows);
    if (!row) {
      return {
        expectedRevenue: 0,
        received: 0,
        outstanding: 0,
        expenses: 0,
        netReceived: 0,
        jobsWon: 0,
        upcomingJobs: 0,
        completedJobs: 0,
      };
    }

    return {
      expectedRevenue: Number(row.expected_revenue || 0),
      received: Number(row.received || 0),
      outstanding: Number(row.outstanding || 0),
      expenses: Number(row.expenses || 0),
      netReceived: Number(row.net_received || 0),
      jobsWon: Number(row.jobs_won || 0),
      upcomingJobs: Number(row.upcoming_jobs || 0),
      completedJobs: Number(row.completed_jobs || 0),
    };
  },

  async upsertChat({
    sessionId,
    chatId,
    chatType,
    name,
    lastMessageAt,
  }) {
    const rows = await insertRows(
      "whatsapp_chats",
      [
        {
          session_id: sessionId,
          chat_id: chatId,
          chat_type: chatType,
          name: name || null,
          last_message_at: lastMessageAt || new Date().toISOString(),
        },
      ],
      {
        query: {
          on_conflict: "session_id,chat_id",
        },
        prefer: "resolution=merge-duplicates,return=representation",
      }
    );

    return first(rows);
  },

  async insertMessage(row) {
    const rows = await insertRows(
      "messages",
      [row],
      {
        query: {
          on_conflict: "session_id,whatsapp_message_id",
        },
        prefer: "resolution=ignore-duplicates,return=representation",
      }
    );

    return first(rows);
  },

  async updateMessage(messageId, patch) {
    const rows = await updateRows("messages", patch, {
      id: `eq.${messageId}`,
    });

    return first(rows);
  },
};

export {
  activityToApi,
  expenseToApi,
  jobToApi,
  subscriptionToApi,
  userToApi,
};
