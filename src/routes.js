import express from "express";

import {
  getSession,
  getSessions,
  startSession,
  sendText,
} from "./whatsapp.js";

const router = express.Router();

/**
 * Health
 */
router.get("/health", (req, res) => {
  res.json({
    ok: true,
    service: "ridepicker-whatsapp",
  });
});

/**
 * List sessions
 */
router.get("/sessions", (req, res) => {
  res.json(getSessions());
});

/**
 * Create / start session
 */
router.post("/sessions", async (req, res) => {
  try {
    const { id } = req.body;

    if (!id) {
      return res.status(400).json({
        error: "id required",
      });
    }

    const session = await startSession(id);

    res.json({
      id,
      status: session.status,
    });
  } catch (error) {
    console.error(error);

    res.status(500).json({
      error: error.message,
    });
  }
});

/**
 * Session status
 */
router.get("/sessions/:id", (req, res) => {
  const session = getSession(req.params.id);

  if (!session) {
    return res.status(404).json({
      error: "session not found",
    });
  }

  res.json({
    id: req.params.id,
    status: session.status,
    hasQr: Boolean(session.qr),
  });
});

/**
 * Raw QR/status endpoint used by the connect page.
 *
 * The browser polls this endpoint.
 * Whenever Baileys generates a new QR,
 * session.qr automatically contains the newest one.
 */
router.get("/sessions/:id/qr-data", (req, res) => {
  const session = getSession(req.params.id);

  if (!session) {
    return res.status(404).json({
      error: "session not found",
    });
  }

  res.setHeader("Cache-Control", "no-store");

  res.json({
    id: req.params.id,
    status: session.status,
    qr: session.qr || null,
  });
});

/**
 * Persistent WhatsApp connect page.
 *
 * This URL itself does not expire.
 * It continuously polls /qr-data and replaces
 * expired WhatsApp QR codes automatically.
 */
router.get("/sessions/:id/qr", (req, res) => {
  const sessionId = req.params.id;

  res.setHeader("Cache-Control", "no-store");

  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />

  <meta
    name="viewport"
    content="width=device-width, initial-scale=1.0"
  />

  <title>Connect WhatsApp | RidePicker</title>

  <style>
    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      min-height: 100vh;

      display: flex;
      align-items: center;
      justify-content: center;

      padding: 24px;

      font-family:
        Inter,
        Arial,
        Helvetica,
        sans-serif;

      background: #0f1115;
      color: #ffffff;
    }

    .card {
      width: 100%;
      max-width: 520px;

      padding: 38px;

      border: 1px solid #262b35;
      border-radius: 24px;

      background: #171a21;

      text-align: center;
    }

    .logo {
      font-size: 38px;
      margin-bottom: 8px;
    }

    h1 {
      margin: 0;

      font-size: 28px;
      font-weight: 700;
    }

    .subtitle {
      margin-top: 10px;
      margin-bottom: 28px;

      color: #9ba3b2;
      line-height: 1.5;
    }

    #qr-container {
      min-height: 350px;

      display: flex;
      align-items: center;
      justify-content: center;
    }

    #qr {
      display: none;

      width: 100%;
      max-width: 340px;

      padding: 18px;

      border-radius: 18px;

      background: #ffffff;
    }

    #spinner {
      width: 42px;
      height: 42px;

      border: 4px solid #333945;
      border-top-color: #25d366;

      border-radius: 50%;

      animation: spin 0.8s linear infinite;
    }

    @keyframes spin {
      to {
        transform: rotate(360deg);
      }
    }

    #status {
      margin-top: 24px;

      font-size: 16px;
      font-weight: 600;
    }

    .hint {
      margin-top: 18px;

      color: #7f8794;
      font-size: 14px;
      line-height: 1.6;
    }

    .success {
      color: #25d366;
    }

    .warning {
      color: #f6c344;
    }

    .error {
      color: #ff6161;
    }

    .connected-icon {
      display: none;

      font-size: 72px;
    }
  </style>
</head>

<body>
  <div class="card">
    <div class="logo">🤖</div>

    <h1>Connect WhatsApp</h1>

    <div class="subtitle">
      Connect your WhatsApp account to RidePicker.
    </div>

    <div id="qr-container">
      <div id="spinner"></div>

      <img
        id="qr"
        alt="WhatsApp QR code"
      />

      <div
        id="connected-icon"
        class="connected-icon"
      >
        ✅
      </div>
    </div>

    <div id="status">
      Generating QR...
    </div>

    <div class="hint">
      WhatsApp
      →
      Linked devices
      →
      Link a device
      <br />
      <br />
      Keep this page open.
      Expired QR codes refresh automatically.
    </div>
  </div>

  <script>
    const sessionId =
      ${JSON.stringify(sessionId)};

    const qr =
      document.getElementById("qr");

    const spinner =
      document.getElementById("spinner");

    const status =
      document.getElementById("status");

    const connectedIcon =
      document.getElementById(
        "connected-icon"
      );

    let lastQr = null;
    let stopped = false;

    function showLoading(message) {
      spinner.style.display = "block";
      qr.style.display = "none";

      connectedIcon.style.display =
        "none";

      status.className = "";
      status.textContent = message;
    }

    function showQr(qrData) {
      spinner.style.display = "none";

      connectedIcon.style.display =
        "none";

      qr.style.display = "block";

      if (lastQr !== qrData) {
        qr.src = qrData;
        lastQr = qrData;
      }

      status.className = "";
      status.textContent =
        "Scan this QR with WhatsApp";
    }

    function showConnected() {
      stopped = true;

      spinner.style.display = "none";
      qr.style.display = "none";

      connectedIcon.style.display =
        "block";

      status.className = "success";

      status.textContent =
        "WhatsApp connected";
    }

    function showError(message) {
      spinner.style.display = "none";
      qr.style.display = "none";

      connectedIcon.style.display =
        "none";

      status.className = "error";
      status.textContent = message;
    }

    async function refreshQr() {
      if (stopped) {
        return;
      }

      try {
        const response = await fetch(
          "/sessions/" +
            encodeURIComponent(sessionId) +
            "/qr-data",
          {
            cache: "no-store",
          }
        );

        if (!response.ok) {
          if (response.status === 404) {
            showLoading(
              "Starting WhatsApp session..."
            );

            await fetch("/sessions", {
              method: "POST",

              headers: {
                "Content-Type":
                  "application/json",
              },

              body: JSON.stringify({
                id: sessionId,
              }),
            });

            return;
          }

          throw new Error(
            "HTTP " + response.status
          );
        }

        const data =
          await response.json();

        if (
          data.status === "CONNECTED"
        ) {
          showConnected();
          return;
        }

        if (data.qr) {
          showQr(data.qr);
          return;
        }

        if (
          data.status === "RECONNECTING"
        ) {
          showLoading(
            "Refreshing connection..."
          );

          return;
        }

        if (
          data.status === "LOGGED_OUT"
        ) {
          showError(
            "Session logged out. Start a new session."
          );

          return;
        }

        showLoading(
          "Generating fresh QR..."
        );
      } catch (error) {
        console.error(error);

        status.className = "warning";

        status.textContent =
          "Connection interrupted. Retrying...";
      }
    }

    refreshQr();

    setInterval(
      refreshQr,
      1500
    );
  </script>
</body>
</html>
  `);
});

/**
 * Send WhatsApp message
 */
router.post("/send", async (req, res) => {
  try {
    const {
      session,
      chatId,
      text,
    } = req.body;

    const result = await sendText({
      sessionId: session,
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

    res.status(400).json({
      error: error.message,
    });
  }
});

export default router;