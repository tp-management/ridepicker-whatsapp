// A fresh process also guarantees that administrative WhatsApp resets discard
// any ephemeral Baileys sockets and filesystem auth left in the old runtime.
import { applyWhatsappPairingHardening } from "./src/applyWhatsappPairingHardening.js";
import { applyWhatsappPairingHelloAck } from "./src/applyWhatsappPairingHelloAck.js";
import { applyWhatsappPairingUx } from "./src/applyWhatsappPairingUx.js";
import { applyWhatsappPairingFeedback } from "./src/applyWhatsappPairingFeedback.js";
import { applyWhatsappRemoteLogout } from "./src/applyWhatsappRemoteLogout.js";
import { applyBaileysRawLogging } from "./src/applyBaileysRawLogging.js";

applyWhatsappPairingHardening();
applyWhatsappPairingHelloAck();
applyWhatsappPairingUx();
applyWhatsappPairingFeedback();
applyWhatsappRemoteLogout();
applyBaileysRawLogging();

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
