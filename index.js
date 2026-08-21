import { createApp } from "./src/app.js";
import { PORT, SUPABASE_CONFIGURED } from "./src/config.js";
import { restoreSessions } from "./src/whatsapp.js";

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
