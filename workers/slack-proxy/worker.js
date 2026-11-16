/**
 * slack-proxy — stateless Cloudflare Worker fallback for wasmhatch's direct
 * browser route to Slack (src/lib/slack-connect.ts). Accepts POST /api/{method},
 * forwards to https://slack.com/api/{method} with the Authorization header set
 * server-side, and returns Slack's JSON with CORS headers. Tokens live only in
 * per-request memory: never stored, never logged. See README.md for deploy steps.
 */

const SLACK_API_BASE = "https://slack.com/api";
const METHOD_NAME_PATTERN = /^[a-z]+(\.[a-zA-Z]+)+$/;
const MAX_BODY_BYTES = 256 * 1024;
const TOKEN_PATTERN = /^[\x21-\x7e]{1,4096}$/;

export default {
  async fetch(request, env) {
    // Default "*" keeps first deploys simple; pin ALLOWED_ORIGIN to your app's
    // origin before real use so other sites cannot relay tokens through you.
    const allowedOrigin = typeof env?.ALLOWED_ORIGIN === "string" ? env.ALLOWED_ORIGIN.trim() : "";
    const requestOrigin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": allowedOrigin || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };
    if (allowedOrigin && allowedOrigin !== "*") {
      if (request.method === "OPTIONS") {
        if (requestOrigin && requestOrigin !== allowedOrigin) {
          return json({ ok: false, error: "forbidden_origin" }, 403, cors);
        }
      } else if (requestOrigin !== allowedOrigin) {
        return json({ ok: false, error: "forbidden_origin" }, 403, cors);
      }
    }
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);

    // Exactly /api/{method}; the Slack method-name shape rejects path traversal.
    const match = new URL(request.url).pathname.match(/^\/api\/([^/]+)$/);
    const method = match ? match[1] : "";
    if (!METHOD_NAME_PATTERN.test(method)) return json({ ok: false, error: "unknown_method" }, 404, cors);

    const contentLength = Number(request.headers.get("Content-Length") || "0");
    if (Number.isFinite(contentLength) && contentLength > MAX_BODY_BYTES) {
      return json({ ok: false, error: "payload_too_large" }, 413, cors);
    }
    const rawBody = await readBoundedText(request, MAX_BODY_BYTES);
    if (rawBody === null) return json({ ok: false, error: "payload_too_large" }, 413, cors);

    // Token from "Authorization: Bearer" or a "token" form field (the shape
    // src/lib/slack-connect.ts sends); stripped from the forwarded body.
    const params = new URLSearchParams(rawBody);
    const authorization = request.headers.get("Authorization") || "";
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const token = bearer || params.get("token") || "";
    params.delete("token");
    if (!token) return json({ ok: false, error: "not_authed" }, 401, cors);
    if (!TOKEN_PATTERN.test(token)) return json({ ok: false, error: "invalid_auth" }, 401, cors);

    let upstream;
    try {
      upstream = await fetch(`${SLACK_API_BASE}/${method}`, {
        method: "POST",
        headers: {
          "Authorization": `Bearer ${token}`,
          "Content-Type": "application/x-www-form-urlencoded;charset=utf-8"
        },
        body: params.toString()
      });
    } catch {
      return json({ ok: false, error: "upstream_unavailable" }, 502, cors);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, "Content-Type": upstream.headers.get("Content-Type") || "application/json;charset=utf-8" }
    });
  }
};

async function readBoundedText(request, maxBytes) {
  if (!request.body || typeof request.body.getReader !== "function") {
    const text = await request.text();
    return new TextEncoder().encode(text).byteLength <= maxBytes ? text : null;
  }
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let output = "";
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      output += decoder.decode(value, { stream: true });
    }
    output += decoder.decode();
    return output;
  } finally {
    reader.releaseLock();
  }
}

function json(payload, status, cors) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, "Content-Type": "application/json;charset=utf-8" }
  });
}
