import express from "express";
import cors from "cors";

import { FRONTEND_ORIGINS } from "./config.js";
import authRouter from "./authRoutes.js";
import { createApiSecurityMiddleware } from "./apiSecurity.js";
import userApiRouter from "./userApiRoutes.js";
import router from "./routes.js";

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

  // Verified phone authentication is the only unauthenticated account entry
  // point. Every /api/users/:userId request is then checked against the
  // Supabase Auth subject before the existing route handlers run.
  app.use(authRouter);
  app.use(createApiSecurityMiddleware());

  // User-facing data routes are mounted first so normalized reads (notably
  // preferences and activity-with-messages) own their paths. The legacy router
  // remains in place for existing endpoints and n8n/debug compatibility.
  app.use(userApiRouter);

  // Pairing lifecycle ownership belongs inside requestManagedPairingCode().
  // Do not reset a WhatsApp session in generic HTTP middleware: concurrent
  // POSTs, browser retries, or a double-click could otherwise destroy the
  // socket that another request is actively using to register a pairing code.
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
