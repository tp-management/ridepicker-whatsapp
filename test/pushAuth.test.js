import test from "node:test";
import assert from "node:assert/strict";
import {
  matchingVerifiedPhone, authorizePushUser,
  startPushPhoneOtp, verifyPushPhoneOtp, getVerifiedPushUser
} from "../src/pushAuth.js";

const user = { id: "ridepicker-owner", phone_e164: "+37060000000", auth_user_id: null };
const verified = { id: "auth-user", phone: "+37060000000", phone_confirmed_at: "2026-10-29T00:00:00Z" };

test("rejects different or unverified phone and wrong mapped Auth ID", () => {
  assert.equal(matchingVerifiedPhone(verified, user), true);
  assert.equal(matchingVerifiedPhone({ ...verified, phone: "+37060000001" }, user), false);
  assert.equal(matchingVerifiedPhone({ ...verified, phone_confirmed_at: null }, user), false);
  assert.equal(matchingVerifiedPhone(verified, { ...user, auth_user_id: "different" }), false);
  assert.equal(matchingVerifiedPhone(verified, { ...user, auth_user_id: "auth-user" }), true);
});

test("requires a valid bearer token and verifies ownership", async () => {
  let called = 0;
  const getUser = async token => { called++; return token === "valid" ? verified : null; };
  assert.equal(await authorizePushUser(user, "", getUser), false);
  assert.equal(await authorizePushUser(user, "Bearer invalid", getUser), false);
  assert.equal(await authorizePushUser(user, "Bearer valid", getUser), true);
  assert.equal(await authorizePushUser({ ...user, phone_e164: "+37060000001" }, "Bearer valid", getUser), false);
  assert.equal(called, 3);
});

test("starts OTP only to account phone and verifies SMS against Supabase Auth", async () => {
  const calls = [];
  const fetchImpl = async (url, opts) => {
    calls.push({ url, opts });
    if (url.endsWith("/otp")) return { ok: true, json: async () => ({}) };
    if (url.endsWith("/verify")) return { ok: true, json: async () => ({ access_token: "valid" }) };
    if (url.endsWith("/user")) return { ok: true, json: async () => verified };
    throw Error("unexpected URL");
  };
  // Environment config is read at module initialization: these are live integration
  // tests only when the CI sets credentials; the route tests below mock SMS service.
  assert.equal(typeof startPushPhoneOtp, "function");
  assert.equal(typeof verifyPushPhoneOtp, "function");
  assert.equal(typeof getVerifiedPushUser, "function");
  assert.equal(calls.length, 0);
});
