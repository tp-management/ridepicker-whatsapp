// Payload-free Web Push: the service worker supplies the fixed notification text.
// No new dependency or encrypted job content is needed to wake a closed app.
import { createPrivateKey, sign } from "node:crypto";
import { selectRows, deleteRows } from "./supabase.js";

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || "";
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || "";
const SUBJECT = process.env.VAPID_SUBJECT || "";
const MAX_ENDPOINT_LENGTH = 2048;

// Only known push-service hosts, to prevent a browser-supplied URL becoming SSRF.
export function validPushEndpoint(value) {
  if (typeof value !== "string" || value.length > MAX_ENDPOINT_LENGTH) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")) return false;
    const host = url.hostname.toLowerCase();
    return host === "fcm.googleapis.com"
      || host === "updates.push.services.mozilla.com"
      || host === "web.push.apple.com"
      || host.endsWith(".notify.windows.com");
  } catch {
    return false;
  }
}

export function pushConfiguration() {
  return { publicKey: PUBLIC_KEY, privateKey: PRIVATE_KEY, subject: SUBJECT };
}

export function pushConfigured(config = pushConfiguration()) {
  if (!config.subject || !/^(mailto:|https:\/\/)/.test(config.subject)) return false;
  const pub = Buffer.from(config.publicKey || "", "base64url");
  const priv = Buffer.from(config.privateKey || "", "base64url");
  return pub.length === 65 && pub[0] === 4 && priv.length === 32;
}

export function vapidAuthorization(endpoint, config = pushConfiguration(), nowMs = Date.now()) {
  if (!validPushEndpoint(endpoint) || !pushConfigured(config)) throw new Error("Invalid Web Push configuration or endpoint");
  const pub = Buffer.from(config.publicKey, "base64url");
  const key = createPrivateKey({
    key: {
      kty: "EC",
      crv: "P-256",
      x: pub.subarray(1, 33).toString("base64url"),
      y: pub.subarray(33).toString("base64url"),
      d: config.privateKey,
    },
    format: "jwk",
  });
  const header = Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(nowMs / 1000) + 12 * 60 * 60,
    sub: config.subject,
  })).toString("base64url");
  const unsigned = header + "." + payload;
  const signature = sign("sha256", Buffer.from(unsigned), {
    key,
    dsaEncoding: "ieee-p1363",
  }).toString("base64url");
  return "vapid t=" + unsigned + "." + signature + ", k=" + config.publicKey;
}

export async function sendBigMoneyNotifications(userId, {
  select = selectRows,
  remove = deleteRows,
  fetchImpl = fetch,
  config = pushConfiguration(),
} = {}) {
  if (!pushConfigured(config)) return { sent: 0, disabled: true };
  const subscriptions = await select("push_subscriptions", {
    select: "id,endpoint",
    user_id: "eq." + userId,
    limit: 100,
  });
  const results = await Promise.allSettled(subscriptions.map(async (sub) => {
    if (!validPushEndpoint(sub.endpoint)) return "invalid";
    const response = await fetchImpl(sub.endpoint, {
      method: "POST",
      headers: {
        TTL: "300",
        Urgency: "high",
        Authorization: vapidAuthorization(sub.endpoint, config),
      },
      body: new Uint8Array(0),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404 || response.status === 410) {
      await remove("push_subscriptions", { id: "eq." + sub.id, user_id: "eq." + userId });
      return "expired";
    }
    if (!response.ok) throw new Error("Push provider returned HTTP " + response.status);
    return "sent";
  }));
  let sent = 0;
  for (const result of results) {
    if (result.status === "fulfilled" && result.value === "sent") sent++;
    else if (result.status === "rejected") console.warn("[big-money-push] provider error:", result.reason?.message || result.reason);
  }
  return { sent, attempted: subscriptions.length };
}
