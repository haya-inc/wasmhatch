import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ command, mode }) => ({
  base: mode === "github-pages" ? "/wasmhatch/" : "/",
  plugins: [
    {
      name: "html-content-security-policy",
      transformIndexHtml: {
        order: "pre",
        handler() {
          const developmentConnect = command === "serve" ? " ws://localhost:* ws://127.0.0.1:*" : "";
          const googleIdentityBase = "https://accounts.google.com/gsi/";
          const stylePolicy = command === "serve"
            ? "style-src 'self' 'unsafe-inline' https://accounts.google.com/gsi/style"
            : "style-src 'self' https://accounts.google.com/gsi/style";
          const policy = [
            "default-src 'none'",
            "base-uri 'none'",
            "object-src 'none'",
            `frame-src ${googleIdentityBase}`,
            "form-action 'none'",
            "script-src 'self' 'wasm-unsafe-eval' https://accounts.google.com/gsi/client",
            stylePolicy,
            "img-src 'self' data:",
            "font-src 'self'",
            `connect-src 'self' https://api.openai.com https://api.anthropic.com https://api.github.com https://raw.githubusercontent.com https://sheets.googleapis.com https://www.googleapis.com https://docs.googleapis.com ${googleIdentityBase}${developmentConnect}`,
            "worker-src 'self'",
            "manifest-src 'self'"
          ].join("; ");
          return [{
            tag: "meta",
            attrs: { "http-equiv": "Content-Security-Policy", content: policy },
            injectTo: "head"
          }];
        }
      }
    },
    react()
  ],
  server: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
      "Cross-Origin-Embedder-Policy": "credentialless"
    }
  },
  preview: {
    headers: {
      "Cross-Origin-Opener-Policy": "same-origin-allow-popups",
      "Cross-Origin-Embedder-Policy": "credentialless"
    }
  }
}));
