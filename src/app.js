import express from "express";
import cors from "cors";

import { FRONTEND_ORIGINS } from "./config.js";
import userApiRouter from "./userApiRoutes.js";
import managedDisconnectRouter from "./whatsapp/managedDisconnectRouter.js";
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

  // User-facing data routes are mounted first so normalized reads (notably
  // preferences and activity-with-messages) own their paths.
  app.use(userApiRouter);

  // A user-requested WhatsApp disconnect must remote-unlink the linked device
  // before durable auth is cleared. Mount this exact route before the legacy
  // router so no older disconnect implementation can bypass that invariant.
  app.use(managedDisconnectRouter);

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
