import express from "express";

import {
  getSession,
  getSessions,
  startSession,
  sendText,
} from "./whatsapp.js";

const router = express.Router();

router.get(
  "/health",
  (req, res) => {
    res.json({
      ok: true,
      service:
        "ridepicker-whatsapp",
    });
  }
);

router.get(
  "/sessions",
  (req, res) => {
    res.json(
      getSessions()
    );
  }
);

router.post(
  "/sessions",
  async (req, res) => {
    try {
      const { id } = req.body;

      if (!id) {
        return res
          .status(400)
          .json({
            error:
              "id required",
          });
      }

      const session =
        await startSession(id);

      res.json({
        id,
        status:
          session.status,
      });
    } catch (error) {
      console.error(error);

      res.status(500).json({
        error:
          error.message,
      });
    }
  }
);

router.get(
  "/sessions/:id",
  (req, res) => {
    const session =
      getSession(
        req.params.id
      );

    if (!session) {
      return res
        .status(404)
        .json({
          error:
            "session not found",
        });
    }

    res.json({
      id:
        req.params.id,
      status:
        session.status,
      hasQr:
        Boolean(session.qr),
    });
  }
);

router.get(
  "/sessions/:id/qr",
  (req, res) => {
    const session =
      getSession(
        req.params.id
      );

    if (!session) {
      return res
        .status(404)
        .send(
          "Session not found"
        );
    }

    if (
      session.status ===
      "CONNECTED"
    ) {
      return res.send(`
        <html>
          <body style="
            font-family: Arial;
            display: grid;
            place-items: center;
            height: 100vh;
          ">
            <h1>
              WhatsApp connected ✅
            </h1>
          </body>
        </html>
      `);
    }

    if (!session.qr) {
      return res.send(`
        <html>
          <body style="
            font-family: Arial;
            display: grid;
            place-items: center;
            height: 100vh;
          ">
            <h2>
              QR dar generuojamas.
              Refresh po kelių sekundžių.
            </h2>
          </body>
        </html>
      `);
    }

    res.send(`
      <html>
        <body style="
          font-family: Arial;
          display: grid;
          place-items: center;
          height: 100vh;
          background: #111;
          color: white;
        ">
          <div style="
            text-align: center;
          ">
            <h2>
              Connect WhatsApp
            </h2>

            <img
              src="${session.qr}"
              width="400"
              style="
                background: white;
                padding: 20px;
                border-radius: 20px;
              "
            />

            <p>
              WhatsApp →
              Linked devices →
              Link a device
            </p>
          </div>
        </body>
      </html>
    `);
  }
);

router.post(
  "/send",
  async (req, res) => {
    try {
      const {
        session,
        chatId,
        text,
      } = req.body;

      const result =
        await sendText({
          sessionId:
            session,
          chatId,
          text,
        });

      res.json({
        ok: true,
        id:
          result?.key?.id ||
          null,
      });
    } catch (error) {
      console.error(error);

      res
        .status(400)
        .json({
          error:
            error.message,
        });
    }
  }
);

export default router;
