import express from "express";
import cors from "cors";

import { FRONTEND_ORIGINS } from "./config.js";
import assistPreferencesRouter from "./assistPreferencesRoutes.js";
import activityRouter from "./activityRoutes.js";
import healthRouter from "./healthRouter.js";
import liveEventsRouter, {
  installRepositoryLiveEvents,
  publishSuccessfulUserWrite,
} from "./liveEvents.js";
import userApiRouter from "./userApiRoutes.js";
import managedDisconnectRouter from "./whatsapp/managedDisconnectRouter.js";
import router from "./routes.js";

export function createApp() {
  installRepositoryLiveEvents();

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

  // Railway only moves traffic to a new container after restart recovery has
  // examined every durable WhatsApp session. The legacy /health route mounted
  // later remains unreachable because this router answers first.
  app.use(healthRouter);

  // One persistent server-sent event stream replaces periodic browser polling.
  // The stream carries only invalidation scopes, never database row contents.
  app.use(liveEventsRouter);

  // Successful user-facing mutations publish the smallest useful refresh
  // scope. Internal WhatsApp/session/message writes are covered by repository
  // hooks installed above, so background events are pushed too.
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
