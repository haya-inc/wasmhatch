import { readFileSync } from "node:fs";

const html = readFileSync(new URL("../dist/index.html", import.meta.url), "utf8");
const encodedPolicy = html.match(/http-equiv="Content-Security-Policy" content="([^"]+)"/)?.[1];
const metaPolicy = encodedPolicy?.replaceAll("&#39;", "'").replaceAll("&amp;", "&");

if (!metaPolicy) throw new Error("Built index.html is missing its Content Security Policy.");

const vercelConfig = JSON.parse(readFileSync(new URL("../vercel.json", import.meta.url), "utf8"));
const rootRule = vercelConfig.headers?.find((rule) => rule.source === "/(.*)");
const headerMap = new Map((rootRule?.headers ?? []).map((entry) => [entry.key, entry.value]));
const vercelPolicy = headerMap.get("Content-Security-Policy");

if (!vercelPolicy) throw new Error("vercel.json is missing its /(.*) Content-Security-Policy header.");

const requiredDirectives = [
  "default-src 'none'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-src https://accounts.google.com/gsi/ https://docs.google.com https://drive.google.com",
  "form-action 'none'",
  "script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client https://apis.google.com",
  "style-src 'self' https://accounts.google.com/gsi/style",
  "img-src 'self' data: https://*.googleusercontent.com https://ssl.gstatic.com",
  "font-src 'self'",
  "worker-src 'self'",
  "manifest-src 'self'"
];

// connect-src is order-independent, so check each allowed origin individually.
// This list is the security bar itself — kept explicit here on purpose. It must
// stay in sync with vite.config.ts (LLM providers from src/lib/chat-providers.ts
// plus the non-LLM connector origins) and vercel.json; a drift makes the build fail here.
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
  "https://slides.googleapis.com",
  "https://hooks.slack.com",
  "https://slack.com",
  "https://api.tavily.com",
  "https://r.jina.ai",
  "https://apis.google.com",
  "https://content.googleapis.com",
  "https://accounts.google.com/gsi/",
  // MCP: any Streamable-HTTP server on the user's own machine, any port.
  // Loopback-only http is the same audited exception Ollama uses; remote MCP
  // origins (VITE_EXTRA_MCP_SERVERS) are https and deployment-specific, so
  // they are not required here.
  "http://localhost:*",
  "http://127.0.0.1:*"
];

function verifyPolicy(policy, label, { requireFrameAncestors = false } = {}) {
  for (const directive of requiredDirectives) {
    if (!policy.includes(directive)) throw new Error(`${label} is missing: ${directive}`);
  }
  if (requireFrameAncestors && !policy.includes("frame-ancestors 'none'")) {
    throw new Error(`${label} is missing: frame-ancestors 'none'`);
  }

  const connectSrc = policy.match(/connect-src ([^;]+)/)?.[1] ?? "";
  if (!connectSrc) throw new Error(`${label} is missing its connect-src directive.`);
  const tokens = connectSrc.split(/\s+/);
  for (const origin of requiredConnectSrc) {
    if (!tokens.includes(origin)) throw new Error(`${label} connect-src is missing: ${origin}`);
  }

  for (const forbidden of ["'unsafe-inline'", "'unsafe-eval'", " ws:"]) {
    if (policy.includes(forbidden)) throw new Error(`${label} contains forbidden source: ${forbidden}`);
  }

  // http: is forbidden as a network scheme, with one audited exception: loopback
  // (localhost / 127.0.0.1), which browsers treat as trustworthy and where local
  // runtimes like Ollama serve. Any other http:// source fails the build.
  for (const src of policy.match(/http:\/\/[^\s;'"]+/g) ?? []) {
    const host = src.slice("http://".length).split(/[:/]/)[0];
    if (host !== "localhost" && host !== "127.0.0.1") {
      throw new Error(`${label} contains a non-loopback http source: ${src}`);
    }
  }
}

verifyPolicy(metaPolicy, "Built meta CSP");
verifyPolicy(vercelPolicy, "vercel.json header CSP", { requireFrameAncestors: true });

if (headerMap.get("X-Frame-Options") !== "DENY") {
  throw new Error("vercel.json is missing X-Frame-Options: DENY.");
}
if (headerMap.get("Referrer-Policy") !== "strict-origin-when-cross-origin") {
  throw new Error("vercel.json Referrer-Policy must match index.html (strict-origin-when-cross-origin).");
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
