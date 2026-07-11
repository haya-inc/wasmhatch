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
  });

  it("keeps the PNG preview at the recommended 1200 by 630 dimensions", () => {
    const png = readFileSync("public/social-preview.png");
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(1200);
    expect(png.readUInt32BE(20)).toBe(630);
    expect(png.byteLength).toBeGreaterThan(20_000);
  });
});
