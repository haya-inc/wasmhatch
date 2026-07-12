import { describe, expect, it, vi } from "vitest";
import {
  GOOGLE_SHEETS_SCOPE,
  GoogleOAuthError,
  GoogleOAuthReauthorizationRequiredError,
  GoogleOAuthSession,
  type GoogleIdentityOAuthRuntime,
  type GoogleOAuthPopupError,
  type GoogleRevocationResponse,
  type GoogleTokenResponse
} from "./google-oauth";

const CLIENT_ID = "1234567890-wasmhatch.apps.googleusercontent.com";

function fakeRuntime(options: {
  response?: GoogleTokenResponse;
  popupError?: GoogleOAuthPopupError;
  granted?: boolean;
  grantError?: boolean;
  revokeResponse?: GoogleRevocationResponse;
  defer?: boolean;
} = {}) {
  let tokenCallback: ((response: GoogleTokenResponse) => void) | undefined;
  let popupCallback: ((error: GoogleOAuthPopupError) => void) | undefined;
  const requestAccessToken = vi.fn(() => {
    if (options.defer) return;
    if (options.popupError) popupCallback?.(options.popupError);
    else tokenCallback?.(options.response ?? {
      access_token: "secret-google-token",
      expires_in: 3600,
      scope: GOOGLE_SHEETS_SCOPE,
      token_type: "Bearer"
    });
  });
  const revoke = vi.fn((_token: string, callback: (response: GoogleRevocationResponse) => void) => {
    callback(options.revokeResponse ?? { successful: true });
  });
  const runtime: GoogleIdentityOAuthRuntime = {
    initTokenClient: vi.fn((config) => {
      tokenCallback = config.callback;
      popupCallback = config.error_callback;
      return { requestAccessToken };
    }),
    hasGrantedAllScopes: vi.fn(() => {
      if (options.grantError) throw new Error("untrusted runtime detail");
      return options.granted ?? true;
    }),
    revoke
  };
  return {
    runtime,
    requestAccessToken,
    revoke,
    respond(response: GoogleTokenResponse) { tokenCallback?.(response); }
  };
}

