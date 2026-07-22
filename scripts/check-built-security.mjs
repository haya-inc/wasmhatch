import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
const encodedPolicy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
const policy = encodedPolicy?.replaceAll("&#39;", "'").replaceAll("&amp;", "&");

if (!policy) throw new Error("Built index.html is missing its Content Security Policy.");

const requiredDirectives = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src https://accounts.google.com/gsi/",
  "form-action 'none'",
  "script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client",
  "style-src 'self' https://accounts.google.com/gsi/style",
  "worker-src 'self'"
];

for (const directive of requiredDirectives) {
  if (!policy.includes(directive)) throw new Error(`Built CSP is missing: ${directive}`);
}

// connect-src is order-independent, so check each allowed origin individually.
// This list is the security bar itself — kept explicit here on purpose. It must
// stay in sync with vite.config.ts (LLM providers from src/lib/chat-providers.ts
// plus the non-LLM connector origins); a drift makes the build fail here.
const requiredConnectSrc = [
  "'self'",
  "https://api.openai.com",
  "https://api.anthropic.com",
  "https://openrouter.ai",
  "http://localhost:11434",
  "https://api.github.com",
  "https://raw.githubusercontent.com",
  "https://sheets.googleapis.com",
  "https://www.googleapis.com",
  "https://docs.googleapis.com",
  "https://hooks.slack.com",
  "https://slack.com",
  "https://accounts.google.com/gsi/",
  // MCP: any Streamable-HTTP server on the user's own machine, any port.
  // Loopback-only http is the same audited exception Ollama uses; remote MCP
  // origins (VITE_EXTRA_MCP_SERVERS) are https and deployment-specific, so
  // they are not required here.
  "http://localhost:*",
  "http://127.0.0.1:*"
];

const connectSrc = policy.match(/connect-src ([^;]+)/)?.[1] ?? "";
if (!connectSrc) throw new Error("Built CSP is missing its connect-src directive.");
for (const origin of requiredConnectSrc) {
  if (!connectSrc.split(/\s+/).includes(origin)) throw new Error(`Built CSP connect-src is missing: ${origin}`);
}

for (const forbidden of ["'unsafe-inline'", "'unsafe-eval'", " ws:"]) {
  if (policy.includes(forbidden)) throw new Error(`Built CSP contains forbidden source: ${forbidden}`);
}

// http: is forbidden as a network scheme, with one audited exception: loopback
// (localhost / 127.0.0.1), which browsers treat as trustworthy and where local
// runtimes like Ollama serve. Any other http:// source fails the build.
for (const src of policy.match(/http:\/\/[^\s;'"]+/g) ?? []) {
  const host = src.slice("http://".length).split(/[:/]/)[0];
  if (host !== "localhost" && host !== "127.0.0.1") {
    throw new Error(`Built CSP contains a non-loopback http source: ${src}`);
  }
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
