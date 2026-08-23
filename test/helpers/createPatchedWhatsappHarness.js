import { materializeCurrentPatchedWhatsapp } from "./materializePatchedWhatsapp.js";
import { createWhatsappHarnessFromSource } from "./createWhatsappHarness.js";

export async function createPatchedWhatsappHarness() {
  const materialized = await materializeCurrentPatchedWhatsapp();

  return createWhatsappHarnessFromSource({
    source: materialized.source,
    tempRoot: materialized.tempRoot,
    cleanup: materialized.cleanup,
  });
}
