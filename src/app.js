import express from "express";
import cors from "cors";

import { FRONTEND_ORIGINS } from "./config.js";
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
