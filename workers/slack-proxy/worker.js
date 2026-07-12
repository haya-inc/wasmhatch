/**
 * slack-proxy — stateless Cloudflare Worker fallback for wasmhatch's direct
 * browser route to Slack (src/lib/slack-connect.ts). Accepts POST /api/{method},
 * forwards to https://slack.com/api/{method} with the Authorization header set
 * server-side, and returns Slack's JSON with CORS headers. Tokens live only in
 * per-request memory: never stored, never logged. See README.md for deploy steps.
 */

const SLACK_API_BASE = "https://slack.com/api";
const METHOD_NAME_PATTERN = /^[a-z]+(\.[a-zA-Z]+)+$/;

export default {
  async fetch(request, env) {
    // Default "*" keeps first deploys simple; pin ALLOWED_ORIGIN to your app's
    // origin before real use so other sites cannot relay tokens through you.
    const cors = {
      "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN || "*",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "Authorization, Content-Type",
      "Access-Control-Max-Age": "86400",
      "Vary": "Origin"
    };
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "POST") return json({ ok: false, error: "method_not_allowed" }, 405, cors);

    // Exactly /api/{method}; the Slack method-name shape rejects path traversal.
    const match = new URL(request.url).pathname.match(/^\/api\/([^/]+)$/);
    const method = match ? match[1] : "";
    if (!METHOD_NAME_PATTERN.test(method)) return json({ ok: false, error: "unknown_method" }, 404, cors);

    // Token from "Authorization: Bearer" or a "token" form field (the shape
    // src/lib/slack-connect.ts sends); stripped from the forwarded body.
    const params = new URLSearchParams(await request.text());
    const authorization = request.headers.get("Authorization") || "";
    const bearer = authorization.startsWith("Bearer ") ? authorization.slice(7).trim() : "";
    const token = bearer || params.get("token") || "";
    params.delete("token");
    if (!token) return json({ ok: false, error: "not_authed" }, 401, cors);

    const upstream = await fetch(`${SLACK_API_BASE}/${method}`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded;charset=utf-8"
      },
      body: params.toString()
    });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { ...cors, "Content-Type": upstream.headers.get("Content-Type") || "application/json;charset=utf-8" }
    });
  }
};

function json(payload, status, cors) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...cors, "Content-Type": "application/json;charset=utf-8" }
  });
}
