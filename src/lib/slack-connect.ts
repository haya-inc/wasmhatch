/**
 * Slack browser connectivity over the CORS "simple request" route.
 *
 * Slack Web API responses carry `access-control-allow-origin: *`, but the
 * CORS preflight allow-list does not include `authorization` or
 * `content-type: application/json`. Browser calls must therefore avoid
 * triggering a preflight entirely: POST with
 * `application/x-www-form-urlencoded` and pass the token as a `token` form
 * field — never as an Authorization header and never as a JSON body.
 *
 * Ship notes:
 * - Before this module is wired into the UI, `https://slack.com` must be
 *   added to the app CSP `connect-src` (owned by vite.config.ts; that change
 *   is deliberately not part of this module).
 * - The body-token route is unofficial (longstanding but undocumented). This
 *   module detects breakage and degrades to a `cors-blocked` result; the
 *   bundled Cloudflare Worker proxy under `workers/slack-proxy` is the
 *   documented fallback — deploy it and point `options.baseUrl` at
 *   `<worker-url>/api`.
 * - Tokens are never logged and never appear in diagnostics or thrown
 *   errors produced by this module.
 */

export const SLACK_API_BASE_URL = "https://slack.com/api";

export interface SlackProbeResult {
  ok: boolean;
  status: "connected" | "invalid-token" | "cors-blocked" | "network-error";
  team?: string;
  userId?: string;
  diagnostic: string;
}

export interface SlackConnectOptions {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
}

const SLACK_METHOD_NAME_PATTERN = /^[a-z]+(\.[a-zA-Z]+)+$/;

const TOKEN_ERROR_CODES = new Set(["invalid_auth", "account_inactive", "token_revoked", "token_expired"]);

const CORS_BLOCKED_DIAGNOSTIC =
  "The direct browser connection to Slack appears to be blocked. This happens when the browser refuses the " +
  "cross-origin request or when Slack stops accepting the unofficial browser route this app uses. Deploy the " +
  "bundled Cloudflare Worker proxy (workers/slack-proxy) and point the Slack base URL at it to restore connectivity.";

const BODY_TOKEN_ROUTE_BROKEN_DIAGNOSTIC =
  "Slack answered as if no token was sent even though one was included in the request body, so the unofficial " +
  "browser route this app relies on appears to be closed. Deploy the bundled Cloudflare Worker proxy " +
  "(workers/slack-proxy) and point the Slack base URL at it to restore connectivity.";

interface SlackAuthTestBody {
  ok?: unknown;
  error?: unknown;
  team?: unknown;
  user_id?: unknown;
}

function resolveFetch(options?: SlackConnectOptions): typeof fetch {
  if (options?.fetchImpl) return options.fetchImpl;
  if (typeof globalThis.fetch !== "function") {
    throw new Error("No fetch implementation is available in this environment; pass options.fetchImpl.");
  }
  return globalThis.fetch.bind(globalThis);
}

function resolveBaseUrl(options?: SlackConnectOptions): string {
  return (options?.baseUrl ?? SLACK_API_BASE_URL).replace(/\/+$/, "");
}

/** Describes a thrown value for a diagnostic, with the token redacted defensively. */
function describeFailure(error: unknown, token: string): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const text = raw.trim() === "" ? "unknown error" : raw;
  return token === "" ? text : text.split(token).join("[redacted]");
}

