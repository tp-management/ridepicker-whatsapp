// Push registration requires proof of control of the actual RidePicker phone.
// Existing legacy sign-in only looks up a phone; its user ID alone is not authentication.
import { SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY } from "./config.js";

async function authRequest(path, { method = "GET", body, token, fetchImpl = fetch } = {}) {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) throw new Error("Supabase Auth not configured");
  const res = await fetchImpl(SUPABASE_URL.replace(/\/$/, "") + "/auth/v1/" + path, {
    method,
    headers: {
      apikey: SUPABASE_SERVICE_ROLE_KEY,
      ...(token ? { Authorization: "Bearer " + token } : {}),
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(10000),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = new Error(data.msg || data.error_description || data.message || "Phone verification failed");
    error.status = res.status;
    throw error;
  }
  return data;
}

export function matchingVerifiedPhone(authUser, ridepickerUser) {
  if (!authUser?.id || !authUser?.phone_confirmed_at) return false;
  if (!authUser.phone || !ridepickerUser?.phone_e164) return false;
  if (authUser.phone !== ridepickerUser.phone_e164) return false;
  if (ridepickerUser.auth_user_id && String(ridepickerUser.auth_user_id) !== String(authUser.id)) return false;
  return true;
}

export async function startPushPhoneOtp(user, opts = {}) {
  if (!/^\+[1-9]\d{6,14}$/.test(user?.phone_e164 || "")) {
    throw Object.assign(new Error("Invalid account phone number"), { status: 400 });
  }
  // Supabase Auth controls SMS rate-limits and token expiration.
  return authRequest("otp", { method: "POST", body: { phone: user.phone_e164, create_user: true }, ...opts });
}

export async function verifyPushPhoneOtp(user, code, opts = {}) {
  if (!/^\d{6}$/.test(code || "")) {
    throw Object.assign(new Error("Enter the six-digit code"), { status: 400 });
  }
  const result = await authRequest("verify", {
    method: "POST",
    body: { phone: user.phone_e164, token: code, type: "sms" },
    ...opts,
  });
  if (!result.access_token) throw new Error("Verification did not return a session");
  const confirmed = await getVerifiedPushUser(result.access_token, opts);
  if (!matchingVerifiedPhone(confirmed, user)) {
    throw Object.assign(new Error("The verified phone does not match this account"), { status: 403 });
  }
  return result.access_token;
}

export async function getVerifiedPushUser(accessToken, opts = {}) {
  if (!accessToken || typeof accessToken !== "string" || accessToken.length > 8192) return null;
  try {
    return await authRequest("user", { token: accessToken, ...opts });
  } catch {
    return null;
  }
}

export async function authorizePushUser(ridepickerUser, header, getUser = getVerifiedPushUser) {
  const match = /^Bearer\s+([^\s]+)$/.exec(header || "");
  if (!match) return false;
  const user = await getUser(match[1]);
  return matchingVerifiedPhone(user, ridepickerUser);
}
