import "dotenv/config";

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  return String(value).toLowerCase() === "true";
}

function parseCsv(value) {
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

export const PORT = Number(process.env.PORT) || 3001;


export const N8N_WEBHOOK_URL =
  process.env.N8N_WEBHOOK_URL || null;

export const N8N_FORWARD_SESSION_EVENTS = parseBoolean(
  process.env.N8N_FORWARD_SESSION_EVENTS,
  false
);

export const N8N_FORWARD_MEDIA_WITHOUT_TEXT = parseBoolean(
  process.env.N8N_FORWARD_MEDIA_WITHOUT_TEXT,
  false
);

export const N8N_FORWARD_FROM_ME = parseBoolean(
  process.env.N8N_FORWARD_FROM_ME,
  false
);

export const SUPABASE_URL =
  process.env.SUPABASE_URL || "";

export const SUPABASE_SERVICE_ROLE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY || "";

export const FRONTEND_ORIGINS = parseCsv(
  process.env.FRONTEND_ORIGINS ||
    "https://ride-picker.web.app,http://localhost:5173"
);

export const INTERNAL_API_KEY =
  process.env.INTERNAL_API_KEY || "";


export const SESSION_POLICY_CACHE_MS =
  Number(process.env.SESSION_POLICY_CACHE_MS) || 5000;

export const SUPABASE_CONFIGURED = Boolean(
  SUPABASE_URL && SUPABASE_SERVICE_ROLE_KEY
);
