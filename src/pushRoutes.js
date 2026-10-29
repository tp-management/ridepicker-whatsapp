import express from "express";
import { repository } from "./repository.js";
import { insertRows, deleteRows, isSupabaseConfigured } from "./supabase.js";
import { pushConfigured, pushConfiguration, validPushEndpoint } from "./pushNotifications.js";
import { authorizePushUser, startPushPhoneOtp, verifyPushPhoneOtp } from "./pushAuth.js";

const recentOtpRequests = new Map();
export function allowOtpAttempt(key, now = Date.now()) {
  const old = recentOtpRequests.get(key) || [];
  const lastHour = old.filter(time => now - time < 3_600_000);
  if (lastHour.length >= 5 || (lastHour.length && now - lastHour.at(-1) < 60_000)) {
    recentOtpRequests.set(key, lastHour);
    return false;
  }
  lastHour.push(now);
  recentOtpRequests.set(key, lastHour);
  if (recentOtpRequests.size > 5000) recentOtpRequests.clear();
  return true;
}

export function createPushRouter({
  findUser = (id) => repository.getUserById(id),
  insert = insertRows,
  remove = deleteRows,
  configured = isSupabaseConfigured,
  pushConfig = pushConfiguration,
  authorize = authorizePushUser,
  startOtp = startPushPhoneOtp,
  verifyOtp = verifyPushPhoneOtp,
  allowOtp = allowOtpAttempt,
} = {}) {
  const router = express.Router();

  const enabled = () => configured() && pushConfigured(pushConfig());
  router.get("/api/push/public-key", (_req, res) => {
    if (!enabled()) return res.status(503).json({ error: "Push notifications are not configured" });
    res.setHeader("Cache-Control", "no-store");
    return res.json({ publicKey: pushConfig().publicKey });
  });

  router.post("/api/users/:userId/push-otp", async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: "Push notifications are not configured" });
    try {
      const user = await findUser(req.params.userId);
      if (!user) return res.status(404).json({ error: "Account not found" });
      // Limit account + source IP. Supabase Auth provides additional SMS throttling.
      if (!allowOtp(req.params.userId + ":" + req.ip)) return res.status(429).json({ error: "Please try again later" });
      await startOtp(user);
      return res.status(202).json({ ok: true });
    } catch (error) {
      console.warn("[push-auth] SMS code could not be sent:", error?.message || error);
      return res.status(503).json({ error: "Phone verification is unavailable" });
    }
  });

  router.post("/api/users/:userId/push-otp/verify", async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: "Push notifications are not configured" });
    const code = String(req.body?.code || "");
    if (!/^\d{6}$/.test(code)) return res.status(400).json({ error: "Enter a six-digit code" });
    try {
      const user = await findUser(req.params.userId);
      if (!user) return res.status(404).json({ error: "Account not found" });
      const accessToken = await verifyOtp(user, code);
      res.setHeader("Cache-Control", "no-store");
      return res.json({ accessToken });
    } catch {
      return res.status(401).json({ error: "Invalid or expired verification code" });
    }
  });

  router.post("/api/users/:userId/push-subscriptions", async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: "Push notifications are not configured" });
    const endpoint = req.body?.endpoint;
    if (!validPushEndpoint(endpoint)) return res.status(400).json({ error: "Invalid push subscription endpoint" });
    try {
      const user = await findUser(req.params.userId);
      if (!user || !await authorize(user, req.get("authorization"))) {
        return res.status(403).json({ error: "Verified account required" });
      }
      await insert("push_subscriptions", [{ user_id: user.id, endpoint }], {
        query: { on_conflict: "endpoint" },
        prefer: "resolution=merge-duplicates,return=minimal",
      });
      return res.status(201).json({ ok: true });
    } catch (error) {
      console.warn("[push] could not save subscription:", error?.message || error);
      return res.status(503).json({ error: "Could not enable notifications" });
    }
  });

  router.delete("/api/users/:userId/push-subscriptions", async (req, res) => {
    if (!enabled()) return res.status(503).json({ error: "Push notifications are not configured" });
    const endpoint = req.body?.endpoint;
    if (!validPushEndpoint(endpoint)) return res.status(400).json({ error: "Invalid push subscription endpoint" });
    try {
      const user = await findUser(req.params.userId);
      if (!user || !await authorize(user, req.get("authorization"))) {
        return res.status(403).json({ error: "Verified account required" });
      }
      await remove("push_subscriptions", { user_id: "eq." + user.id, endpoint: "eq." + endpoint });
      return res.json({ ok: true });
    } catch {
      return res.status(503).json({ error: "Could not disable notifications" });
    }
  });

  return router;
}

export default createPushRouter();
