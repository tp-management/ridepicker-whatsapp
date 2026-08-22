import { createApp } from "./src/app.js";
import {
  DATA_DIR,
  PORT,
  RAILWAY_VOLUME_MOUNT_PATH,
  SUPABASE_CONFIGURED,
} from "./src/config.js";
import { restoreSessions } from "./src/whatsapp.js";

const app = createApp();

app.listen(PORT, async () => {
  console.log(`RidePicker backend running on port ${PORT}`);
  console.log(
    `Supabase: ${SUPABASE_CONFIGURED ? "configured" : "not configured"}`
  );
  console.log(`WhatsApp auth directory: ${DATA_DIR}`);
  console.log(
    `Railway volume: ${
      RAILWAY_VOLUME_MOUNT_PATH
        ? `mounted at ${RAILWAY_VOLUME_MOUNT_PATH}`
        : "not detected"
    }`
  );

  if (process.env.RAILWAY_GIT_REPO_NAME && !RAILWAY_VOLUME_MOUNT_PATH) {
    console.warn(
      "Railway persistent volume is not attached. WhatsApp auth may be lost on redeploy/restart."
    );
  }

  try {
    await restoreSessions();
  } catch (error) {
    console.error("Failed to restore sessions:", error);
  }
});
