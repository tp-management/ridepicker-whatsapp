import express from "express";

import { INTERNAL_API_KEY } from "./config.js";
import { repository } from "./repository.js";
import { writeSystemLog } from "./systemLog.js";
import { isSupabaseConfigured } from "./supabase.js";
import { createHttpError } from "./utils.js";
import { reconcileTerminalManagedSession } from "./whatsapp/managedSessionBoundary.js";
import {
  disconnectManagedSession,
  disconnectSession,
  getManagedSession,
  getSession,
  getSessions,
  refreshManagedQr,
  refreshManagedSession,
  requestManagedPairingCode,
  requestPairingCode,
  retryManagedSession,
  sendText,
  startManagedSession,
  startSession,
  updatePolicyCache,
} from "./whatsapp.js";

const router = express.Router();

function sendError(res, error) {
  const status = error.status || 500;

  if (status >= 500) {
    console.error(error);
  }

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

function optionalInternalProtection(req, res, next) {
  if (!INTERNAL_API_KEY) {
    return next();
  }

  const key = req.get("x-api-key") || req.get("x-ridepicker-key");

  if (key !== INTERNAL_API_KEY) {
    return res.status(401).json({
      error: "invalid API key",
    });
  }

  next();
}

function requireInternalKey(req, res, next) {
  if (!INTERNAL_API_KEY) {
    return res.status(503).json({
      error: "INTERNAL_API_KEY is not configured",
    });
  }

  const key = req.get("x-api-key") || req.get("x-ridepicker-key");

  if (key !== INTERNAL_API_KEY) {
    return res.status(401).json({
      error: "invalid API key",
    });
  }

  next();
}

async function requireUser(req, res, next) {
  try {
    const user = await repository.getUserById(req.params.userId);

    if (!user) {
      return res.status(404).json({
        error: "user not found",
      });
    }

    req.ridePickerUser = user;
    next();
  } catch (error) {
    sendError(res, error);
  }
}

async function reconcileTerminalWhatsapp(req, res, next) {
  try {
    // A terminal DB state is authoritative. Before exposing or acting on a
    // disconnected WhatsApp session, fully remove any stale Baileys runtime
    // and Supabase auth state so the next pairing always starts clean.
    await reconcileTerminalManagedSession(req.params.userId);
    next();
  } catch (error) {
    sendError(res, error);
  }
}

function subscriptionIsActive(row) {
  if (!row) return false;
  if (row.status === "active") return true;

  if (
    row.status === "cancelled" &&
    row.current_period_end &&
    new Date(row.current_period_end) > new Date()
  ) {
    return true;
  }

  return false;
}

router.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "ridepicker-whatsapp",
    supabaseConfigured: isSupabaseConfigured(),
  });
});

// ---------------------------------------------------------------------------
// RidePicker account / frontend API
// ---------------------------------------------------------------------------

router.get("/api/users/by-phone/:phone", requireSupabase, async (req, res) => {
  try {
    const user = await repository.getUserByPhone(req.params.phone);
    res.json({ user });
  } catch (error) {
    sendError(res, error);
  }
});

router.post("/api/users", requireSupabase, async (req, res) => {
  try {
    const user = await repository.createUser({
      name: req.body?.name,
      phone: req.body?.phone,
      email: req.body?.email,
    });

    res.status(201).json({ user });
  } catch (error) {
    sendError(res, error);
  }
});

router.get(
  "/api/users/:userId",
  requireSupabase,
  requireUser,
  async (req, res) => {
    res.json({ user: req.ridePickerUser });
  }
);

