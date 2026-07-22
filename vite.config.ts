import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { lingui } from "@lingui/vite-plugin";
import { transformAsync } from "@babel/core";
import { PROVIDER_CONNECT_SRCS } from "./src/lib/chat-providers";
import { buildMcpServers, mcpConnectSources } from "./src/lib/mcp-servers";

/**
 * Compile Lingui macros (t, Trans, ...) in every .ts/.tsx module, not just the
 * ones @vitejs/plugin-react touches, so plain lib files and Vitest runs see
 * compiled messages too. JSX is left alone for the react plugin.
 */
function linguiMacros(): Plugin {
  return {
    name: "lingui-macros",
    enforce: "pre",
    async transform(code, id) {
      const file = id.split("?")[0];
      if (!/\.tsx?$/.test(file) || file.includes("node_modules")) return null;
      if (!code.includes("@lingui/core/macro") && !code.includes("@lingui/react/macro")) return null;
      const result = await transformAsync(code, {
        filename: file,
        babelrc: false,
        configFile: false,
        parserOpts: { plugins: file.endsWith(".tsx") ? ["typescript", "jsx"] : ["typescript"] },
        plugins: ["@lingui/babel-plugin-lingui-macro"],
        sourceMaps: true
      });
      return result?.code ? { code: result.code, map: result.map } : null;
    }
  };
}

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
          // LLM provider origins come from the audited registry; these are the non-LLM
          // connector origins (GitHub import, Google Drive/Docs/Sheets/Slides REST, and
          // Google Calendar, which is served from www.googleapis.com). Slides and Calendar
          // are only reached when the deployment opts into Sensitive scopes, but the CSP
          // stays static so the audit never depends on a runtime flag.
          const connectorOrigins = "https://api.github.com https://raw.githubusercontent.com https://sheets.googleapis.com https://www.googleapis.com https://docs.googleapis.com https://slides.googleapis.com";
          // MCP origins come from the same audited-registry pattern as model
          // providers: wildcard-port loopback for the user's own machine, plus
          // exact remote origins a deployment bakes in via VITE_EXTRA_MCP_SERVERS.
          const mcpOrigins = mcpConnectSources(
            buildMcpServers(loadEnv(mode, process.cwd(), "VITE_").VITE_EXTRA_MCP_SERVERS)
          ).join(" ");
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
            `connect-src 'self' ${PROVIDER_CONNECT_SRCS.join(" ")} ${connectorOrigins} ${mcpOrigins} ${googleIdentityBase}${developmentConnect}`,
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
    linguiMacros(),
    react(),
    lingui()
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
