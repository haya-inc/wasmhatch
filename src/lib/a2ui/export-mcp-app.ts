/**
 * Universal Single-File HTML & MCP App (`text/html;profile=mcp-app`) Exporter.
 *
 * Produces a 100% offline, zero-CDN `.html` artifact from any `SerializedSurfaceSnapshot`
 * that:
 * 1. Runs standalone from disk (`file://`) or inside WasmHatch's `ArtifactPanel` with
 *    live two-way `@path` bindings, SVG `VegaChart`, sortable `DataGrid`, and diff views.
 * 2. Speaks the standard MCP Apps (`ext-apps` / `ui://`) JSON-RPC 2.0 guest protocol over
 *    `postMessage` when hosted inside Claude Desktop, Cursor, VS Code, or WasmHatch `McpApp`
 *    (`ui/initialize`, `ui/notifications/initialized`, `ui/notifications/size-changed`,
 *    two-way `ui/notifications/data-model-update` <-> `ui/notifications/data-model-change`,
 *    `ui/notifications/tool-result`, `ui/update-model-context`, and `ui/message`).
 */

import type { SerializedSurfaceSnapshot } from "./runtime";

export const MCP_APP_HTML_MIME = "text/html;profile=mcp-app";

export interface ExportMcpAppOptions {
  title?: string;
  locale?: string;
}

