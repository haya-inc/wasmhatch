import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const projectUrl = "https://haya-inc.github.io/wasmhatch/";
const previewUrl = `${projectUrl}social-preview.png`;

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
    expect(html).toContain("open-source, browser-native AI operator");
    expect(robots).toContain(`Sitemap: ${projectUrl}sitemap.xml`);
    expect(sitemap).toContain(`<loc>${projectUrl}</loc>`);
    expect(sitemap).toContain("<lastmod>2026-07-12</lastmod>");
  });

  it("keeps the PNG preview at the recommended 1200 by 630 dimensions", () => {
    const png = readFileSync("public/social-preview.png");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    expect(png.byteLength).toBeGreaterThan(20_000);
  });

  it("keeps public runtime claims aligned with the shipped architecture", () => {
    const readme = readFileSync("README.md", "utf8");
    const plan = readFileSync("docs/plan.md", "utf8");
    const viteConfig = readFileSync("vite.config.ts", "utf8");

    expect(readme).toContain("QuickJS compiled to Wasm and executed in a Web Worker");
    expect(readme).toContain("Worker-isolated CSV/XLSX import");
    expect(plan).toContain("A browser-native AI operator for visible, permissioned business work");
    expect(plan).toContain("no host functions, network, DOM, OPFS, OAuth token, or model client");
    expect(plan).toContain("formula/macro/external-link handling — complete");
    expect(viteConfig).toContain('"worker-src \'self\'"');
    expect(viteConfig).toContain("'wasm-unsafe-eval'");
    expect(viteConfig).toContain("https://sheets.googleapis.com");
    expect(viteConfig).toContain("https://accounts.google.com/gsi/client");
    expect(viteConfig).toContain('"same-origin-allow-popups"');
  });
});
