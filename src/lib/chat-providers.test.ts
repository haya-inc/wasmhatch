import { describe, expect, it } from "vitest";
import {
  CLOUD_PROVIDERS,
  CLOUD_PROVIDER_IDS,
  PROVIDER_CONNECT_SRCS,
  getCloudProvider,
  isCloudProviderId
} from "./chat-providers";

describe("cloud provider registry", () => {
  it("keeps every provider internally consistent", () => {
    for (const provider of CLOUD_PROVIDERS) {
      expect(provider.models.length, `${provider.id} has models`).toBeGreaterThan(0);
      const values = provider.models.map((model) => model.value);
      expect(values, `${provider.id} default is a listed model`).toContain(provider.defaultModel);
      expect(new Set(values).size, `${provider.id} model values are unique`).toBe(values.length);
      // The base URL must live under the CSP-allowed origin, or the request is blocked at runtime.
      const underOrigin = provider.baseUrl === provider.connectSrc || provider.baseUrl.startsWith(`${provider.connectSrc}/`);
      expect(underOrigin, `${provider.id} baseUrl under connectSrc`).toBe(true);
    }
  });

  it("offers exactly the three key types Anthropic, OpenAI, and OpenRouter", () => {
    expect(CLOUD_PROVIDER_IDS).toEqual(["anthropic", "openai", "openrouter"]);
  });

  it("only lets the OpenAI direct provider use the completion-tokens param", () => {
    // Every gateway/compatible server uses max_tokens; only OpenAI's own API renamed it.
    for (const provider of CLOUD_PROVIDERS) {
      const expected = provider.id === "openai" ? "max_completion_tokens" : "max_tokens";
      expect(provider.maxTokensParam, provider.id).toBe(expected);
    }
  });

  it("pins every connect-src to an exact https origin, never a wildcard or http", () => {
    for (const origin of PROVIDER_CONNECT_SRCS) {
      expect(origin).toMatch(/^https:\/\/[a-z0-9.-]+$/);
    }
  });

  it("routes only Anthropic through the anthropic adapter", () => {
    for (const provider of CLOUD_PROVIDERS) {
      expect(provider.adapter, provider.id).toBe(provider.id === "anthropic" ? "anthropic" : "openai");
    }
  });

  it("lets OpenRouter fan out to other creators' models behind its one key", () => {
    const openrouter = getCloudProvider("openrouter");
    const creators = new Set(openrouter.models.map((model) => model.value.split("/")[0]));
    expect(creators.size, "OpenRouter spans multiple creators").toBeGreaterThan(1);
  });

  it("recognizes registry ids and rejects everything else", () => {
    expect(isCloudProviderId("openrouter")).toBe(true);
    expect(isCloudProviderId("builtin")).toBe(false);
    expect(isCloudProviderId("gemini")).toBe(false);
    expect(getCloudProvider("openrouter").host).toBe("openrouter.ai");
  });
});
