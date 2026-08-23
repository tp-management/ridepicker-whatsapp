import express from "express";
import cors from "cors";

import { FRONTEND_ORIGINS } from "./config.js";
import assistPreferencesRouter from "./assistPreferencesRoutes.js";
import activityRouter from "./activityRoutes.js";
import liveEventsRouter, { publishSuccessfulUserWrite } from "./liveEvents.js";
import userApiRouter from "./userApiRoutes.js";
import managedDisconnectRouter from "./whatsapp/managedDisconnectRouter.js";
import router from "./routes.js";

export function createApp() {
  const app = express();

  app.disable("x-powered-by");

  app.use(
    cors({
      origin(origin, callback) {
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

  // One persistent server-sent event stream replaces periodic browser polling.
  // The stream carries only invalidation scopes, never database row contents.
  app.use(liveEventsRouter);

  // Any successful user-facing mutation publishes the smallest useful refresh
  // scope after the response has committed. Internal WhatsApp events publish
  // directly from src/whatsapp.js.
  app.use("/api/users/:userId", publishSuccessfulUserWrite);

  app.use(assistPreferencesRouter);
  app.use(activityRouter);
  app.use(userApiRouter);
  app.use(managedDisconnectRouter);
  app.use(router);

  app.use((error, req, res, next) => {
    if (error?.message === "Origin not allowed by CORS") {
      return res.status(403).json({ error: error.message });
    }

    next(error);
  });

  return app;
}
