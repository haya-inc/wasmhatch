import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const projectUrl = "https://wasmhatch.com/";
const previewUrl = `${projectUrl}social-preview.png?v=0.45.0`;

describe("public sharing metadata", () => {
  it("publishes canonical Open Graph and large-card metadata", () => {
    const html = readFileSync("index.html", "utf8");
    expect(html).toContain(`<meta property="og:url" content="${projectUrl}" />`);
    expect(html).toContain(`<meta property="og:image" content="${previewUrl}" />`);
    expect(html).toContain('<meta property="og:image:width" content="1200" />');
    expect(html).toContain('<meta property="og:image:height" content="630" />');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect(html).toContain(`<meta name="twitter:image" content="${previewUrl}" />`);
    expect(html).toContain(`<link rel="canonical" href="${projectUrl}" />`);
    expect(html).toContain('<meta name="robots" content="index, follow, max-image-preview:large" />');
    expect(html).toContain('href="https://github.com/haya-inc/wasmhatch/releases.atom"');
  });

  it("publishes crawler discovery files and a useful no-script fallback", () => {
    const html = readFileSync("index.html", "utf8");
    const robots = readFileSync("public/robots.txt", "utf8");
    const sitemap = readFileSync("public/sitemap.xml", "utf8");

    expect(html).toContain("<noscript>");
    expect(html).toContain("free, open-source AI assistant");
    expect(robots).toContain(`Sitemap: ${projectUrl}sitemap.xml`);
    expect(sitemap).toContain(`<loc>${projectUrl}</loc>`);
    expect(sitemap).toContain("<lastmod>2026-07-13</lastmod>");
  });

  it("keeps the PNG preview at the recommended 1200 by 630 dimensions", () => {
    const png = readFileSync("public/social-preview.png");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    expect(png.byteLength).toBeGreaterThan(20_000);
  });

  it("keeps the social preview reproducible and aligned with general work", () => {
    const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as { scripts?: Record<string, string> };
    const renderer = readFileSync("scripts/render-social-preview.mjs", "utf8");

    expect(packageJson.scripts?.["render:social"]).toBe("node scripts/render-social-preview.mjs");
    expect(renderer).toContain("actually does the work.");
    expect(renderer).toContain("Undo");
    expect(renderer).not.toContain("Review the result.");
    expect(renderer).not.toContain("REVIEW CHANGES");
  });

  it("keeps public runtime claims aligned with the shipped architecture", () => {
    const readme = readFileSync("README.md", "utf8");
    const plan = readFileSync("docs/plan.md", "utf8");
    const launchPlaybook = readFileSync("docs/launch-playbook.md", "utf8");
    const viteConfig = readFileSync("vite.config.ts", "utf8");

    expect(readme).toContain("compiled to Wasm inside a Web Worker");
    expect(readme).toContain("What it can't do yet");
    expect(readme).toContain("undo is one click");
    expect(plan).toContain("general AI agent that runs entirely in a browser tab");
    expect(plan).toContain("Generated code executes in the Wasm sandbox");
    expect(plan).toContain("Outside the boundary (stated, not hidden)");
    expect(plan).toContain("Approval is a mode,");
    expect(readFileSync("docs/workspace-scripts.md", "utf8")).toContain("each output is reviewed and committed as its own proposal");
    expect(plan).toContain("BYOK streaming chat across Anthropic / OpenAI-compatible providers");
    expect(readFileSync("docs/agent-loop-design.md", "utf8")).toContain("Budgets are soft");
    expect(readFileSync("docs/workspace-agent-loop.md", "utf8")).toContain("Provider usage is required in every response");
    expect(readFileSync("docs/run-journal.md", "utf8")).toContain("The decision ID is bound into the effect proposal");
    expect(readFileSync("docs/operator-workspace-portability.md", "utf8")).toContain("Selecting a ZIP does not replace files");
    expect(readFileSync("docs/operator-artifact-browser.md", "utf8")).toContain("Listing or previewing never sends file content");
    expect(readFileSync("docs/workspace-artifact-workflows.md", "utf8")).toContain("the host derives all filesystem authority");
    expect(readme).toContain("**No server.**");
    expect(readme).toContain("held in the memory");
    expect(readme).toContain("Remember on this device");
    expect(launchPlaybook).toContain("## Gate: the five launch conditions");
    expect(launchPlaybook).toContain("Non-sensitive `drive.file` only");
    expect(launchPlaybook).toContain("Measurement stays analytics-free");
    expect(viteConfig).toContain('"worker-src \'self\'"');
    expect(viteConfig).toContain("'wasm-unsafe-eval'");
    expect(viteConfig).toContain("https://sheets.googleapis.com");
    // The Sensitive-scope connectors (Slides, Calendar) must be in the static CSP
    // allowlist so the audit never depends on the runtime opt-in flag. Calendar is
    // served from www.googleapis.com (already allowed); Slides needs its own host.
    expect(viteConfig).toContain("https://slides.googleapis.com");
    expect(viteConfig).toContain("https://docs.googleapis.com");
    expect(viteConfig).toContain("https://accounts.google.com/gsi/client");
    expect(viteConfig).toContain('"same-origin-allow-popups"');
  });
});
