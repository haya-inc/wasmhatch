import {
  createBearerCredentialProvider,
  type BearerCredentialProvider
} from "./connector";

export const GOOGLE_IDENTITY_SCRIPT_URL = "https://accounts.google.com/gsi/client";
export const GOOGLE_SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";

export interface GoogleOAuthStatus {
  readonly state: "disconnected" | "connected" | "expired";
  readonly connected: boolean;
  readonly expiresAt: string | null;
  readonly scopes: readonly string[];
}

export interface GoogleTokenResponse {
  readonly access_token?: unknown;
  readonly expires_in?: unknown;
  readonly scope?: unknown;
  readonly token_type?: unknown;
  readonly error?: unknown;
}

export interface GoogleOAuthPopupError {
  readonly type?: unknown;
}

export interface GoogleRevocationResponse {
  readonly successful?: unknown;
  readonly error?: unknown;
}

export interface GoogleTokenClient {
  requestAccessToken(config?: { prompt?: string }): void;
}

export interface GoogleIdentityOAuthRuntime {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    include_granted_scopes: boolean;
    callback(response: GoogleTokenResponse): void;
    error_callback(error: GoogleOAuthPopupError): void;
  }): GoogleTokenClient;
  hasGrantedAllScopes(response: GoogleTokenResponse, ...scopes: string[]): boolean;
  revoke(accessToken: string, callback: (response: GoogleRevocationResponse) => void): void;
}

export class GoogleOAuthError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "GoogleOAuthError";
  }
}

export class GoogleOAuthReauthorizationRequiredError extends GoogleOAuthError {
  constructor() {
    super("reauthorization_required", "Google authorization expired or is unavailable. Reconnect Google Sheets to continue.");
    this.name = "GoogleOAuthReauthorizationRequiredError";
  }
}

interface SessionCredential {
  readonly accessToken: string;
  readonly expiresAtMs: number;
  readonly scopes: readonly string[];
}

const CLIENT_ID_MAX_LENGTH = 512;
const TOKEN_MAX_LENGTH = 16 * 1024;
const EXPIRY_SAFETY_MS = 30_000;
const LOAD_TIMEOUT_MS = 15_000;
const AUTHORIZATION_TIMEOUT_MS = 120_000;
// A silent re-grant shows no UI, so a hung attempt only delays the visible
// reconnect fallback — keep the wait short.
const SILENT_AUTHORIZATION_TIMEOUT_MS = 20_000;
const REVOKE_TIMEOUT_MS = 15_000;

let runtimePromise: Promise<GoogleIdentityOAuthRuntime> | null = null;

function runtimeFromGlobal(): GoogleIdentityOAuthRuntime | null {
  const candidate = (globalThis as {
    google?: { accounts?: { oauth2?: Partial<GoogleIdentityOAuthRuntime> } };
  }).google?.accounts?.oauth2;
  if (
    candidate &&
    typeof candidate.initTokenClient === "function" &&
    typeof candidate.hasGrantedAllScopes === "function" &&
    typeof candidate.revoke === "function"
  ) {
    return candidate as GoogleIdentityOAuthRuntime;
  }
  return null;
}

export function loadGoogleIdentityServices(): Promise<GoogleIdentityOAuthRuntime> {
  const existing = runtimeFromGlobal();
  if (existing) return Promise.resolve(existing);
  if (runtimePromise) return runtimePromise;
  if (typeof document === "undefined") {
    return Promise.reject(new GoogleOAuthError("library_unavailable", "Google Identity Services requires a browser document."));
  }

  runtimePromise = new Promise<GoogleIdentityOAuthRuntime>((resolve, reject) => {
    let settled = false;
    let script = document.querySelector<HTMLScriptElement>(`script[src="${GOOGLE_IDENTITY_SCRIPT_URL}"]`);
    if (!script) {
      script = document.createElement("script");
      script.src = GOOGLE_IDENTITY_SCRIPT_URL;
      script.async = true;
      script.referrerPolicy = "no-referrer";
      script.dataset.wasmhatchGoogleIdentity = "true";
      document.head.append(script);
    }

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script?.removeEventListener("load", handleLoad);
      script?.removeEventListener("error", handleError);
      if (error) reject(error);
    };
    const handleLoad = () => {
      const runtime = runtimeFromGlobal();
      if (!runtime) {
        finish(new GoogleOAuthError("library_invalid", "Google Identity Services loaded without the OAuth API."));
        return;
      }
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script?.removeEventListener("load", handleLoad);
      script?.removeEventListener("error", handleError);
      resolve(runtime);
    };
    const handleError = () => {
      script?.remove();
      finish(new GoogleOAuthError("library_load_failed", "Google Identity Services could not be loaded."));
    };
    const timer = globalThis.setTimeout(() => {
      finish(new GoogleOAuthError("library_load_timeout", "Google Identity Services did not load in time."));
    }, LOAD_TIMEOUT_MS);
    script.addEventListener("load", handleLoad, { once: true });
    script.addEventListener("error", handleError, { once: true });
    if (runtimeFromGlobal()) handleLoad();
  }).catch((error) => {
    runtimePromise = null;
    throw error;
  });
  return runtimePromise;
}