router.get(
  "/api/users/:userId/profile",
  requireSupabase,
  requireUser,
  async (req, res) => {
    try {
      const profile = await repository.getProfile(req.params.userId);
      res.json({ profile });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.patch(
  "/api/users/:userId/profile",
  requireSupabase,
  requireUser,
  async (req, res) => {
    try {
      const user = await repository.updateProfile(
        req.params.userId,
        req.body || {}
      );
      res.json({ user, profile: user?.profile || null });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get(
  "/api/users/:userId/preferences",
  requireSupabase,
  requireUser,
  async (req, res) => {
    try {
      const preferences = await repository.getDriverPreferences(
        req.params.userId
      );
      res.json({ preferences });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.patch(
  "/api/users/:userId/preferences",
  requireSupabase,
  requireUser,
  async (req, res) => {
    try {
      const preferences = await repository.updateDriverPreferences(
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
// RidePicker mode
// ---------------------------------------------------------------------------

router.get(
  "/api/users/:userId/ridepicker",
  requireSupabase,
  requireUser,
  async (req, res) => {
    try {
      const state = await repository.getRidePickerState(req.params.userId);
      res.json(state);
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.put(
  "/api/users/:userId/ridepicker",
  requireSupabase,
  requireUser,
  async (req, res) => {
    try {
      const mode = req.body?.mode;

      if (!["off", "assist", "autopilot"].includes(mode)) {
        throw createHttpError(400, "invalid RidePicker mode");
      }

      if (mode === "autopilot") {
        throw createHttpError(409, "Autopilot is coming soon");
      }

      const session = await repository.getWhatsappSessionByUser(
        req.params.userId
      );

      if (mode !== "off") {
        if (!session || session.status !== "CONNECTED") {
          throw createHttpError(
            409,
            "WhatsApp must be connected before enabling RidePicker"
          );
        }

        const subscription = await repository.getSubscriptionRow(
          req.params.userId
        );

        if (!subscriptionIsActive(subscription)) {
          throw createHttpError(
            402,
            "An active RidePicker Premium subscription is required"
          );
        }
      }

      if (!session && mode === "off") {
        return res.json({
          mode: "off",
          botStartedAt: null,
        });
      }

      const updated = await repository.updateWhatsappSessionByUser(
        req.params.userId,
        {
          bot_mode: mode,
        }
      );

      updatePolicyCache(updated);

      await repository.addActivity(req.params.userId, {
        type: "ridepicker",
        title:
          mode === "off"
            ? "RidePicker turned off"
            : "RidePicker set to Assist",
        detail:
          mode === "off"
            ? "Monitoring stopped."
            : "Monitoring new WhatsApp messages and detecting jobs.",
      });

      void writeSystemLog({
        userId: req.params.userId,
        sessionId: updated?.id || session?.id || null,
        level: "info",
        source: "ridepicker",
        event: "bot_mode_changed",
        message:
          mode === "off"
            ? "RidePicker monitoring turned off"
            : "RidePicker Assist enabled",
        details: { mode },
      });

      res.json({
        mode: updated?.bot_mode || "off",
        botStartedAt: updated?.bot_enabled_at || null,
      });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// ---------------------------------------------------------------------------
// WhatsApp user-facing API
// ---------------------------------------------------------------------------

router.get(
  "/api/users/:userId/whatsapp",
  requireSupabase,
  requireUser,
  reconcileTerminalWhatsapp,
  async (req, res) => {
    try {
      const session = await getManagedSession(req.params.userId);
      res.setHeader("Cache-Control", "no-store");
      res.json({ session });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  "/api/users/:userId/whatsapp/start",
  requireSupabase,
  requireUser,
  reconcileTerminalWhatsapp,
  async (req, res) => {
    try {
      const method = req.body?.method || "qr";

      if (!["qr", "pairing_code"].includes(method)) {
        throw createHttpError(400, "method must be qr or pairing_code");
      }

      const session = await startManagedSession(req.params.userId, {
        method,
        phone: req.body?.phone || null,
      });

      res.setHeader("Cache-Control", "no-store");
      res.json({ session });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  "/api/users/:userId/whatsapp/pairing-code",
  requireSupabase,
  requireUser,
  reconcileTerminalWhatsapp,
  async (req, res) => {
    try {
      const session = await requestManagedPairingCode(
        req.params.userId,
        req.body?.phone || null
      );

      res.setHeader("Cache-Control", "no-store");
      res.json({ session });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  "/api/users/:userId/whatsapp/refresh-qr",
  requireSupabase,
  requireUser,
  reconcileTerminalWhatsapp,
  async (req, res) => {
    try {
      const session = await refreshManagedQr(req.params.userId);
      res.setHeader("Cache-Control", "no-store");
      res.json({ session });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  "/api/users/:userId/whatsapp/reconnect",
  requireSupabase,
  requireUser,
  reconcileTerminalWhatsapp,
  async (req, res) => {
    try {
      const session = await retryManagedSession(req.params.userId);
      res.setHeader("Cache-Control", "no-store");
      res.json({ session });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.delete(
  "/api/users/:userId/whatsapp",
  requireSupabase,
  requireUser,
  reconcileTerminalWhatsapp,
  async (req, res) => {
    try {
      const session = await disconnectManagedSession(req.params.userId);
      res.json({ session });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// ---------------------------------------------------------------------------
// Jobs / expenses / dashboard
// ---------------------------------------------------------------------------

router.get(
  "/api/users/:userId/jobs",
  requireSupabase,
  requireUser,
  async (req, res) => {
    try {
      const jobs = await repository.listJobs(req.params.userId);
      res.json({ jobs });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get(
  "/api/users/:userId/jobs/:jobId",
  requireSupabase,
  requireUser,
  async (req, res) => {
    try {
      const job = await repository.getJob(
        req.params.userId,
        req.params.jobId
      );

      if (!job) {
        return res.status(404).json({ error: "job not found" });
      }

      res.json({ job });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.patch(
  "/api/users/:userId/jobs/:jobId/status",
  requireSupabase,
  requireUser,
  async (req, res) => {
    try {
      const job = await repository.updateJobStatus(
        req.params.userId,
        req.params.jobId,
        req.body?.status
      );

      if (!job) {
        return res.status(404).json({ error: "job not found" });
      }

      res.json({ job });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.patch(
  "/api/users/:userId/jobs/:jobId/payment",
  requireSupabase,
  requireUser,
  async (req, res) => {
    try {
      const job = await repository.updateJobPayment(
        req.params.userId,
        req.params.jobId,
        req.body || {}
      );

      if (!job) {
        return res.status(404).json({ error: "job not found" });
      }

      res.json({ job });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  "/api/users/:userId/jobs/:jobId/expenses",
  requireSupabase,
  requireUser,
  async (req, res) => {
    try {
      const job = await repository.addExpense(
        req.params.userId,
        req.params.jobId,
        req.body || {}
      );

      if (!job) {
        return res.status(404).json({ error: "job not found" });
      }

      res.status(201).json({ job });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.delete(
  "/api/users/:userId/jobs/:jobId/expenses/:expenseId",
  requireSupabase,
  requireUser,
  async (req, res) => {
    try {
      const job = await repository.removeExpense(
        req.params.userId,
        req.params.jobId,
        req.params.expenseId
      );

      if (!job) {
        return res.status(404).json({ error: "job not found" });
      }

      res.json({ job });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get(
  "/api/users/:userId/dashboard",
  requireSupabase,
  requireUser,
  async (req, res) => {
    try {
      const summary = await repository.getDashboardSummary(req.params.userId);
      res.json({ summary });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// ---------------------------------------------------------------------------
// Activity
// ---------------------------------------------------------------------------

router.get(
  "/api/users/:userId/activity",
  requireSupabase,
  requireUser,
  async (req, res) => {
    try {
      const activity = await repository.listActivity(req.params.userId);
      res.json({ activity });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  "/api/users/:userId/activity",
  requireSupabase,
  requireUser,
  async (req, res) => {
    try {
      const entry = await repository.addActivity(
        req.params.userId,
        req.body || {}
      );
      res.status(201).json({ entry });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// ---------------------------------------------------------------------------
// Billing
// ---------------------------------------------------------------------------

router.get(
  "/api/users/:userId/billing",
  requireSupabase,
  requireUser,
  async (req, res) => {
    try {
      const subscription = await repository.getSubscription(req.params.userId);
      res.json({
        plan: repository.PLAN,
        subscription,
      });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  "/api/users/:userId/billing/activate",
  requireSupabase,
  requireUser,
  async (req, res) => {
    try {
      const now = new Date();
      const next = new Date(now);
      next.setMonth(next.getMonth() + 1);

      await repository.updateSubscription(req.params.userId, {
        status: "active",
        current_period_start: now.toISOString(),
        current_period_end: next.toISOString(),
        next_payment_at: next.toISOString(),
      });

      const subscription = await repository.getSubscription(req.params.userId);
      res.json({ subscription });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  "/api/users/:userId/billing/cancel",
  requireSupabase,
  requireUser,
  async (req, res) => {
    try {
      const current = await repository.getSubscriptionRow(req.params.userId);

      if (!current) {
        return res.status(404).json({ error: "subscription not found" });
      }

      await repository.updateSubscription(req.params.userId, {
        status: "cancelled",
        next_payment_at: null,
      });

      const subscription = await repository.getSubscription(req.params.userId);
      res.json({ subscription });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.post(
  "/api/users/:userId/billing/reactivate",
  requireSupabase,
  requireUser,
  async (req, res) => {
    try {
      const now = new Date();
      const next = new Date(now);
      next.setMonth(next.getMonth() + 1);

      await repository.updateSubscription(req.params.userId, {
        status: "active",
        current_period_start: now.toISOString(),
        current_period_end: next.toISOString(),
        next_payment_at: next.toISOString(),
      });

      const subscription = await repository.getSubscription(req.params.userId);
      res.json({ subscription });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// ---------------------------------------------------------------------------
// Internal n8n/API operations
// ---------------------------------------------------------------------------

router.post(
  "/internal/jobs",
  requireSupabase,
  requireInternalKey,
  async (req, res) => {
    try {
      const userId = req.body?.userId;
      const inputJobs = Array.isArray(req.body?.jobs)
        ? req.body.jobs
        : req.body?.job
        ? [req.body.job]
        : [];

      if (!userId || !inputJobs.length) {
        throw createHttpError(400, "userId and jobs are required");
      }

      const created = [];

      for (const job of inputJobs) {
        created.push(
          await repository.createJob(userId, {
            ...job,
            sourceMessageId:
              job.sourceMessageId ||
              req.body?.sourceMessageId ||
              null,
          })
        );
      }

      res.status(201).json({ jobs: created });
    } catch (error) {
      sendError(res, error);
    }
  }
);

// ---------------------------------------------------------------------------
// Legacy WhatsApp API kept for the existing n8n flow / manual debugging.
// ---------------------------------------------------------------------------

router.get("/sessions", optionalInternalProtection, (req, res) => {
  res.json(getSessions());
});

router.post("/sessions", optionalInternalProtection, async (req, res) => {
  try {
    const { id } = req.body || {};

    if (!id) {
      return res.status(400).json({ error: "id required" });
    }

    const session = await startSession(id);

    res.json({
      id,
      status: session.status,
    });
  } catch (error) {
    sendError(res, error);
  }
});

router.get("/sessions/:id", optionalInternalProtection, (req, res) => {
  const session = getSession(req.params.id);

  if (!session) {
    return res.status(404).json({ error: "session not found" });
  }

  res.json({
    id: req.params.id,
    status: session.status,
    hasQr: Boolean(session.qr),
    pairingCode: session.pairingCode || null,
  });
});

router.get("/sessions/:id/qr-data", optionalInternalProtection, (req, res) => {
  const session = getSession(req.params.id);

  if (!session) {
    return res.status(404).json({ error: "session not found" });
  }

  res.setHeader("Cache-Control", "no-store");
  res.json({
    id: req.params.id,
    status: session.status,
    qr: session.qr || null,
    pairingCode: session.pairingCode || null,
  });
});

router.post(
  "/sessions/:id/pairing-code",
  optionalInternalProtection,
  async (req, res) => {
    try {
      const result = await requestPairingCode({
        sessionId: req.params.id,
        phone: req.body?.phone,
      });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.delete(
  "/sessions/:id",
  optionalInternalProtection,
  async (req, res) => {
    try {
      await disconnectSession(req.params.id);
      res.json({ ok: true });
    } catch (error) {
      sendError(res, error);
    }
  }
);

router.get("/sessions/:id/qr", (req, res) => {
  const sessionId = req.params.id;

  res.setHeader("Cache-Control", "no-store");
  res.send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>Connect WhatsApp | RidePicker</title>
<style>
body{font-family:Inter,system-ui,sans-serif;background:#0f1115;color:white;display:grid;place-items:center;min-height:100vh;margin:0;padding:24px}.card{width:min(520px,100%);background:#171a21;border:1px solid #262b35;border-radius:24px;padding:36px;text-align:center}.qr{width:min(340px,100%);background:white;border-radius:18px;padding:16px;display:none;margin:24px auto}.status{margin-top:18px;font-weight:600}.hint{color:#8f98a7;font-size:14px;line-height:1.6;margin-top:18px}.ok{color:#25d366}.warn{color:#f6c344}.err{color:#ff6161}
</style>
</head>
<body><div class="card"><h1>Connect WhatsApp</h1><p>Scan the latest QR code with WhatsApp.</p><img id="qr" class="qr" /><div id="status" class="status">Preparing connection…</div><div class="hint">WhatsApp → Linked devices → Link a device<br/>Expired codes refresh automatically.</div></div>
<script>
const id=${JSON.stringify(sessionId)};const qr=document.getElementById('qr');const status=document.getElementById('status');
async function tick(){try{let r=await fetch('/sessions/'+encodeURIComponent(id)+'/qr-data',{cache:'no-store'});if(r.status===404){await fetch('/sessions',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({id})});status.textContent='Starting session…';return}let d=await r.json();if(d.status==='CONNECTED'){qr.style.display='none';status.className='status ok';status.textContent='WhatsApp connected';return}if(d.status==='LOGGED_OUT'){qr.style.display='none';status.className='status err';status.textContent='Session logged out';return}if(d.qr){qr.src=d.qr;qr.style.display='block';status.className='status';status.textContent='Waiting for scan';return}status.className='status warn';status.textContent=d.status==='RECONNECTING'?'Reconnecting…':'Preparing fresh QR…'}catch(e){status.className='status warn';status.textContent='Connection interrupted. Retrying…'}}
tick();setInterval(tick,1500);
</script></body></html>`);
});

router.post("/send", optionalInternalProtection, async (req, res) => {
  try {
    const { session, chatId, text } = req.body || {};

    const result = await sendText({
      sessionId: session,
      chatId,
      text,
    });

    res.json({
      ok: true,
      id: result?.key?.id || null,
    });
  } catch (error) {
    error.status = error.status || 400;
    sendError(res, error);
  }
});

export default router;