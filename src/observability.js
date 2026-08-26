import { randomUUID } from "crypto";

import { writeSystemLog } from "./systemLog.js";

const MUTATION_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const SLOW_REQUEST_MS = 2_000;

function safeRequestId(value) {
  const candidate = String(value || "").trim();
  return REQUEST_ID_PATTERN.test(candidate) ? candidate : randomUUID();
}

function safePath(req) {
  const path = String(req?.path || req?.originalUrl || "/").split("?")[0];
  return path.length <= 300 ? path : `${path.slice(0, 300)}…`;
}

function requestedUserId(path) {
  const match = String(path || "").match(/^\/api\/users\/([^/]+)/i);
  const value = match?.[1] || null;
  return value && UUID_PATTERN.test(value) ? value : null;
}

function bodyShape(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return [];
  return Object.keys(body).slice(0, 30).sort();
}

function requestLevel({ method, statusCode, durationMs, path }) {
  if (statusCode >= 500) return "error";
  if (statusCode >= 400) return "warning";
  if (path !== "/api/live-events" && durationMs >= SLOW_REQUEST_MS) {
    return "warning";
  }
  if (MUTATION_METHODS.has(method)) return "info";
  return "debug";
}

function shouldSkip(path) {
  return path === "/health" || path === "/health/";
}

function consoleRequestSummary(level, details) {
  if (level === "debug") return;
  const line = `[http] ${details.method} ${details.path} ${details.statusCode} ${details.durationMs}ms requestId=${details.requestId}`;
  if (level === "error") console.error(line);
  else if (level === "warning") console.warn(line);
  else console.log(line);
}

export function installRequestObservability(req, res, next) {
  const requestId = safeRequestId(req.get?.("x-request-id"));
  const startedAt = process.hrtime.bigint();
  const path = safePath(req);
  let aborted = false;

  req.requestId = requestId;
  res.setHeader("x-request-id", requestId);

  req.once("aborted", () => {
    aborted = true;
    if (shouldSkip(path)) return;

    void writeSystemLog({
      level: "warning",
      source: "http",
      event: "http_request_aborted",
      message: "HTTP request aborted before completion",
      details: {
        requestId,
        method: req.method,
        path,
        targetUserId: requestedUserId(path),
        bodyKeys: bodyShape(req.body),
        actionability: "attention",
      },
    });
  });

  res.once("finish", () => {
    if (shouldSkip(path)) return;

    const durationMs = Math.max(
      0,
      Number(process.hrtime.bigint() - startedAt) / 1_000_000
    );
    const roundedDurationMs = Math.round(durationMs);
    const level = requestLevel({
      method: req.method,
      statusCode: res.statusCode,
      durationMs: roundedDurationMs,
      path,
    });
    const details = {
      requestId,
      method: req.method,
      path,
      statusCode: res.statusCode,
      durationMs: roundedDurationMs,
      targetUserId: requestedUserId(path),
      bodyKeys: bodyShape(req.body),
      aborted,
    };

    consoleRequestSummary(level, details);
    void writeSystemLog({
      level,
      source: "http",
      event: "http_request_completed",
      message: `${req.method} ${path} -> ${res.statusCode}`,
      details,
    });
  });

  next();
}

export function logUnhandledHttpError(error, req) {
  const statusCode = Number(error?.status || error?.statusCode || 500);
  const path = safePath(req);
  const level = statusCode >= 500 ? "error" : "warning";

  void writeSystemLog({
    level,
    source: "http",
    event: "http_unhandled_error",
    message: error?.message || "Unhandled HTTP error",
    details: {
      requestId: req?.requestId || null,
      method: req?.method || null,
      path,
      statusCode,
      targetUserId: requestedUserId(path),
      error,
      actionability: statusCode >= 500 ? "actionable" : "attention",
    },
  });
}

export const __observability = {
  bodyShape,
  requestLevel,
  requestedUserId,
  safeRequestId,
};
