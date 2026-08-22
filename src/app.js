import express from "express";
import cors from "cors";

import { FRONTEND_ORIGINS } from "./config.js";
import { repository } from "./repository.js";
import router from "./routes.js";
import { isSupabaseConfigured } from "./supabase.js";
import { disconnectSession } from "./whatsapp.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");

  app.use(
    cors({
      origin(origin, callback) {
        // Allow server-to-server requests and local CLI/curl calls without Origin.
        if (!origin) {
          return callback(null, true);
        }

        if (
          FRONTEND_ORIGINS.length === 0 ||
          FRONTEND_ORIGINS.includes(origin)
        ) {
          return callback(null, true);
        }

        return callback(new Error("Origin not allowed by CORS"));
      },
      credentials: false,
    })
  );

  app.use(
    express.json({
      limit: "1mb",
    })
  );

  // WhatsApp can be removed remotely from the phone's Linked Devices screen.
  // In that case Supabase is already LOGGED_OUT/DISCONNECTED, while an old
  // Baileys object in this process can still have registered=true. Clean that
  // stale runtime/auth state before the existing pairing-code route runs so a
  // fresh code can be generated immediately without a manual backend restart.
  app.use(async (req, res, next) => {
    if (req.method !== "POST" || !isSupabaseConfigured()) {
      return next();
    }

    const match = req.path.match(
      /^\/api\/users\/([^/]+)\/whatsapp\/pairing-code\/?$/
    );

    if (!match) {
      return next();
    }

    try {
      const dbSession = await repository.getWhatsappSessionByUser(match[1]);

      if (
        dbSession &&
        ["LOGGED_OUT", "DISCONNECTED"].includes(dbSession.status)
      ) {
        await disconnectSession(dbSession.id);
      }
    } catch (error) {
      // Let the existing route produce its normal API error response if the
      // database is temporarily unavailable. This pre-clean must not replace
      // the established error contract.
      console.error(
        "[whatsapp] pre-pairing stale session cleanup failed:",
        error.message
      );
    }

    next();
  });

  app.use(router);

  app.use((error, req, res, next) => {
    if (error?.message === "Origin not allowed by CORS") {
      return res.status(403).json({
        error: error.message,
      });
    }

    next(error);
  });

  return app;
}
