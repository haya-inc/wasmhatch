import { describe, expect, it, vi } from "vitest";
import {
  ARTIFACT_IFRAME_CSP,
  ARTIFACT_IFRAME_SANDBOX,
  CHAT_ARTIFACT_MAX_BYTES,
  artifactDownloadName,
  createArtifactExecutor,
  withInjectedCsp
} from "./artifact";

describe("createArtifactExecutor", () => {
  it("stages a valid artifact and confirms to the model", async () => {
    const onArtifact = vi.fn();
    const execute = createArtifactExecutor(onArtifact);
    const outcome = await execute("create_artifact", { title: "Q3 Report", html: "<h1>Q3</h1>" }, {});
    expect(outcome.isError).toBeFalsy();
    expect(outcome.content).toContain("Q3 Report");
    expect(onArtifact).toHaveBeenCalledWith({ title: "Q3 Report", html: "<h1>Q3</h1>" });
  });

  it("rejects empty title and empty html", async () => {
    const onArtifact = vi.fn();
    const execute = createArtifactExecutor(onArtifact);
    expect((await execute("create_artifact", { title: " ", html: "<p>x</p>" }, {})).isError).toBe(true);
    expect((await execute("create_artifact", { title: "t", html: "  " }, {})).isError).toBe(true);
    expect(onArtifact).not.toHaveBeenCalled();
  });

  it("rejects plain text that is not markup", async () => {
    const execute = createArtifactExecutor(vi.fn());
    const outcome = await execute("create_artifact", { title: "t", html: "just words" }, {});
    expect(outcome.isError).toBe(true);
    expect(outcome.content).toContain("does not look like an HTML document");
  });

  it("rejects oversized documents", async () => {
    const onArtifact = vi.fn();
    const execute = createArtifactExecutor(onArtifact);
    const big = `<p>${"x".repeat(CHAT_ARTIFACT_MAX_BYTES)}</p>`;
    const outcome = await execute("create_artifact", { title: "t", html: big }, {});
    expect(outcome.isError).toBe(true);
    expect(onArtifact).not.toHaveBeenCalled();
  });

  it("rejects overlong titles and unknown tools", async () => {
    const execute = createArtifactExecutor(vi.fn());
    expect((await execute("create_artifact", { title: "x".repeat(201), html: "<p>x</p>" }, {})).isError).toBe(true);
    expect((await execute("other_tool", { title: "t", html: "<p>x</p>" }, {})).isError).toBe(true);
  });
});

describe("artifactDownloadName", () => {
  it("slugifies titles into safe filenames", () => {
    expect(artifactDownloadName("Q3 Revenue Report")).toBe("q3-revenue-report.html");
    expect(artifactDownloadName("  Über: déjà vu!  ")).toBe("uber-deja-vu.html");
    expect(artifactDownloadName("日本語のみ")).toBe("artifact.html");
    expect(artifactDownloadName("")).toBe("artifact.html");
  });

  it("caps the filename length", () => {
    const name = artifactDownloadName("a".repeat(500));
    expect(name.length).toBeLessThanOrEqual(64 + ".html".length);
    expect(name.endsWith(".html")).toBe(true);
  });
});

describe("iframe isolation constants", () => {
  it("never grants same-origin access to artifact frames", () => {
    expect(ARTIFACT_IFRAME_SANDBOX).toBe("allow-scripts");
    expect(ARTIFACT_IFRAME_SANDBOX).not.toContain("allow-same-origin");
  });

  it("denies all external sources in the artifact CSP", () => {
    expect(ARTIFACT_IFRAME_CSP).toContain("default-src 'none'");
    expect(ARTIFACT_IFRAME_CSP).not.toMatch(/https?:/);
  });
});

describe("withInjectedCsp", () => {
  it("inserts the meta right after an existing head tag", () => {
    const result = withInjectedCsp("<html><head><title>t</title></head><body></body></html>");
    expect(result).toContain(`<head><meta http-equiv="Content-Security-Policy" content="${ARTIFACT_IFRAME_CSP}"><title>t</title>`);
  });

  it("handles head tags with attributes", () => {
    const result = withInjectedCsp('<head lang="en"><title>t</title></head>');
    expect(result.indexOf("Content-Security-Policy")).toBeGreaterThan(result.indexOf('<head lang="en">'));
    expect(result.indexOf("Content-Security-Policy")).toBeLessThan(result.indexOf("<title>"));
  });

  it("prepends a head when the document has none", () => {
    const result = withInjectedCsp("<h1>bare</h1>");
    expect(result.startsWith("<head><meta http-equiv=\"Content-Security-Policy\"")).toBe(true);
    expect(result.endsWith("<h1>bare</h1>")).toBe(true);
  });
});
