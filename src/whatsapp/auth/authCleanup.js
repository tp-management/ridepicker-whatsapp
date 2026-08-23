import fs from "fs";

import { authPathFor } from "./fileAuthStore.js";

export function removeAuthDirectory(sessionId) {
  const authPath = authPathFor(sessionId);

  try {
    fs.rmSync(authPath, {
      recursive: true,
      force: true,
    });
  } catch (error) {
    console.warn(
      `[${sessionId}] could not remove auth directory:`,
      error.message
    );
  }
}
