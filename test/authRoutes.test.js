import test from "node:test";
import assert from "node:assert/strict";

import { bootstrapRidePickerUser } from "../src/authRoutes.js";

function verifiedUser(id, phone) {
  return {
    id,
    phone,
    phone_confirmed_at: "2026-08-26T00:00:00.000Z",
  };
}

test("verified phone links an existing unowned RidePicker row", async () => {
  const updates = [];
  const existing = {
    id: "user-1",
    phone_e164: "+447700900123",
    auth_user_id: null,
  };
  const select = async (_table, query) => {
    if (query.auth_user_id) return [];
    if (query.phone_e164) return [existing];
    return [];
  };
  const update = async (_table, body, query) => {
    updates.push({ body, query });
    return [{ ...existing, ...body }];
  };
  const coreRepository = {
    async getUserById(id) {
      return { id, phone: existing.phone_e164 };
    },
  };
  const result = await bootstrapRidePickerUser({
    authUser: verifiedUser("auth-1", existing.phone_e164),
    select,
    update,
    coreRepository,
  });
  assert.equal(result.created, false);
  assert.equal(result.user.id, "user-1");
  assert.deepEqual(updates, [
    {
      body: { auth_user_id: "auth-1" },
      query: { id: "eq.user-1", auth_user_id: "is.null" },
    },
  ]);
});

test("unverified auth phone cannot bootstrap ownership", async () => {
  await assert.rejects(
    bootstrapRidePickerUser({
      authUser: { id: "auth-1", phone: "+447700900123" },
      select: async () => [],
      coreRepository: {},
    }),
    (error) =>
      error?.status === 403 &&
      error?.details?.code === "verified_phone_required"
  );
});

test("verified phone without a RidePicker profile requests profile setup", async () => {
  await assert.rejects(
    bootstrapRidePickerUser({
      authUser: verifiedUser("auth-new", "+447700900124"),
      select: async () => [],
      update: async () => [],
      coreRepository: {},
    }),
    (error) =>
      error?.status === 409 && error?.details?.code === "profile_required"
  );
});

test("profile setup creates then links the RidePicker account", async () => {
  const updates = [];
  const coreRepository = {
    async createUser(input) {
      assert.equal(input.name, "Alex Driver");
      assert.equal(input.phone, "+447700900125");
      return { id: "user-new" };
    },
    async getUserById(id) {
      return { id, name: "Alex Driver", phone: "+447700900125" };
    },
  };
  const result = await bootstrapRidePickerUser({
    authUser: verifiedUser("auth-new", "+447700900125"),
    name: "Alex Driver",
    select: async () => [],
    update: async (_table, body, query) => {
      updates.push({ body, query });
      return [{ id: "user-new", ...body }];
    },
    coreRepository,
  });
  assert.equal(result.created, true);
  assert.equal(result.user.id, "user-new");
  assert.deepEqual(updates, [
    {
      body: { auth_user_id: "auth-new" },
      query: { id: "eq.user-new", auth_user_id: "is.null" },
    },
  ]);
});

test("verified phone cannot steal an account linked to another auth subject", async () => {
  const existing = {
    id: "user-1",
    phone_e164: "+447700900126",
    auth_user_id: "auth-owner",
  };
  await assert.rejects(
    bootstrapRidePickerUser({
      authUser: verifiedUser("auth-attacker", existing.phone_e164),
      select: async (_table, query) =>
        query.auth_user_id ? [] : [existing],
      update: async () => {
        throw new Error("update must not run");
      },
      coreRepository: {},
    }),
    (error) =>
      error?.status === 409 && error?.details?.code === "phone_already_linked"
  );
});
