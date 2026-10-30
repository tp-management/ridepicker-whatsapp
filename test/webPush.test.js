import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, createPublicKey, verify } from "node:crypto";
import { pushConfigured, validPushEndpoint, vapidAuthorization, sendBigMoneyPush } from "../src/webPush.js";

const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
const jwk = privateKey.export({ format: "jwk" });
const cfg = {
  publicKey: Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, "base64url"), Buffer.from(jwk.y, "base64url")]).toString("base64url"),
  privateKey: jwk.d, subject: "mailto:test@example.com",
};

test("only configured keys and real push endpoints are accepted", () => {
  assert.equal(pushConfigured(cfg), true);
  assert.equal(pushConfigured({ ...cfg, privateKey: "" }), false);
  assert.equal(validPushEndpoint("https://fcm.googleapis.com/fcm/send/abc"), true);
  assert.equal(validPushEndpoint("https://web.push.apple.com/q/abc"), true);
  assert.equal(validPushEndpoint("http://fcm.googleapis.com/test"), false);
  assert.equal(validPushEndpoint("https://fcm.googleapis.com.evil.test/fcm/send/x"), false);
  assert.equal(validPushEndpoint("https://127.0.0.1/private"), false);
});

test("signs a valid VAPID JWT for the destination push service", () => {
  const value = vapidAuthorization("https://fcm.googleapis.com/fcm/send/x", cfg, 1_000_000_000);
  const [token] = value.replace("vapid t=", "").split(", k=");
  const [h, p, s] = token.split(".");
  assert.equal(JSON.parse(Buffer.from(h, "base64url")).alg, "ES256");
  assert.equal(JSON.parse(Buffer.from(p, "base64url")).aud, "https://fcm.googleapis.com");
  assert.equal(verify("sha256", Buffer.from(h + "." + p), {
    key: createPublicKey({ format: "jwk", key: { kty: "EC", crv: "P-256", x: jwk.x, y: jwk.y } }),
    dsaEncoding: "ieee-p1363",
  }, Buffer.from(s, "base64url")), true);
});

test("sends empty payload to subscribed device and drops expired endpoints", async () => {
  const requests = [], deleted = [];
  const sent = await sendBigMoneyPush("owner", {
    config: cfg,
    select: async () => [
      { endpoint: "https://fcm.googleapis.com/fcm/send/one" },
      { endpoint: "https://fcm.googleapis.com/fcm/send/old" },
    ],
    remove: async (...args) => { deleted.push(args); return []; },
    fetchImpl: async (url, options) => {
      requests.push({ url, options });
      return { ok: url.endsWith("one"), status: url.endsWith("one") ? 201 : 410 };
    },
  });
  assert.deepEqual(sent, { sent: 1, attempted: 2 });
  assert.equal(requests[0].options.body.length, 0);
  assert.equal(deleted.length, 1);
});
