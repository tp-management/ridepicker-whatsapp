import { createApp } from "./src/app.js";
import { PORT } from "./src/config.js";
import { restoreSessions } from "./src/whatsapp.js";

const app = createApp();

app.listen(PORT, async () => {
  console.log(`RidePicker WhatsApp API running on port ${PORT}`);

  try {
    await restoreSessions();
  } catch (error) {
    console.error("Failed to restore sessions:", error);
  }
});