function requireClientId(value: string) {
  const clientId = value.trim();
  if (!clientId || clientId.length > CLIENT_ID_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(clientId)) {
    throw new GoogleOAuthError("invalid_client_id", "A bounded Google OAuth Web client ID is required.");
  }
  if (!/^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/.test(clientId)) {
    throw new GoogleOAuthError("invalid_client_id", "Google OAuth client ID must end in .apps.googleusercontent.com.");
  }
  return clientId;
}

function requireScopes(value: readonly string[]) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 16) {
    throw new GoogleOAuthError("invalid_scope", "Google authorization requires 1 to 16 scopes.");
  }
  const scopes = value.map((scope) => {
    if (typeof scope !== "string" || !/^https:\/\/www\.googleapis\.com\/auth\/[A-Za-z0-9._/-]+$/.test(scope)) {
      throw new GoogleOAuthError("invalid_scope", "Google authorization scope is invalid.");
    }
    return scope;
  });
  if (new Set(scopes).size !== scopes.length) {
    throw new GoogleOAuthError("invalid_scope", "Google authorization scopes must be unique.");
  }
  return Object.freeze([...scopes]);
}

function oauthFailure(error: unknown) {
  if (error === "access_denied") return new GoogleOAuthError("access_denied", "Google authorization was denied; no access was granted.");
  return new GoogleOAuthError("authorization_failed", "Google authorization did not return a usable access token.");
}

function popupFailure(value: unknown) {
  if (value === "popup_closed") return new GoogleOAuthError("popup_closed", "Google authorization was closed before completion.");
  if (value === "popup_failed_to_open") return new GoogleOAuthError("popup_failed_to_open", "Google authorization popup was blocked. Allow popups and try again.");
  return new GoogleOAuthError("popup_error", "Google authorization popup failed.");
}

export class GoogleOAuthSession {
  #credential: SessionCredential | null = null;
  #state: GoogleOAuthStatus["state"] = "disconnected";
  #authorizing = false;

  constructor(
    private readonly loadRuntime: () => Promise<GoogleIdentityOAuthRuntime> = loadGoogleIdentityServices,
    private readonly now: () => number = () => Date.now()
  ) {}

  private expireIfNeeded() {
    if (this.#credential && this.now() >= this.#credential.expiresAtMs - EXPIRY_SAFETY_MS) {
      this.#credential = null;
      this.#state = "expired";
    }
  }

  status(): GoogleOAuthStatus {
    this.expireIfNeeded();
    const credential = this.#credential;
    return Object.freeze({
      state: credential ? "connected" : this.#state,
      connected: Boolean(credential),
      expiresAt: credential ? new Date(credential.expiresAtMs).toISOString() : null,
      scopes: Object.freeze(credential ? [...credential.scopes] : [])
    });
  }

