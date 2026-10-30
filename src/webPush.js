// Web Push with an empty payload: the service worker supplies a fixed message.
// Node crypto handles VAPID signing; no new dependency, SMS, or retry worker.
import { createPrivateKey, sign } from "node:crypto";
import { selectRows, deleteRows } from "./supabase.js";

export function pushConfiguration() {
  return {
    publicKey: process.env.VAPID_PUBLIC_KEY || "",
    privateKey: process.env.VAPID_PRIVATE_KEY || "",
    subject: process.env.VAPID_SUBJECT || "",
  };
}

export function pushConfigured(config = pushConfiguration()) {
  const pub = Buffer.from(config.publicKey || "", "base64url");
  const priv = Buffer.from(config.privateKey || "", "base64url");
  return pub.length === 65 && pub[0] === 4 && priv.length === 32
    && /^(mailto:|https:\/\/)/.test(config.subject || "");
}

// Limit push delivery to real push-service endpoints (never arbitrary servers).
export function validPushEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length > 2048) return false;
  try {
    const url = new URL(endpoint);
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

export function vapidAuthorization(endpoint, config = pushConfiguration(), now = Date.now()) {
  if (!pushConfigured(config) || !validPushEndpoint(endpoint)) throw new Error("Invalid VAPID or push endpoint");
  const pub = Buffer.from(config.publicKey, "base64url");
  const privateKey = createPrivateKey({
    format: "jwk",
    key: {
      kty: "EC", crv: "P-256",
      x: pub.subarray(1, 33).toString("base64url"),
      y: pub.subarray(33).toString("base64url"),
      d: config.privateKey,
    },
  });
  const header = Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    aud: new URL(endpoint).origin,
    exp: Math.floor(now / 1000) + 12 * 60 * 60,
    sub: config.subject,
  })).toString("base64url");
  const unsigned = header + "." + payload;
  const sig = sign("sha256", Buffer.from(unsigned), { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
  return "vapid t=" + unsigned + "." + sig + ", k=" + config.publicKey;
}

export async function sendBigMoneyPush(userId, {
  config = pushConfiguration(),
  select = selectRows,
  remove = deleteRows,
  fetchImpl = fetch,
} = {}) {
  if (!pushConfigured(config)) return { sent: 0, disabled: true };
  const devices = await select("push_subscriptions", {
    select: "endpoint",
    user_id: "eq." + userId,
    limit: 100,
  });
  const results = await Promise.allSettled(devices.map(async ({ endpoint }) => {
    if (!validPushEndpoint(endpoint)) return false;
    const response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        TTL: "300",
        Urgency: "high",
        Authorization: vapidAuthorization(endpoint, config),
      },
      body: new Uint8Array(0),
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
    if (response.status === 404 || response.status === 410) {
      await remove("push_subscriptions", { endpoint: "eq." + endpoint, user_id: "eq." + userId });
      return false;
    }
    if (!response.ok) throw new Error("Push service HTTP " + response.status);
    return true;
  }));
  const sent = results.filter((r) => r.status === "fulfilled" && r.value).length;
  for (const result of results) {
    if (result.status === "rejected") console.warn("[big-money-push] Send failed:", result.reason?.message || result.reason);
  }
  return { sent, attempted: devices.length };
}
