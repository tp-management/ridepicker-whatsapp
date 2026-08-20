import "dotenv/config";

export const PORT =
  Number(process.env.PORT) || 3001;

export const DATA_DIR =
  process.env.DATA_DIR || "./data";

export const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL || null;