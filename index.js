const [{ createApp }, { PORT, SUPABASE_CONFIGURED }, { restoreSessions }] =
  await Promise.all([
    import("./src/app.js"),
    import("./src/config.js"),
    import("./src/whatsapp.js"),
  ]);

const app = createApp();

app.listen(PORT, async () => {
  console.log(`RidePicker backend running on port ${PORT}`);
  console.log(
    `Supabase: ${SUPABASE_CONFIGURED ? "configured" : "not configured"}`
  );

  try {
    await restoreSessions();
  } catch (error) {
    console.error("Failed to restore sessions:", error);
  }
});
