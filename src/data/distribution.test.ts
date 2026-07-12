import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("distribution policy", () => {
  it("fails closed against publishing the browser application to npm", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as Record<string, unknown>;

    expect(packageJson.private).toBe(true);
    expect(packageJson).not.toHaveProperty("publishConfig");
    expect(packageJson).not.toHaveProperty("exports");
    expect(packageJson).not.toHaveProperty("files");
  });

  it("documents GitHub as the current release channel and OIDC as the future package boundary", () => {
    const policy = readFileSync("docs/distribution.md", "utf8");

    expect(policy).toContain("static application; not an npm package");
    expect(policy).toContain("GitHub Releases");
    expect(policy).toContain("private: true");
    expect(policy).toContain("npm Trusted Publishing");
    expect(policy).toContain("short-lived OIDC identity");
  });
});
