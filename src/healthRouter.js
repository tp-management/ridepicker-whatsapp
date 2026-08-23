import express from "express";

import { getRuntimeReadiness } from "./runtimeReadiness.js";
import { isSupabaseConfigured } from "./supabase.js";

const router = express.Router();

router.get("/health", (req, res) => {
  const runtime = getRuntimeReadiness();
  const supabaseConfigured = isSupabaseConfigured();
  const ok = runtime.ready && supabaseConfigured;

  res.status(ok ? 200 : 503).json({
    ok,
    service: "ridepicker-whatsapp",
    supabaseConfigured,
    ready: runtime.ready,
    ...(runtime.recoveryError ? { recoveryError: runtime.recoveryError } : {}),
  });
});

export default router;