export function escapeHtmlText(raw: string): string {
  return raw
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Escapes `<`, `>`, `&`, U+2028, and U+2029 so arbitrary user/model strings inside
 * `<script type="application/json">` can never terminate the script tag or break JS parsing.
 */
export function serializeSafeJsonForHtml(value: unknown): string {
  return (JSON.stringify(value) ?? "null")
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

export function toExportFileName(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return `${slug || "interactive-app"}.mcp-app.html`;
}

const STANDALONE_STYLES = `
:root {
  color-scheme: light;
  --bg: #f7f6f2;
  --card: #ffffff;
  --text: #1c201d;
  --muted: #5a625c;
  --line: #dfddd5;
  --brand: #1f6f54;
  --brand-deep: #16533e;
  --brand-tint: #e6f2ed;
  --mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  --sans: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  padding: 20px;
  font-family: var(--sans);
  font-size: 14px;
  line-height: 1.5;
  background: var(--bg);
  color: var(--text);
}
.app-shell {
  max-width: 960px;
  margin: 0 auto;
  display: grid;
  gap: 14px;
}
.app-topbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.app-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
}
.app-badge {
  display: inline-flex;
  align-items: center;
  padding: 2px 10px;
  border-radius: 999px;
  background: var(--brand-tint);
  color: var(--brand-deep);
  font-size: 11.5px;
  font-weight: 600;
}
.card {
  background: var(--card);
  border: 1px solid var(--line);
  border-radius: 14px;
  padding: 16px;
  display: grid;
  gap: 12px;
}
.col { display: flex; flex-direction: column; gap: 12px; }
.row { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; }
.field { display: grid; gap: 5px; }
.field label { font-size: 12.5px; font-weight: 600; color: var(--muted); }
input[type="text"], input[type="number"], input[type="password"], input[type="date"], textarea, select {
  width: 100%;
  padding: 8px 10px;
  border: 1px solid var(--line);
  border-radius: 8px;
  font: inherit;
  background: #fff;
  color: var(--text);
}
input[type="range"] { width: 100%; accent-color: var(--brand); }
.btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  padding: 8px 16px;
  border-radius: 999px;
  border: 1px solid var(--line);
  background: var(--card);
  color: var(--text);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}
.btn-primary {
  background: var(--brand);
  border-color: var(--brand);
  color: #fff;
}
.divider { border: 0; border-top: 1px solid var(--line); margin: 4px 0; }
.grid-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12.5px;
}
.grid-table th, .grid-table td {
  padding: 7px 10px;
  border-bottom: 1px solid var(--line);
  text-align: left;
  font-variant-numeric: tabular-nums;
}
.grid-table th button {
  all: unset;
  font-weight: 700;
  cursor: pointer;
}
.code-pre {
  margin: 0;
  padding: 10px 12px;
  border-radius: 8px;
  background: #171917;
  color: #e6ebe2;
  font-family: var(--mono);
  font-size: 12px;
  overflow: auto;
  max-height: 260px;
}
.status-bar {
  font-size: 12px;
  color: var(--brand-deep);
  min-height: 18px;
}
.chart-svg {
  width: 100%;
  height: auto;
  max-height: 260px;
  display: block;
}
`.trim();

const STANDALONE_RUNTIME_SCRIPT = `
(() => {
  const FORBIDDEN = new Set(["__proto__", "constructor", "prototype"]);
  const snapshotEl = document.getElementById("a2ui-snapshot");
  if (!snapshotEl) return;
  let snapshot;
  try {
    snapshot = JSON.parse(snapshotEl.textContent || "{}");
  } catch {
    return;
  }

  const state = {
    data: snapshot && typeof snapshot.dataModel === "object" && snapshot.dataModel ? snapshot.dataModel : {},
    components: new Map(),
    sortState: {},
    tabState: {},
    statusMessage: "",
    mcpConnected: false,
    nextRpcId: 1
  };

  for (const comp of Array.isArray(snapshot.components) ? snapshot.components : []) {
    if (comp && typeof comp.id === "string") {
      state.components.set(comp.id, comp);
    }
  }

  function normalizePtr(raw) {
    if (typeof raw !== "string") return null;
    const t = raw.trim();
    if (!t) return null;
    const s = t.startsWith("$/") ? t.slice(1) : t.startsWith("$") ? "/" + t.slice(1) : t;
    return s.startsWith("/") ? s : "/" + s;
  }

  function getByPointer(ptr) {
    const norm = normalizePtr(ptr);
    if (!norm || norm === "/") return state.data;
    const parts = norm.slice(1).split("/");
    let cur = state.data;
    for (const rawSeg of parts) {
      const seg = rawSeg.replace(/~1/g, "/").replace(/~0/g, "~");
      if (FORBIDDEN.has(seg) || cur === null || typeof cur !== "object") return undefined;
      cur = cur[seg];
    }
    return cur;
  }

  function setByPointer(ptr, val, notifyHost = true) {
    const norm = normalizePtr(ptr);
    if (!norm || norm === "/") return;
    const parts = norm.slice(1).split("/").map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
    if (parts.some((p) => !p || FORBIDDEN.has(p))) return;
    let cur = state.data;
    for (let i = 0; i < parts.length - 1; i += 1) {
      const seg = parts[i];
      if (!cur[seg] || typeof cur[seg] !== "object" || Array.isArray(cur[seg])) {
        cur[seg] = {};
      }
      cur = cur[seg];
    }
    cur[parts[parts.length - 1]] = val;
    renderAll();
    if (notifyHost) {
      postMcpNotification("ui/notifications/data-model-change", {
        key: norm,
        path: norm,
        value: val
      });
      postMcpRequest("ui/update-model-context", {
        content: [{ type: "text", text: JSON.stringify(state.data).slice(0, 4000) }]
      });
    }
  }

  function extractBoundPath(raw) {
    if (typeof raw === "string" && raw.startsWith("$")) return normalizePtr(raw);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      if (typeof raw["@path"] === "string") return normalizePtr(raw["@path"]);
      if (typeof raw.path === "string") return normalizePtr(raw.path);
    }
    return null;
  }

  function resolveVal(raw) {
    const ptr = extractBoundPath(raw);
    if (ptr) return getByPointer(ptr);
    if (raw && typeof raw === "object" && !Array.isArray(raw)) {
      if (typeof raw.literalString === "string") return raw.literalString;
      if (typeof raw.literalNumber === "number") return raw.literalNumber;
      if (typeof raw.literalBoolean === "boolean") return raw.literalBoolean;
    }
    return raw;
  }

  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null || v === false) continue;
        if (k === "className") node.className = String(v);
        else if (k === "textContent") node.textContent = String(v);
        else if (k.startsWith("on") && typeof v === "function") {
          node.addEventListener(k.slice(2).toLowerCase(), v);
        } else {
          node.setAttribute(k, v === true ? "" : String(v));
        }
      }
    }
    if (Array.isArray(children)) {
      for (const child of children) {
        if (child === null || child === undefined) continue;
        node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
      }
    }
    return node;
  }

  function renderChart(props) {
    const spec = resolveVal(props.spec) || {};
    const values = Array.isArray(resolveVal(props.data))
      ? resolveVal(props.data)
      : spec.data && Array.isArray(spec.data.values)
        ? spec.data.values
        : [];
    const mark = typeof spec.mark === "string" ? spec.mark : (spec.mark && spec.mark.type) || "bar";
    const xField = (spec.encoding && spec.encoding.x && spec.encoding.x.field) || "label";
    const yField = (spec.encoding && spec.encoding.y && spec.encoding.y.field) || "value";
    const title = resolveVal(props.title) || spec.title || "";

    const wrap = el("figure", { className: "card" }, []);
    if (title) wrap.appendChild(el("strong", { textContent: String(title) }));
    if (!values.length) {
      wrap.appendChild(el("p", { textContent: "No chart rows." }));
      return wrap;
    }

    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 520 220");
    svg.setAttribute("class", "chart-svg");
    const nums = values.map((r) => Number(r && r[yField]) || 0);
    const maxVal = Math.max(...nums, 1);
    const plotW = 460;
    const plotH = 165;
    const left = 42;
    const top = 16;

    if (mark === "line" || mark === "area") {
      const pts = values.map((r, idx) => {
        const x = left + (values.length === 1 ? plotW / 2 : (idx / (values.length - 1)) * plotW);
        const y = top + plotH - ((Number(r && r[yField]) || 0) / maxVal) * plotH;
        return x.toFixed(1) + "," + y.toFixed(1);
      });
      const poly = document.createElementNS(ns, "polyline");
      poly.setAttribute("fill", "none");
      poly.setAttribute("stroke", "#1f6f54");
      poly.setAttribute("stroke-width", "2.5");
      poly.setAttribute("points", pts.join(" "));
      svg.appendChild(poly);
    } else {
      const step = plotW / Math.max(values.length, 1);
      const barW = Math.max(8, step * 0.68);
      values.forEach((r, idx) => {
        const val = Number(r && r[yField]) || 0;
        const bh = Math.max(2, (val / maxVal) * plotH);
        const rect = document.createElementNS(ns, "rect");
        rect.setAttribute("x", String(left + idx * step + (step - barW) / 2));
        rect.setAttribute("y", String(top + plotH - bh));
        rect.setAttribute("width", String(barW));
        rect.setAttribute("height", String(bh));
        rect.setAttribute("rx", "4");
        rect.setAttribute("fill", "#1f6f54");
        svg.appendChild(rect);

        const lbl = document.createElementNS(ns, "text");
        lbl.setAttribute("x", String(left + idx * step + step / 2));
        lbl.setAttribute("y", String(top + plotH + 18));
        lbl.setAttribute("text-anchor", "middle");
        lbl.setAttribute("font-size", "10");
        lbl.setAttribute("fill", "#5a625c");
        lbl.textContent = String((r && r[xField]) ?? idx + 1).slice(0, 12);
        svg.appendChild(lbl);
      });
    }
    wrap.appendChild(svg);
    return wrap;
  }

  function renderDataGrid(compId, props) {
    const rawRows = resolveVal(props.rows);
    const rows = Array.isArray(rawRows) ? rawRows.slice() : [];
    const rawCols = resolveVal(props.columns);
    const colKeys = Array.isArray(rawCols) && rawCols.length
      ? rawCols.map((c) => (typeof c === "string" ? c : c.key))
      : rows[0] && typeof rows[0] === "object"
        ? Object.keys(rows[0])
        : [];
    const sort = state.sortState[compId] || null;
    if (sort && sort.col) {
      rows.sort((a, b) => {
        const va = a ? a[sort.col] : "";
        const vb = b ? b[sort.col] : "";
        const cmp = typeof va === "number" && typeof vb === "number"
          ? va - vb
          : String(va ?? "").localeCompare(String(vb ?? ""));
        return sort.dir === "desc" ? -cmp : cmp;
      });
    }
    const title = resolveVal(props.title) || "Data table";
    const theadRow = el("tr", {}, colKeys.map((col) =>
      el("th", {}, [
        el("button", {
          type: "button",
          textContent: col + (sort && sort.col === col ? (sort.dir === "asc" ? " ▲" : " ▼") : ""),
          onClick: () => {
            const nextDir = sort && sort.col === col && sort.dir === "asc" ? "desc" : "asc";
            state.sortState[compId] = { col, dir: nextDir };
            renderAll();
          }
        })
      ])
    ));
    const tbody = el("tbody", {}, rows.slice(0, 200).map((row) =>
      el("tr", {}, colKeys.map((col) =>
        el("td", { textContent: row && row[col] !== undefined && row[col] !== null ? String(row[col]) : "" })
      ))
    ));
    return el("section", { className: "card" }, [
      el("strong", { textContent: String(title) }),
      el("table", { className: "grid-table" }, [el("thead", {}, [theadRow]), tbody])
    ]);
  }

  function renderComponent(compId) {
    const comp = state.components.get(compId);
    if (!comp) return null;
    const p = comp.properties || {};

    switch (comp.type) {
      case "Card":
        return el("div", { className: "card" }, [
          typeof p.child === "string" ? renderComponent(p.child) : null
        ]);
      case "Column": {
        const children = Array.isArray(p.children) ? p.children : [];
        return el("div", { className: "col" }, children.map((c) =>
          typeof c === "string" ? renderComponent(c) : c && typeof c.id === "string" ? renderComponent(c.id) : null
        ));
      }
      case "Row": {
        const children = Array.isArray(p.children) ? p.children : [];
        return el("div", { className: "row" }, children.map((c) =>
          typeof c === "string" ? renderComponent(c) : c && typeof c.id === "string" ? renderComponent(c.id) : null
        ));
      }
      case "List": {
        const children = Array.isArray(p.children) ? p.children : [];
        return el("div", { className: "col", role: "list" }, children.map((c) =>
          typeof c === "string" ? renderComponent(c) : c && typeof c.id === "string" ? renderComponent(c.id) : null
        ));
      }
      case "Tabs": {
        const tabs = Array.isArray(p.tabs) ? p.tabs : [];
        const active = state.tabState[compId] || 0;
        return el("div", { className: "col" }, [
          el("div", { className: "row", role: "tablist" }, tabs.map((tab, idx) =>
            el("button", {
              type: "button",
              role: "tab",
              "aria-selected": String(idx === active),
              className: idx === active ? "btn btn-primary" : "btn",
              textContent: String(resolveVal(tab.title) ?? idx + 1),
              onClick: () => {
                state.tabState[compId] = idx;
                renderAll();
              }
            })
          )),
          tabs[active] && typeof tabs[active].child === "string"
            ? renderComponent(tabs[active].child)
            : null
        ]);
      }
      case "Divider":
        return el("hr", { className: "divider" });
      case "Text": {
        const txt = String(resolveVal(p.text) ?? "");
        const variant = p.variant || "body";
        const tag = variant === "h1" ? "h1" : variant === "h2" ? "h2" : variant === "h3" ? "h3" : "p";
        return el(tag, { textContent: txt });
      }
      case "Button": {
        const labelChild = typeof p.child === "string" ? state.components.get(p.child) : null;
        const label = labelChild && labelChild.properties
          ? String(resolveVal(labelChild.properties.text) ?? p.label ?? "Action")
          : String(resolveVal(p.label) ?? "Action");
        const primary = p.variant === "primary";
        return el("button", {
          type: "button",
          className: primary ? "btn btn-primary" : "btn",
          textContent: label,
          onClick: () => {
            const actionName = (p.action && p.action.event && p.action.event.name) || (p.action && p.action.name) || label;
            state.statusMessage = "Triggered: " + actionName;
            renderStatus();
            if (state.mcpConnected) {
              postMcpRequest("ui/message", {
                role: "user",
                content: { type: "text", text: "Action " + actionName + ": " + JSON.stringify(state.data).slice(0, 2000) }
              });
            }
          }
        });
      }
      case "TextField": {
        const bound = extractBoundPath(p.value);
        const val = String(resolveVal(p.value) ?? "");
        const lbl = String(resolveVal(p.label) ?? "");
        const isLong = p.variant === "longText";
        const inputNode = el(isLong ? "textarea" : "input", {
          ...(isLong ? { rows: "3" } : { type: p.variant === "number" ? "number" : "text", value: val }),
          onInput: (e) => {
            const next = p.variant === "number" ? Number(e.target.value) : e.target.value;
            if (bound) setByPointer(bound, next, true);
          }
        });
        if (isLong) inputNode.value = val;
        return el("div", { className: "field" }, [
          lbl ? el("label", { textContent: lbl }) : null,
          inputNode
        ]);
      }
      case "Slider": {
        const bound = extractBoundPath(p.value);
        const num = Number(resolveVal(p.value) ?? p.min ?? 0);
        const lbl = String(resolveVal(p.label) ?? "");
        return el("div", { className: "field" }, [
          el("label", { textContent: (lbl ? lbl + ": " : "") + num }),
          el("input", {
            type: "range",
            min: String(p.min ?? 0),
            max: String(p.max ?? 100),
            step: String(p.step ?? 1),
            value: String(num),
            onChange: (e) => {
              if (bound) setByPointer(bound, Number(e.target.value), true);
            }
          })
        ]);
      }
      case "CheckBox": {
        const bound = extractBoundPath(p.value);
        const checked = Boolean(resolveVal(p.value));
        const lbl = String(resolveVal(p.label) ?? "");
        const box = el("input", {
          type: "checkbox",
          onChange: (e) => {
            if (bound) setByPointer(bound, Boolean(e.target.checked), true);
          }
        });
        box.checked = checked;
        return el("label", { className: "row" }, [box, el("span", { textContent: lbl })]);
      }
      case "ChoicePicker": {
        const bound = extractBoundPath(p.value);
        const current = resolveVal(p.value);
        const curVal = Array.isArray(current) ? String(current[0] ?? "") : String(current ?? "");
        const options = Array.isArray(p.options) ? p.options : [];
        const lbl = String(resolveVal(p.label) ?? "");
        const sel = el("select", {
          onChange: (e) => {
            if (bound) setByPointer(bound, [e.target.value], true);
          }
        }, options.map((opt) => {
          const oVal = String(opt.value ?? "");
          const oNode = el("option", { value: oVal, textContent: String(resolveVal(opt.label) ?? oVal) });
          if (oVal === curVal) oNode.selected = true;
          return oNode;
        }));
        return el("div", { className: "field" }, [
          lbl ? el("label", { textContent: lbl }) : null,
          sel
        ]);
      }
      case "VegaChart":
        return renderChart(p);
      case "DataGrid":
        return renderDataGrid(compId, p);
      case "WorkspaceDiffCard":
      case "WorkspaceFileCard":
        return el("section", { className: "card" }, [
          el("strong", { textContent: String(resolveVal(p.title) || resolveVal(p.path) || "Workspace preview") }),
          el("pre", { className: "code-pre", textContent: String(resolveVal(p.proposedContent) || "") })
        ]);
      case "SlackMessagePreviewCard":
        return el("section", { className: "card" }, [
          el("strong", { textContent: String(resolveVal(p.title) || "Slack preview") }),
          el("pre", { className: "code-pre", textContent: String(resolveVal(p.text) || "") })
        ]);
      case "GoogleSheetRangeCard": {
        const vals = resolveVal(p.values);
        const rows = Array.isArray(vals) ? vals : [];
        return el("section", { className: "card" }, [
          el("strong", { textContent: String(resolveVal(p.title) || "Google Sheet preview") + " (" + String(resolveVal(p.range) || "") + ")" }),
          el("table", { className: "grid-table" }, [
            el("tbody", {}, rows.map((r) =>
              el("tr", {}, (Array.isArray(r) ? r : []).map((c) => el("td", { textContent: String(c ?? "") })))
            ))
          ])
        ]);
      }
      default:
        return null;
    }
  }

  function renderStatus() {
    const statusNode = document.getElementById("app-status");
    if (statusNode) statusNode.textContent = state.statusMessage;
    const badgeNode = document.getElementById("app-mode-badge");
    if (badgeNode) {
      badgeNode.textContent = state.mcpConnected ? "MCP App Connected" : "Offline Standalone";
    }
  }

  function renderAll() {
    const mount = document.getElementById("app-mount");
    if (!mount) return;
    mount.replaceChildren();
    const rootNode = renderComponent(snapshot.rootId || "root");
    if (rootNode) mount.appendChild(rootNode);
    renderStatus();
  }

  // ————— MCP Apps (ui://) JSON-RPC 2.0 Guest Protocol —————
  function postToHost(payload) {
    if (!window.parent || window.parent === window) return;
    window.parent.postMessage(payload, "*");
  }

  function postMcpNotification(method, params) {
    postToHost({ jsonrpc: "2.0", method, params: params || {} });
  }

  function postMcpRequest(method, params) {
    const id = state.nextRpcId++;
    postToHost({ jsonrpc: "2.0", id, method, params: params || {} });
    return id;
  }

  let initReqId = null;

  window.addEventListener("message", (event) => {
    if (!window.parent || event.source !== window.parent) return;
    const msg = event.data;
    if (!msg || typeof msg !== "object" || msg.jsonrpc !== "2.0") return;

    if (initReqId !== null && msg.id === initReqId && msg.result) {
      state.mcpConnected = true;
      renderStatus();
      postMcpNotification("ui/notifications/initialized", {});
      postMcpNotification("ui/notifications/size-changed", {
        height: Math.max(160, Math.ceil(document.documentElement.scrollHeight))
      });
      return;
    }

    if (msg.method === "ui/notifications/data-model-update" && msg.params && msg.params.data) {
      const updates = msg.params.data;
      if (updates && typeof updates === "object") {
        for (const [key, val] of Object.entries(updates)) {
          setByPointer(key, val, false);
        }
      }
      return;
    }

    if (msg.method === "ui/notifications/tool-result" && msg.params) {
      setByPointer("/_toolResult", msg.params, false);
    }
  });

  renderAll();

  if (window.parent && window.parent !== window) {
    initReqId = postMcpRequest("ui/initialize", {
      protocolVersion: "2025-06-18",
      appInfo: { name: document.title || "WasmHatch MCP App", version: "1.0.0" },
      appCapabilities: { a2uiDataModel: { twoWay: true } }
    });
    if (typeof ResizeObserver !== "undefined") {
      const ro = new ResizeObserver(() => {
        if (!state.mcpConnected) return;
        postMcpNotification("ui/notifications/size-changed", {
          height: Math.max(160, Math.ceil(document.documentElement.scrollHeight))
        });
      });
      ro.observe(document.documentElement);
    }
  }
})();
`.trim();

export function exportSurfaceAsUniversalMcpAppHtml(
  snapshot: SerializedSurfaceSnapshot,
  options: ExportMcpAppOptions = {}
): string {
  const title = (options.title?.trim() || snapshot.surfaceId || "Interactive view").slice(0, 80);
  const lang = (options.locale?.trim() || "en").replace(/[^A-Za-z0-9-]/g, "") || "en";
  const safeJson = serializeSafeJsonForHtml(snapshot);
  const escapedTitle = escapeHtmlText(title);

  return [
    "<!doctype html>",
    `<html lang="${escapeHtmlText(lang)}">`,
    "<head>",
    '  <meta charset="utf-8" />',
    '  <meta name="viewport" content="width=device-width, initial-scale=1" />',
    '  <meta http-equiv="Content-Security-Policy" content="default-src \'none\'; script-src \'unsafe-inline\'; style-src \'unsafe-inline\'; img-src data:; font-src data:; connect-src \'none\'; form-action \'none\'; object-src \'none\'; base-uri \'none\'" />',
    '  <meta name="generator" content="WasmHatch Universal MCP App Exporter (text/html;profile=mcp-app)" />',
    `  <title>${escapedTitle}</title>`,
    `  <style>${STANDALONE_STYLES}</style>`,
    "</head>",
    "<body>",
    '  <main class="app-shell">',
    '    <header class="app-topbar">',
    `      <h1 class="app-title">${escapedTitle}</h1>`,
    '      <span id="app-mode-badge" class="app-badge">Offline Standalone</span>',
    "    </header>",
    '    <div id="app-mount"></div>',
    '    <div id="app-status" class="status-bar" role="status" aria-live="polite"></div>',
    "  </main>",
    `  <script id="a2ui-snapshot" type="application/json">${safeJson}</script>`,
    `  <script>${STANDALONE_RUNTIME_SCRIPT}</script>`,
    "</body>",
    "</html>"
  ].join("\n");
}

