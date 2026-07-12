# Chrome built-in AI planner

> Optional, feature-detected local planning for one active table.

- Status: pilot adapter; not a cross-browser product requirement
- Runtime: top-level Chrome `LanguageModel` Prompt API
- Effect authority: none
- Network boundary: Chrome may download model files; task and table inference stay on device

## Why this adapter exists

The static alpha otherwise needs each pilot participant to bring an OpenAI API
key before natural-language planning works. On a compatible Chrome desktop,
the Prompt API can produce the same bounded script proposal without a WasmHatch
server or API key. This reduces pilot friction without making a browser-specific
API part of the core effect protocol.

The adapter is optional. Feature detection returns `available`, `downloadable`,
`downloading`, or `unavailable`. Unsupported browsers and devices continue to
use the OpenAI Responses adapter or a manually inspected script.

## Exact boundary

The local planner receives only:

- the visible business task, limited to 2,000 characters; and
- the current table, limited to 200 rows, 50 columns, and 128 KB of serialized
  JSON.

`LanguageModel.create()` receives a system instruction that treats every cell
as untrusted data. `prompt()` receives the same JSON Schema used by the strict
OpenAI function tool. The host parses JSON, rejects unknown or missing fields,
and re-applies summary, list, and script-size bounds. Model output may stage one
synchronous JavaScript function expression; it cannot run that function or
authorize a write.

After planning, all existing checkpoints remain:

1. The user inspects or edits the script.
2. QuickJS executes it in the Wasm Worker with no network, DOM, credentials, or
   live OPFS.
3. The host derives typed mutations from the result.
4. The user reviews the exact cells.
5. Approval still rechecks the source before a durable effect.

The Prompt API is currently exposed to the top-level document rather than Web
Workers. This does not weaken script isolation: the browser model returns inert
JSON text, while generated code still runs only in the existing QuickJS Worker.
The session is destroyed after every plan, including malformed-output failures.

## Supported and unsupported planning

The Chrome adapter supports a transformation of the one active table. It does
not yet support:

- workspace attachments;
- checkpointed list/read/search tools;
- artifact-output planning;
- multi-connector selection; or
- background execution.

Those flows remain on the OpenAI bounded tool loop. The UI refuses to silently
drop an attachment or downgrade artifact-output intent.

## Platform and maturity limits

Chrome documents the web Prompt API for Chrome 148 and lists desktop hardware,
storage, and initial-download requirements. At the time of this decision, the
foundation-model APIs require a supported desktop OS, at least 22 GB free on the
Chrome profile volume, and either more than 4 GB VRAM or at least 16 GB RAM plus
four CPU cores. Mobile Chrome is not supported. Chrome states that model input
is not sent to Google or another third party, although model files may be
downloaded on first use:

- https://developer.chrome.com/docs/ai/prompt-api
- https://developer.chrome.com/docs/ai/built-in-ai-dos-donts

The Prompt API specification is a Web Machine Learning Community Group draft,
not a W3C Standard or Recommendation:

- https://webmachinelearning.github.io/prompt-api/

Therefore WasmHatch commits to the provider-neutral planner behavior, not the
`LanguageModel` API. Feature detection and OpenAI fallback are permanent parts
of this adapter's acceptance criteria.

## Why WebLLM or Transformers.js is not bundled now

WebLLM and Transformers.js demonstrate viable local inference, but selecting
and shipping a model would also select model weights, license, cache size,
quality, WebGPU support, download UX, and device requirements for the project.
That is a much larger dependency and maintenance decision than adapting a
feature-detected browser capability. Both remain candidates if pilots show
enough demand on non-Chrome devices to justify representative quality and
startup benchmarks:

- https://webllm.mlc.ai/docs/
- https://huggingface.co/docs/transformers.js/

Popularity or local execution alone is not sufficient. Any promoted runtime
must produce valid bounded plans on representative workflows and preserve the
same review and effect protocol.
