import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, verify, createPublicKey } from "node:crypto";
import { pushConfigured, validPushEndpoint, vapidAuthorization, sendBigMoneyNotifications } from "../src/pushNotifications.js";

function keys() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const publicKey = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url");
  return { publicKey, privateKey: jwk.d, subject: "mailto:push@example.com" };
}

test("restrict subscription endpoints to supported push services", () => {
  assert.equal(validPushEndpoint("https://fcm.googleapis.com/fcm/send/test"), true);
  assert.equal(validPushEndpoint("https://web.push.apple.com/q/123"), true);
  assert.equal(validPushEndpoint("http://fcm.googleapis.com/fcm/send/test"), false);
  assert.equal(validPushEndpoint("https://127.0.0.1/test"), false);
  assert.equal(validPushEndpoint("https://fcm.googleapis.com.evil.example/test"), false);
});

test("creates an ES256 VAPID token for the push service origin", () => {
  const config = keys();
  assert.equal(pushConfigured(config), true);
  const auth = vapidAuthorization("https://fcm.googleapis.com/fcm/send/test", config, 1000000000);
  assert.match(auth, /^vapid t=[\w.-]+, k=[\w-]+$/);
  const jwt = auth.slice(8).split(", k=")[0];
  const [header, payload, signature] = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(header, "base64url").toString()).alg, "ES256");
  assert.deepEqual(JSON.parse(Buffer.from(payload, "base64url").toString()), {
    aud: "https://fcm.googleapis.com",
    exp: 1000000 + 43200,
    sub: "mailto:push@example.com",
  });
  const jwk = {
    kty: "EC", crv: "P-256",
    x: Buffer.from(config.publicKey, "base64url").subarray(1, 33).toString("base64url"),
    y: Buffer.from(config.publicKey, "base64url").subarray(33).toString("base64url"),
  };
  assert.equal(verify("sha256", Buffer.from(header + "." + payload), {
    key: createPublicKey({ key: jwk, format: "jwk" }), dsaEncoding: "ieee-p1363",
  }, Buffer.from(signature, "base64url")), true);
});

test("sends one payload-free push and removes expired subscription", async () => {
  const config = keys();
  const requests = [], deletions = [];
  const result = await sendBigMoneyNotifications("owner", {
    config,
    select: async () => [
      { id: 1, endpoint: "https://fcm.googleapis.com/fcm/send/one" },
      { id: 2, endpoint: "https://fcm.googleapis.com/fcm/send/expired" },
    ],
    remove: async (...args) => { deletions.push(args); return []; },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: url.endsWith("one"), status: url.endsWith("one") ? 201 : 410 };
    },
  });
  assert.deepEqual(result, { sent: 1, attempted: 2 });
  assert.equal(requests.length, 2);
  assert.equal(requests[0].options.body.byteLength, 0);
  assert.equal(requests[0].options.headers.Urgency, "high");
  assert.equal(deletions.length, 1);
});
