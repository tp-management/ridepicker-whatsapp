import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";

import {
  __apiSecurity,
  createApiSecurityMiddleware,
} from "../src/apiSecurity.js";

function responseRecorder() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function runMiddleware(middleware, req) {
  const res = responseRecorder();
  let nextCalled = false;
  await middleware(req, res, () => {
    nextCalled = true;
  });
  return { res, nextCalled };
}

test("owned user API request reaches the route handler", async () => {
  const middleware = createApiSecurityMiddleware({
    authenticate: async () => ({ id: "auth-1" }),
    select: async () => [{ id: "user-1", auth_user_id: "auth-1" }],
  });
  const { res, nextCalled } = await runMiddleware(middleware, {
    method: "GET",
    path: "/api/users/user-1/activity",
  });
  assert.equal(nextCalled, true);
  assert.equal(res.statusCode, 200);
});

test("SSE endpoint is covered by the same ownership rule", async () => {
  const middleware = createApiSecurityMiddleware({
    authenticate: async () => ({ id: "auth-attacker" }),
    select: async () => [{ id: "user-1", auth_user_id: "auth-owner" }],
  });
  const { res, nextCalled } = await runMiddleware(middleware, {
    method: "GET",
    path: "/api/users/user-1/events",
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
});

test("another authenticated user cannot access a foreign user id", async () => {
  const middleware = createApiSecurityMiddleware({
    authenticate: async () => ({ id: "auth-attacker" }),
    select: async () => [{ id: "user-1", auth_user_id: "auth-owner" }],
  });
  const { res, nextCalled } = await runMiddleware(middleware, {
    method: "GET",
    path: "/api/users/user-1/jobs",
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error, "forbidden");
});

test("unlinked legacy user rows fail closed", async () => {
  const middleware = createApiSecurityMiddleware({
    authenticate: async () => ({ id: "auth-1" }),
    select: async () => [{ id: "user-1", auth_user_id: null }],
  });
  const { res, nextCalled } = await runMiddleware(middleware, {
    method: "GET",
    path: "/api/users/user-1",
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.details.code, "account_not_linked");
});

test("browser callers cannot mutate billing state directly", async () => {
  const middleware = createApiSecurityMiddleware({
    authenticate: async () => ({ id: "auth-1" }),
    select: async () => [{ id: "user-1", auth_user_id: "auth-1" }],
  });
  const { res, nextCalled } = await runMiddleware(middleware, {
    method: "POST",
    path: "/api/users/user-1/billing/activate",
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 403);
  assert.equal(res.body.details.code, "billing_provider_required");
});

test("prototype phone lookup endpoint is retired", async () => {
  const middleware = createApiSecurityMiddleware({
    authenticate: async () => {
      throw new Error("must not authenticate legacy discovery endpoint");
    },
    select: async () => [],
  });
  const { res, nextCalled } = await runMiddleware(middleware, {
    method: "GET",
    path: "/api/users/by-phone/%2B441234567890",
  });
  assert.equal(nextCalled, false);
  assert.equal(res.statusCode, 410);
});

test("internal key comparison is strict and timing-safe-compatible", () => {
  assert.equal(__apiSecurity.secretsEqual("same-secret", "same-secret"), true);
  assert.equal(__apiSecurity.secretsEqual("same-secret", "wrong-secret"), false);
  assert.equal(__apiSecurity.secretsEqual("short", "a-longer-secret"), false);
});

test("ownership middleware is mounted before live event stream", async () => {
  const source = await fs.readFile("src/app.js", "utf8");
  const securityIndex = source.indexOf("app.use(createApiSecurityMiddleware())");
  const liveIndex = source.indexOf("app.use(liveEventsRouter)");
  assert.ok(securityIndex >= 0);
  assert.ok(liveIndex >= 0);
  assert.ok(securityIndex < liveIndex);
});