function postForm(
  method: string,
  token: string,
  params: Record<string, string | number | boolean>,
  options?: SlackConnectOptions
): Promise<Response> {
  const fetchImpl = resolveFetch(options);
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) body.set(key, String(value));
  body.set("token", token);
  // A CORS "simple request": form-encoded content type, no Authorization header.
  return fetchImpl(`${resolveBaseUrl(options)}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString()
  });
}

/**
 * Probes Slack connectivity by calling `auth.test` with a body token and
 * classifying the outcome. Never throws for expected failure modes and never
 * places the token in the returned diagnostic.
 */
export async function probeSlackConnectivity(
  token: string,
  options?: { fetchImpl?: typeof fetch; baseUrl?: string }
): Promise<SlackProbeResult> {
  if (token.trim() === "") {
    return {
      ok: false,
      status: "invalid-token",
      diagnostic: "No Slack token was provided. Paste a token and try again."
    };
  }

  let response: Response;
  try {
    response = await postForm("auth.test", token, {}, options);
  } catch (error) {
    if (error instanceof TypeError) {
      // Browsers surface both CORS rejections and CSP/network refusals as a TypeError.
      return { ok: false, status: "cors-blocked", diagnostic: CORS_BLOCKED_DIAGNOSTIC };
    }
    return {
      ok: false,
      status: "network-error",
      diagnostic:
        `Slack could not be reached (${describeFailure(error, token)}). Check your network connection and try again.`
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      status: "network-error",
      diagnostic: `Slack responded with HTTP ${response.status}. This is usually temporary; wait a moment and try again.`
    };
  }

  let body: SlackAuthTestBody;
  try {
    body = await response.json() as SlackAuthTestBody;
  } catch {
    return {
      ok: false,
      status: "network-error",
      diagnostic:
        "Slack returned a response that could not be read as JSON, so the direct browser route may have changed. " +
        "If this keeps happening, deploy the bundled Cloudflare Worker proxy (workers/slack-proxy) and point the " +
        "Slack base URL at it."
    };
  }

  if (body.ok === true) {
    const result: SlackProbeResult = { ok: true, status: "connected", diagnostic: "Connected to Slack." };
    if (typeof body.team === "string" && body.team !== "") {
      result.team = body.team;
      result.diagnostic = `Connected to the Slack workspace "${body.team}".`;
    }
    if (typeof body.user_id === "string" && body.user_id !== "") result.userId = body.user_id;
    return result;
  }

  const code = typeof body.error === "string" && body.error !== "" ? body.error : "unknown_error";
  if (TOKEN_ERROR_CODES.has(code)) {
    return {
      ok: false,
      status: "invalid-token",
      diagnostic: `Slack rejected the token (${code}). Generate a fresh token in Slack and try again.`
    };
  }
  if (code === "not_authed") {
    // We did send a token in the body; Slack ignoring it means the unofficial
    // body-token route is broken, so steer the user to the proxy fallback.
    return { ok: false, status: "cors-blocked", diagnostic: BODY_TOKEN_ROUTE_BROKEN_DIAGNOSTIC };
  }
  return {
    ok: false,
    status: "network-error",
    diagnostic: `Slack declined the connectivity check (${code}). Wait a moment and try again.`
  };
}

/**
 * Generic Slack Web API call over the preflight-free form-encoded route.
 * Returns the parsed JSON payload as-is (including Slack's `ok`/`error`
 * envelope) so callers can interpret method-specific results themselves.
 * Set `options.baseUrl` to `<worker-url>/api` to route through the bundled
 * Cloudflare Worker proxy instead of slack.com.
 */
export async function slackApiCall<T>(
  method: string,
  token: string,
  params: Record<string, string | number | boolean>,
  options?: { fetchImpl?: typeof fetch; baseUrl?: string }
): Promise<T> {
  if (!SLACK_METHOD_NAME_PATTERN.test(method)) {
    // Deliberately does not echo the rejected value: a caller that swaps
    // arguments must not end up with a token inside an Error message.
    throw new Error('Invalid Slack API method name. Expected a dotted name such as "auth.test" or "chat.postMessage".');
  }

  let response: Response;
  try {
    response = await postForm(method, token, params, options);
  } catch (error) {
    if (error instanceof TypeError) {
      throw new Error(`Slack API call ${method} failed. ${CORS_BLOCKED_DIAGNOSTIC}`);
    }
    throw new Error(`Slack API call ${method} failed before a response arrived (${describeFailure(error, token)}).`);
  }

  if (!response.ok) {
    throw new Error(`Slack API call ${method} failed with HTTP ${response.status}.`);
  }

  try {
    return await response.json() as T;
  } catch {
    throw new Error(
      `Slack API call ${method} returned a response that could not be read as JSON. If the direct browser route ` +
      "has changed, deploy the bundled Cloudflare Worker proxy (workers/slack-proxy) and point the base URL at it."
    );
  }
}
