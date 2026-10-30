import express from "express";
import { repository } from "./repository.js";
import { insertRows, isSupabaseConfigured } from "./supabase.js";
import { pushConfigured, pushConfiguration, validPushEndpoint } from "./webPush.js";

// Uses RidePicker's existing user IDs for the small test rollout.
// The account login itself is not cryptographically verified yet.
export function createPushRouter({
  findUser = (id) => repository.getUserById(id),
  insert = insertRows,
  configured = isSupabaseConfigured,
  pushConfig = pushConfiguration,
} = {}) {
  const router = express.Router();

  router.get("/api/push/public-key", (_req, res) => {
    const config = pushConfig();
    if (!pushConfigured(config)) return res.status(503).json({ error: "Push is not configured" });
    res.setHeader("Cache-Control", "no-store");
    res.json({ publicKey: config.publicKey });
  });

  router.post("/api/users/:userId/push-subscriptions", async (req, res) => {
    if (!configured() || !pushConfigured(pushConfig())) {
      return res.status(503).json({ error: "Push is not configured" });
    }
    const endpoint = req.body?.endpoint;
    if (!validPushEndpoint(endpoint)) return res.status(400).json({ error: "Invalid push endpoint" });
    try {
      const user = await findUser(req.params.userId);
      if (!user) return res.status(404).json({ error: "User not found" });
      await insert("push_subscriptions", [{ user_id: user.id, endpoint }], {
        query: { on_conflict: "endpoint" },
        prefer: "resolution=merge-duplicates,return=minimal",
      });
      res.status(201).json({ ok: true });
    } catch (error) {
      console.warn("[push] Subscription failed:", error?.message || error);
      res.status(503).json({ error: "Could not enable push" });
    }
  });
  return router;
}

export default createPushRouter();
