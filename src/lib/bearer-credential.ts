export interface BearerCredentialProvider {
  readonly kind: "bearer";
  getToken(signal?: AbortSignal): Promise<string>;
}

const MAX_CREDENTIAL_LENGTH = 16 * 1024;

function containsInvalidTokenCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 32 || code >= 127) return true;
  }
  return false;
}

function validateBearerToken(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("Credential provider returned no token.");
  }
  const token = value.trim();
  if (!token || token.length > MAX_CREDENTIAL_LENGTH || containsInvalidTokenCharacters(token)) {
    throw new Error("Credential provider returned an invalid token.");
  }
  return token;
}

export function createBearerCredentialProvider(
  getToken: (signal?: AbortSignal) => string | Promise<string>
): BearerCredentialProvider {
  if (typeof getToken !== "function") {
    throw new Error("Bearer credential provider requires a token callback.");
  }
  return Object.freeze({
    kind: "bearer" as const,
    getToken: async (signal?: AbortSignal) => validateBearerToken(await getToken(signal))
  });
}
