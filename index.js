const [
  { createApp },
  { PORT, SUPABASE_CONFIGURED },
  { recoverManagedSessions, shutdownManagedSessions },
  { markRuntimeReady, markRuntimeNotReady },
] = await Promise.all([
  import("./src/app.js"),
  import("./src/config.js"),
  import("./src/whatsapp/restartRecovery.js"),
  import("./src/runtimeReadiness.js"),
]);

const app = createApp();
let shuttingDown = false;

const server = app.listen(PORT, async () => {
  console.log(`RidePicker backend running on port ${PORT}`);
  console.log(
    `Supabase: ${SUPABASE_CONFIGURED ? "configured" : "not configured"}`
  );

  try {
    const results = await recoverManagedSessions();
    markRuntimeReady();
    console.log(
      `[whatsapp] restart recovery complete for ${results.length} durable session(s)`
    );
  } catch (error) {
    markRuntimeNotReady(error);
    console.error("WhatsApp restart recovery failed before readiness:", error);
  }
});

async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  markRuntimeNotReady();

  console.log(`[runtime] ${signal} received, closing transports without logout`);

  try {
    await shutdownManagedSessions();
  } catch (error) {
    console.warn("[runtime] WhatsApp shutdown warning:", error.message);
  }

  const forceExit = setTimeout(() => {
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
