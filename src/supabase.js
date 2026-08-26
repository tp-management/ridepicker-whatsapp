import {
  SUPABASE_CONFIGURED,
  SUPABASE_SERVICE_ROLE_KEY,
  SUPABASE_URL,
} from "./config.js";

function requireConfigured() {
  if (!SUPABASE_CONFIGURED) {
    const error = new Error(
      "Supabase is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY."
    );
    error.status = 503;
    throw error;
  }
}

function buildUrl(path, query = {}) {
  const base = SUPABASE_URL.replace(/\/$/, "");
  const url = new URL(`${base}/rest/v1/${path}`);

  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === "") {
      continue;
    }

    url.searchParams.set(key, String(value));
  }

  return url;
}

function annotateSupabaseError(
  error,
  { method, path, phase, statusCode = null, durationMs = null }
) {
  if (!error || typeof error !== "object") return error;

  error.upstream = {
    service: "supabase",
    method,
    path,
    phase,
    statusCode,
    durationMs,
  };

  return error;
}

export async function supabaseRequest(
  path,
  {
    method = "GET",
    query,
    body,
    prefer,
    headers = {},
    raw = false,
  } = {}
) {
  requireConfigured();

  const startedAt = Date.now();
  const url = buildUrl(path, query);
  let response;

  try {
    response = await fetch(url, {
      method,
      headers: {
        apikey: SUPABASE_SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        ...(prefer ? { Prefer: prefer } : {}),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    annotateSupabaseError(error, {
      method,
      path,
      phase: "network",
      durationMs: Date.now() - startedAt,
    });
    console.error(
      `[supabase] ${method} ${path} failed before response:`,
      error.message
    );
    throw error;
  }

  const text = await response.text();

  if (!response.ok) {
    let details = text;

    try {
      details = JSON.parse(text);
    } catch {
      // Keep raw text when PostgREST did not return JSON.
    }

    const error = new Error(
      details?.message ||
        details?.hint ||
        `Supabase request failed with ${response.status}`
    );
    error.status = response.status;
    error.code = details?.code || null;
    error.details = details;
    annotateSupabaseError(error, {
      method,
      path,
      phase: "response",
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
    });
    console.error(
      `[supabase] ${method} ${path} returned ${response.status}${error.code ? ` code=${error.code}` : ""}`
    );
    throw error;
  }

  if (raw) {
    return { response, text };
  }

  if (!text) {
    return null;
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    annotateSupabaseError(error, {
      method,
      path,
      phase: "decode",
      statusCode: response.status,
      durationMs: Date.now() - startedAt,
    });
    console.error(
      `[supabase] ${method} ${path} returned invalid JSON:`,
      error.message
    );
    throw error;
  }
}

export async function callRpc(functionName, body = {}) {
  return supabaseRequest(`rpc/${functionName}`, {
    method: "POST",
    body,
  });
}

export function isSupabaseConfigured() {
  return SUPABASE_CONFIGURED;
}

export async function selectRows(table, query = {}) {
  return (
    (await supabaseRequest(table, {
      query,
    })) || []
  );
}

export async function insertRows(table, body, options = {}) {
  return (
    (await supabaseRequest(table, {
      method: "POST",
      query: options.query,
      body,
      prefer:
        options.prefer ||
        "return=representation",
    })) || []
  );
}

export async function updateRows(table, body, query = {}) {
  return (
    (await supabaseRequest(table, {
      method: "PATCH",
      query,
      body,
      prefer: "return=representation",
    })) || []
  );
}

export async function deleteRows(table, query = {}) {
  return (
    (await supabaseRequest(table, {
      method: "DELETE",
      query,
      prefer: "return=representation",
    })) || []
  );
}

export const __supabaseDiagnostics = {
  annotateSupabaseError,
};
