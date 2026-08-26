const [
  { createApp },
  { PORT, SUPABASE_CONFIGURED },
  { recoverManagedSessions, shutdownManagedSessions },
  { markRuntimeReady, markRuntimeNotReady },
  { writeSystemLog },
] = await Promise.all([
  import("./src/app.js"),
  import("./src/config.js"),
  import("./src/whatsapp/restartRecovery.js"),
  import("./src/runtimeReadiness.js"),
  import("./src/systemLog.js"),
]);

const app = createApp();
let shuttingDown = false;

process.on("uncaughtExceptionMonitor", (error, origin) => {
  console.error(`[runtime] uncaught exception (${origin}):`, error);
  void writeSystemLog({
    level: "error",
    source: "runtime",
    event: "runtime_uncaught_exception",
    message: error?.message || "Uncaught exception",
    details: {
      origin,
      error,
      actionability: "actionable",
    },
  });
});

const server = app.listen(PORT, async () => {
  console.log(`RidePicker backend running on port ${PORT}`);
  console.log(
    `Supabase: ${SUPABASE_CONFIGURED ? "configured" : "not configured"}`
  );

  void writeSystemLog({
    level: "info",
    source: "runtime",
    event: "runtime_started",
    message: "RidePicker backend process started",
    details: {
      port: PORT,
      supabaseConfigured: SUPABASE_CONFIGURED,
    },
  });

  try {
    const results = await recoverManagedSessions();
    markRuntimeReady();
    console.log(
      `[whatsapp] restart recovery complete for ${results.length} durable session(s)`
    );
    void writeSystemLog({
      level: "info",
      source: "runtime",
      event: "restart_recovery_completed",
      message: "WhatsApp restart recovery completed",
      details: {
        durableSessions: results.length,
      },
    });
  } catch (error) {
    markRuntimeNotReady(error);
    console.error("WhatsApp restart recovery failed before readiness:", error);
    void writeSystemLog({
      level: "error",
      source: "runtime",
      event: "restart_recovery_failed",
      message: error.message,
      details: {
        error,
        actionability: "actionable",
      },
    });
  }
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  markRuntimeNotReady();

  console.log(`[runtime] ${signal} received, closing transports without logout`);
  void writeSystemLog({
    level: "info",
    source: "runtime",
    event: "runtime_shutdown_requested",
    message: `${signal} received; closing transports without logout`,
    details: {
      signal,
      authPreserved: true,
    },
  });

  try {
    await shutdownManagedSessions();
  } catch (error) {
    console.warn("[runtime] WhatsApp shutdown warning:", error.message);
    void writeSystemLog({
      level: "warning",
      source: "runtime",
      event: "runtime_shutdown_transport_warning",
      message: error.message,
      details: {
        signal,
        error,
        authPreserved: true,
      },
    });
  }

  const forceExit = setTimeout(() => {
    console.warn("[runtime] graceful shutdown timeout reached; forcing exit");
    void writeSystemLog({
      level: "warning",
      source: "runtime",
      event: "runtime_shutdown_forced",
      message: "Graceful shutdown timeout reached",
      details: {
        signal,
        timeoutMs: 2500,
        authPreserved: true,
      },
    });
    server.closeAllConnections?.();
    process.exit(0);
  }, 2_500);
  forceExit.unref?.();

  server.close(() => {
    clearTimeout(forceExit);
    process.exit(0);
  });
}

process.once("SIGTERM", () => void shutdown("SIGTERM"));
process.once("SIGINT", () => void shutdown("SIGINT"));
