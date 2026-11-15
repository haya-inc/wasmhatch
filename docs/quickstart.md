# WasmHatch quickstart

WasmHatch is a static web page — there is nothing to install, no Docker stack
to boot, and no account to create. Open **[wasmhatch.com](https://wasmhatch.com/?view=chat)**
(or run `npm install && npm run dev` locally at `http://localhost:5173/?view=chat`).

## 1. Pick how Pip thinks (30 seconds)

Open the **Settings** sidebar on the right and choose whichever fits your setup:

- **Local & free (Ollama)**: choose **Ollama (local)** (`http://localhost:11434`
  by default; launch Ollama with `OLLAMA_ORIGINS=https://wasmhatch.com ollama serve`
  when using the hosted page). Prompts stay 100% on your machine.
- **On-device & key-free (Chrome built-in AI)**: on supported desktop Chrome
  builds with the Prompt API enabled, choose **Chrome built-in AI**.
- **Bring your own key**: choose **Claude**, **OpenAI**, or **OpenRouter** and
  paste your API key. By default it lives only in the open tab's memory; tick
  **Remember on this device** if you want your browser to keep it locally.

Open DevTools → **Network** at any time to verify: there is no WasmHatch
backend receiving your prompts, keys, or files.

## 2. Clean a messy spreadsheet & build an HTML report

1. In the empty chat, click **Add a sample spreadsheet** to drop
   `wasmhatch-pipeline-sample.csv` into Pip's private browser workspace (or
   upload your own CSV / XLSX / text files).
2. Ask in plain words — for example:
   > Normalize names, regions, amounts, and stages in `wasmhatch-pipeline-sample.csv`, then build a one-page HTML pipeline summary.
3. Watch the run live:
   - Pip runs a local cleanup script (isolated inside a Web Worker with no
     network access) so row counts and totals are computed, never guessed.
   - Every file edit lands in the chat with its exact diff and a one-click
     **Revert** button. Prefer to approve writes before they happen? Switch
     Write mode from **Fast** to **Careful**.
   - The HTML report opens right beside the chat, ready to download as a single
     self-contained `.html` file or print to PDF.

## 3. Hatch a specialist or share a `.agent` file

In the **Hatchlings** sidebar on the left:

1. Click one of the one-click specialist presets under **Or hatch a specialist**:
   - **+ Data wrangler (`Mame`)** — scoped to workspace files, local scripts,
     and the shared ticket board for deterministic CSV/JSON work.
   - **+ Report builder (`Yuzu`)** — scoped to reading files, tickets, and
     building single-file HTML dashboards.
   - **+ Desk runner (`Nori`)** — coordinates tickets, Google files, Slack
     updates, and connected MCP tools.
2. Each hatchling gets its own pixel-art desk, isolated workspace, and chat
   thread. Coordinate across hatchlings with the shared **Tickets** board, or
   toggle **Auto work while this tab is open** for bounded, visible check-ins
   that stop the moment you close the tab.
3. Click **Export .agent** under **Portable agents** to package a hatchling's
   playbook, starter files, and scoped capability list (never your keys) into
   a shareable `.agent` archive — or import one behind a plain-language
   capability preview.

## 4. Connect Google, Slack, search, or local MCP (optional)

- **Google Docs / Sheets / Slides**: click **Connect Google** in the right
  sidebar. WasmHatch uses narrow `drive.file` access — it can create new
  Docs, Sheets, and Slides or open specific existing files you hand over via
  **Pick a Google file**, and cannot browse the rest of your Drive.
- **Slack**: paste an Incoming Webhook URL for a 60-second one-channel setup,
  or connect a Slack bot token ([guide](slack.md)).
- **Web search & page reading**: Claude and OpenRouter keys can use provider
  search directly; any provider can use your Tavily key (`web_search`) and Jina
  Reader key (`fetch_page`).
- **Local MCP**: connect a Streamable HTTP MCP server running on `localhost` /
  `127.0.0.1` so every hatchling can call your local tools.

## 5. Self-host your own copy in 30 seconds

Fork [`haya-inc/wasmhatch`](https://github.com/haya-inc/wasmhatch) on GitHub
and enable GitHub Pages, or deploy to Vercel. See the [fork guide](fork-guide.md)
and [Vercel deployment guide](deploy-vercel.md).
