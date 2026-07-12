import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface DevContainerConfig {
  name?: unknown;
  image?: unknown;
  init?: unknown;
  remoteUser?: unknown;
  forwardPorts?: unknown;
  portsAttributes?: unknown;
  postCreateCommand?: unknown;
  customizations?: unknown;
  [key: string]: unknown;
}

const config = JSON.parse(
  readFileSync(new URL("../../.devcontainer/devcontainer.json", import.meta.url), "utf8")
) as DevContainerConfig;

describe("contributor dev container", () => {
  it("pins a non-privileged Node 22 environment with deterministic setup", () => {
    expect(config).toMatchObject({
      name: "WasmHatch contributor",
      image: "mcr.microsoft.com/devcontainers/javascript-node:4-22-bookworm",
      init: true,
      remoteUser: "node",
      forwardPorts: [5173],
      postCreateCommand: "npm ci && npx playwright install --with-deps chromium"
    });
    expect(config).not.toHaveProperty("privileged");
    expect(config).not.toHaveProperty("capAdd");
    expect(config).not.toHaveProperty("mounts");
    expect(config).not.toHaveProperty("containerEnv");
    expect(config).not.toHaveProperty("remoteEnv");
  });

  it("opens only the Vite preview port and installs the Playwright editor integration", () => {
    expect(config.portsAttributes).toEqual({
      "5173": {
        label: "WasmHatch development server",
        onAutoForward: "openPreview"
      }
    });
    expect(config.customizations).toEqual({
      vscode: { extensions: ["ms-playwright.playwright"] }
    });
  });
});
