import express from "express";
import { repository } from "./repository.js";
import { insertRows, isSupabaseConfigured } from "./supabase.js";
import { pushConfigured, pushConfiguration, validPushEndpoint } from "./pushNotifications.js";

export function createPushRouter({
  findUser = (id) => repository.getUserById(id),
  insert = insertRows,
  configured = isSupabaseConfigured,
  pushConfig = pushConfiguration,
} = {}) {
  const router = express.Router();

  router.get("/api/push/public-key", (_req, res) => {
    const config = pushConfig();
    if (!pushConfigured(config)) return res.status(503).json({ error: "Push notifications are not configured" });
    res.setHeader("Cache-Control", "no-store");
    return res.json({ publicKey: config.publicKey });
  });

  router.post("/api/users/:userId/push-subscriptions", async (req, res) => {
    if (!configured()) return res.status(503).json({ error: "Database is not configured" });
    if (!pushConfigured(pushConfig())) return res.status(503).json({ error: "Push notifications are not configured" });
    const endpoint = req.body?.endpoint;
    if (!validPushEndpoint(endpoint)) return res.status(400).json({ error: "Invalid push subscription endpoint" });
    try {
      const user = await findUser(req.params.userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      // One endpoint can belong to only one current RidePicker user.
      await insert("push_subscriptions", [{ user_id: user.id, endpoint }], {
        query: { on_conflict: "endpoint" },
        prefer: "resolution=merge-duplicates,return=minimal",
      });
      return res.status(201).json({ ok: true });
    } catch (error) {
      console.error("[push] could not register subscription:", error?.message || error);
      return res.status(500).json({ error: "Could not enable notifications" });
    }
  });

  return router;
}

export default createPushRouter();
