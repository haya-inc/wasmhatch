import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
const encodedPolicy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
const policy = encodedPolicy?.replaceAll("&#39;", "'").replaceAll("&amp;", "&");

if (!policy) throw new Error("Built index.html is missing its Content Security Policy.");

const requiredDirectives = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src 'none'",
  "form-action 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "connect-src 'self' https://api.openai.com https://api.anthropic.com https://api.github.com https://raw.githubusercontent.com https://sheets.googleapis.com",
  "worker-src 'self'"
];

for (const directive of requiredDirectives) {
  if (!policy.includes(directive)) throw new Error(`Built CSP is missing: ${directive}`);
}

for (const forbidden of ["'unsafe-inline'", "'unsafe-eval'", " ws:", " http:"]) {
  if (policy.includes(forbidden)) throw new Error(`Built CSP contains forbidden source: ${forbidden}`);
}

for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
  if (!/\bsrc=/.test(match[1]) || match[2].trim()) {
    throw new Error("Built index.html contains an inline script.");
  }
}

if (!html.includes('name="referrer" content="strict-origin-when-cross-origin"')) {
  throw new Error("Built index.html is missing its referrer policy.");
}

console.log("Built security policy verified.");
