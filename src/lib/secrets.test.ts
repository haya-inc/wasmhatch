import { describe, expect, it } from "vitest";
import { isProtectedAgentPath } from "./secrets";

describe("isProtectedAgentPath", () => {
  it.each([
    ".env",
    ".env.local",
    "apps/web/.env.production",
    ".npmrc",
    ".ssh/id_ed25519",
    ".aws/credentials",
    "config/service-account-prod.json",
    "certs/server.pem",
    "infra/terraform.tfstate"
  ])("protects common credential path %s", (path) => {
    expect(isProtectedAgentPath(path)).toBe(true);
  });

  it.each([
    "README.md",
    "src/secrets.ts",
    "docs/environment.md",
    "infra/main.tf",
    "config/public.json"
  ])("keeps ordinary project path %s available", (path) => {
    expect(isProtectedAgentPath(path)).toBe(false);
  });
});