  credentialProvider(): BearerCredentialProvider {
    return createBearerCredentialProvider(() => {
      this.expireIfNeeded();
      if (!this.#credential) throw new GoogleOAuthReauthorizationRequiredError();
      return this.#credential.accessToken;
    });
  }

  clear() {
    this.#credential = null;
    this.#state = "disconnected";
    return this.status();
  }

  /**
   * `options.silent` re-requests a token with `prompt: ""` — no popup, no
   * user gesture — which Google honors while the account session still
   * covers the scopes. Failure changes no session state; callers fall back
   * to the visible connect flow.
   */
  async authorize(
    clientIdValue: string,
    scopeValues: readonly string[] = [GOOGLE_SHEETS_SCOPE],
    options?: { silent?: boolean }
  ) {
    if (this.#authorizing) throw new GoogleOAuthError("authorization_in_progress", "Google authorization is already in progress.");
    const clientId = requireClientId(clientIdValue);
    const scopes = requireScopes(scopeValues);
    const silent = options?.silent === true;
    this.#authorizing = true;
    try {
      const runtime = await this.loadRuntime();
      return await new Promise<GoogleOAuthStatus>((resolve, reject) => {
        let settled = false;
        const finish = (result: { status?: GoogleOAuthStatus; error?: Error }) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (result.error) reject(result.error);
          else resolve(result.status!);
        };
        const timer = globalThis.setTimeout(() => {
          finish({ error: new GoogleOAuthError("authorization_timeout", "Google authorization did not complete in time.") });
        }, silent ? SILENT_AUTHORIZATION_TIMEOUT_MS : AUTHORIZATION_TIMEOUT_MS);
        let client: GoogleTokenClient;
        try {
          client = runtime.initTokenClient({
            client_id: clientId,
            scope: scopes.join(" "),
            include_granted_scopes: false,
            callback: (response) => {
              if (settled) return;
              try {
                if (response.error) {
                  finish({ error: oauthFailure(response.error) });
                  return;
                }
                if (!runtime.hasGrantedAllScopes(response, ...scopes)) {
                  finish({ error: new GoogleOAuthError("scope_not_granted", "Google did not grant the complete Sheets scope.") });
                  return;
                }
                const token = typeof response.access_token === "string" ? response.access_token.trim() : "";
                const seconds = typeof response.expires_in === "string"
                  ? Number(response.expires_in)
                  : response.expires_in;
                if (!token || token.length > TOKEN_MAX_LENGTH || /[\u0000-\u001f\u007f]/.test(token)) {
                  finish({ error: new GoogleOAuthError("invalid_token", "Google returned an invalid access token.") });
                  return;
                }
                if (response.token_type !== undefined && String(response.token_type).toLowerCase() !== "bearer") {
                  finish({ error: new GoogleOAuthError("invalid_token_type", "Google returned an unsupported token type.") });
                  return;
                }
                if (!Number.isFinite(seconds) || (seconds as number) <= 30 || (seconds as number) > 24 * 60 * 60) {
                  finish({ error: new GoogleOAuthError("invalid_expiry", "Google returned an invalid token expiry.") });
                  return;
                }
                this.#credential = Object.freeze({
                  accessToken: token,
                  expiresAtMs: this.now() + Math.floor(seconds as number) * 1000,
                  scopes
                });
                this.#state = "connected";
                finish({ status: this.status() });
              } catch {
                finish({ error: new GoogleOAuthError("invalid_response", "Google authorization returned an invalid response.") });
              }
            },
            error_callback: (error) => finish({ error: popupFailure(error.type) })
          });
          client.requestAccessToken({ prompt: silent ? "" : "select_account" });
        } catch {
          finish({ error: new GoogleOAuthError("authorization_start_failed", "Google authorization could not be started.") });
        }
      });
    } finally {
      this.#authorizing = false;
    }
  }

  async revoke() {
    this.expireIfNeeded();
    const token = this.#credential?.accessToken;
    this.#credential = null;
    this.#state = "disconnected";
    if (!token) return this.status();
    const runtime = await this.loadRuntime();
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      const timer = globalThis.setTimeout(() => {
        finish(new GoogleOAuthError("revoke_timeout", "Google access revocation did not complete in time."));
      }, REVOKE_TIMEOUT_MS);
      try {
        runtime.revoke(token, (response) => {
          try {
            if (response.successful === true || response.error === "invalid_token") finish();
            else finish(new GoogleOAuthError("revoke_failed", "Google access may not have been revoked; check your Google Account permissions."));
          } catch {
            finish(new GoogleOAuthError("revoke_failed", "Google access may not have been revoked; check your Google Account permissions."));
          }
        });
      } catch {
        finish(new GoogleOAuthError("revoke_failed", "Google access may not have been revoked; check your Google Account permissions."));
      }
    });
    return this.status();
  }
}
