import {
  INTERNAL_API_KEY,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "./config.js";
import { selectRows } from "./supabase.js";

function httpError(status, message, details = null) {
  const error = new Error(message);
  error.status = status;
  if (details) error.details = details;
  return error;
}

function requestPath(req) {
  return String(req?.path || req?.url || "").split("?")[0];
}

function bearerToken(req) {
  const header = String(req?.get?.("authorization") || req?.headers?.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] || null;
}

function sendError(res, error) {
  return res.status(error?.status || 500).json({
    error: error?.message || "Unexpected error",
    ...(error?.details ? { details: error.details } : {}),
  });
}

export async function verifySupabaseAccessToken(
  token,
  { fetchImpl = fetch } = {}
) {
  if (!token) {
    throw httpError(401, "authentication required");
  }

  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
    throw httpError(503, "Supabase authentication is not configured");
  }

  const response = await fetchImpl(
    `${SUPABASE_URL.replace(/\/$/, "")}/auth/v1/user`,
    {
      method: "GET",
      headers: {
        Accept: "application/json",
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${token}`,
      },
    }
  );

  if (!response.ok) {
    throw httpError(401, "invalid or expired authentication token");
  }

  const user = await response.json();
  if (!user?.id) {
    throw httpError(401, "invalid authentication token");
  }

  return user;
}

export async function authenticateRequest(req, options = {}) {
  return verifySupabaseAccessToken(bearerToken(req), options);
}

export function requireInternalApiKey(req, res, next) {
  if (!INTERNAL_API_KEY) {
    return res.status(503).json({
      error: "INTERNAL_API_KEY is not configured",
    });
  }

  const key = req.get("x-api-key") || req.get("x-ridepicker-key");
  if (key !== INTERNAL_API_KEY) {
    return res.status(401).json({
      error: "invalid API key",
    });
  }

  next();
}

export function createApiSecurityMiddleware({
  authenticate = authenticateRequest,
  select = selectRows,
} = {}) {
  return async function apiSecurity(req, res, next) {
    const path = requestPath(req);

    if (path === "/health" || path.startsWith("/api/auth/")) {
      return next();
    }

    if (
      path === "/send" ||
      path === "/sessions" ||
      path.startsWith("/sessions/")
    ) {
      return requireInternalApiKey(req, res, next);
    }

    // Legacy phone lookup/account creation were intentionally unauthenticated
    // during the prototype. Real phone verification now lives under /api/auth.
    if (path === "/api/users" || path.startsWith("/api/users/by-phone/")) {
      return res.status(410).json({
        error: "This account endpoint has been replaced by verified phone authentication.",
      });
    }

    const match = /^\/api\/users\/([^/]+)(?:\/|$)/.exec(path);
    if (!match) {
      return next();
    }

    try {
      const userId = decodeURIComponent(match[1]);
      const authUser = await authenticate(req);
      const rows = await select("users", {
        select: "id,auth_user_id",
        id: `eq.${userId}`,
        limit: 1,
      });
      const ridePickerUser = Array.isArray(rows) && rows.length ? rows[0] : null;

      if (!ridePickerUser) {
        throw httpError(404, "user not found");
      }

      if (!ridePickerUser.auth_user_id) {
        throw httpError(403, "RidePicker account is not linked to an authenticated user", {
          code: "account_not_linked",
        });
      }

      if (String(ridePickerUser.auth_user_id) !== String(authUser.id)) {
        throw httpError(403, "forbidden");
      }

      req.authUser = authUser;
      req.ridePickerUserId = ridePickerUser.id;

      if (
        req.method === "POST" &&
        /^\/api\/users\/[^/]+\/billing\/(?:activate|cancel|reactivate)$/.test(path)
      ) {
        throw httpError(
          403,
          "Billing state can only be changed by the payment-provider workflow",
          { code: "billing_provider_required" }
        );
      }

      return next();
    } catch (error) {
      return sendError(res, error);
    }
  };
}