describe("GoogleOAuthSession", () => {
  it("keeps a granted token private and exposes it only through a host credential provider", async () => {
    const fake = fakeRuntime();
    const session = new GoogleOAuthSession(async () => fake.runtime, () => 1_000);

    const status = await session.authorize(CLIENT_ID);

    expect(status).toEqual({
      state: "connected",
      connected: true,
      expiresAt: "1970-01-01T01:00:01.000Z",
      scopes: [GOOGLE_SHEETS_SCOPE]
    });
    expect(fake.runtime.initTokenClient).toHaveBeenCalledWith(expect.objectContaining({
      client_id: CLIENT_ID,
      scope: GOOGLE_SHEETS_SCOPE,
      include_granted_scopes: false
    }));
    expect(fake.requestAccessToken).toHaveBeenCalledWith({ prompt: "select_account" });
    expect(JSON.stringify(session)).not.toContain("secret-google-token");
    expect(JSON.stringify(status)).not.toContain("secret-google-token");
    await expect(session.credentialProvider().getToken()).resolves.toBe("secret-google-token");
  });

  it("expires credentials before provider expiry and requires a new user gesture", async () => {
    let now = 0;
    const fake = fakeRuntime({ response: {
      access_token: "short-token",
      expires_in: 60,
      scope: GOOGLE_SHEETS_SCOPE,
      token_type: "Bearer"
    } });
    const session = new GoogleOAuthSession(async () => fake.runtime, () => now);
    await session.authorize(CLIENT_ID);
    now = 30_000;

    expect(session.status()).toEqual({ state: "expired", connected: false, expiresAt: null, scopes: [] });
    await expect(session.credentialProvider().getToken()).rejects.toBeInstanceOf(GoogleOAuthReauthorizationRequiredError);
  });

  it("rejects partial grants, OAuth denial, popup closure, and malformed tokens without retaining credentials", async () => {
    const cases = [
      [fakeRuntime({ granted: false }), "scope_not_granted"],
      [fakeRuntime({ response: { error: "access_denied" } }), "access_denied"],
      [fakeRuntime({ popupError: { type: "popup_closed" } }), "popup_closed"],
      [fakeRuntime({ grantError: true }), "invalid_response"],
      [fakeRuntime({ response: { access_token: "bad\ntoken", expires_in: 3600, scope: GOOGLE_SHEETS_SCOPE } }), "invalid_token"],
      [fakeRuntime({ response: { access_token: "token", expires_in: 1, scope: GOOGLE_SHEETS_SCOPE } }), "invalid_expiry"]
    ] as const;

    for (const [fake, code] of cases) {
      const session = new GoogleOAuthSession(async () => fake.runtime);
      await expect(session.authorize(CLIENT_ID)).rejects.toMatchObject({ code });
      expect(session.status().connected).toBe(false);
    }
  });

  it("validates client IDs and scope inputs before loading external code", async () => {
    const loader = vi.fn();
    const session = new GoogleOAuthSession(loader);

    await expect(session.authorize("not-a-google-client")).rejects.toMatchObject({ code: "invalid_client_id" });
    await expect(session.authorize(CLIENT_ID, ["https://evil.example/scope"])).rejects.toMatchObject({ code: "invalid_scope" });
    expect(loader).not.toHaveBeenCalled();
  });

  it("prevents concurrent authorization attempts", async () => {
    const fake = fakeRuntime({ defer: true });
    const session = new GoogleOAuthSession(async () => fake.runtime);
    const first = session.authorize(CLIENT_ID);
    await vi.waitFor(() => expect(fake.requestAccessToken).toHaveBeenCalledTimes(1));

    await expect(session.authorize(CLIENT_ID)).rejects.toMatchObject({ code: "authorization_in_progress" });
    fake.respond({ access_token: "token", expires_in: 3600, scope: GOOGLE_SHEETS_SCOPE, token_type: "Bearer" });
    await expect(first).resolves.toMatchObject({ connected: true });
  });

  it("ignores a token callback that arrives after the authorization timeout", async () => {
    vi.useFakeTimers();
    try {
      const fake = fakeRuntime({ defer: true });
      const session = new GoogleOAuthSession(async () => fake.runtime);
      const authorization = session.authorize(CLIENT_ID);
      await Promise.resolve();
      await Promise.resolve();
      expect(fake.requestAccessToken).toHaveBeenCalledTimes(1);

      const rejected = expect(authorization).rejects.toMatchObject({ code: "authorization_timeout" });
      await vi.advanceTimersByTimeAsync(120_000);
      await rejected;
      fake.respond({ access_token: "late-token", expires_in: 3600, scope: GOOGLE_SHEETS_SCOPE, token_type: "Bearer" });
      expect(session.status().connected).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it("clears the local credential before revoking the complete Google grant", async () => {
    const fake = fakeRuntime();
    const session = new GoogleOAuthSession(async () => fake.runtime);
    await session.authorize(CLIENT_ID);

    await expect(session.revoke()).resolves.toEqual({ state: "disconnected", connected: false, expiresAt: null, scopes: [] });
    expect(fake.revoke).toHaveBeenCalledWith("secret-google-token", expect.any(Function));
    await expect(session.credentialProvider().getToken()).rejects.toBeInstanceOf(GoogleOAuthReauthorizationRequiredError);
  });

  it("treats an already invalid token as revoked but reports other revoke failures", async () => {
    const invalid = fakeRuntime({ revokeResponse: { successful: false, error: "invalid_token" } });
    const invalidSession = new GoogleOAuthSession(async () => invalid.runtime);
    await invalidSession.authorize(CLIENT_ID);
    await expect(invalidSession.revoke()).resolves.toMatchObject({ connected: false });

    const failed = fakeRuntime({ revokeResponse: { successful: false, error: "server_error" } });
    const failedSession = new GoogleOAuthSession(async () => failed.runtime);
    await failedSession.authorize(CLIENT_ID);
    await expect(failedSession.revoke()).rejects.toBeInstanceOf(GoogleOAuthError);
    expect(failedSession.status().connected).toBe(false);
  });
});
