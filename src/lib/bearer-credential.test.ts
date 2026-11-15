import { describe, expect, it } from "vitest";
import { createBearerCredentialProvider } from "./bearer-credential";

describe("createBearerCredentialProvider", () => {
  it("returns a frozen bearer provider that trims valid tokens", async () => {
    const provider = createBearerCredentialProvider(() => "  valid-token-123  ");
    expect(Object.isFrozen(provider)).toBe(true);
    expect(provider.kind).toBe("bearer");
    await expect(provider.getToken()).resolves.toBe("valid-token-123");
  });

  it("rejects empty, oversized, or control-character tokens", async () => {
    await expect(createBearerCredentialProvider(() => "   ").getToken()).rejects.toThrow(/invalid token/i);
    await expect(createBearerCredentialProvider(() => "bad\ntoken").getToken()).rejects.toThrow(/invalid token/i);
    await expect(createBearerCredentialProvider(() => "x".repeat(16 * 1024 + 1)).getToken()).rejects.toThrow(/invalid token/i);
  });
});
