import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { createWhatsappHarnessFromSource } from "./createWhatsappHarness.js";

export async function createCurrentWhatsappHarness({ forwardFromMe = false } = {}) {
  const tempRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "ridepicker-whatsapp-current-")
  );
  const source = await fs.readFile(
    path.join(process.cwd(), "src", "whatsapp.js"),
    "utf8"
  );

  return createWhatsappHarnessFromSource({
    source,
    tempRoot,
    forwardFromMe,
    cleanup: () => fs.rm(tempRoot, { recursive: true, force: true }),
  });
}
