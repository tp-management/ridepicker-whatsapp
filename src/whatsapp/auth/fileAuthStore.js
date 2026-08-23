import fs from "fs";
import path from "path";
import { useMultiFileAuthState } from "@whiskeysockets/baileys";

import { DATA_DIR } from "../../config.js";

export function ensureFileAuthRoot() {
  fs.mkdirSync(DATA_DIR, {
    recursive: true,
  });
}

export function authPathFor(sessionId) {
  return path.join(DATA_DIR, sessionId);
}

export async function loadFileAuthState(sessionId) {
  return useMultiFileAuthState(authPathFor(sessionId));
}
