# Conversation-first product direction

Status: canonical UX direction
Updated: 2026-07-12

WasmHatch is a general-work AI workspace, not a spreadsheet application and not
a coding IDE. A spreadsheet is one possible source of context. The product
should be understood through the work a person can complete: understand
information, compare records, transform data, prepare an update, and create a
useful artifact.

## Product promise

> Describe the work. Review the result.

The primary interaction is a natural conversation. A user can begin with an
outcome in their own words, add context when it becomes useful, inspect what
WasmHatch proposes, and continue with a follow-up. Source selection, scripts,
connector configuration, run journals, and sandbox details support that loop;
they are not the default information hierarchy.

## UX rules

1. **Lead with jobs, not infrastructure.** Show requests such as “compare these
   records” or “create a concise report” before terms such as OPFS, QuickJS,
   Worker, manifest, or connector broker.
2. **Keep one obvious next action.** The normal entry is a request composer.
   Context and activity controls are secondary and visible in the header.
3. **Reveal complexity at the moment it matters.** Sources open when context is
   needed. Review opens when an effect is staged. Script and sandbox details are
   available in an expandable technical section.
4. **Let the conversation teach the product.** Example requests demonstrate the
   range of work without requiring a feature tour. Responses explain what was
   read, what was prepared, and what requires a decision.
5. **Never hide authority.** Progressive disclosure must not weaken the effect
   boundary. Before a durable change, the user still sees the exact target and
   diff and must explicitly approve it.
6. **Do not promise unshipped integrations.** General framing describes a reusable
   interaction model. Concrete entry points name only capabilities that work in
   the current release.

## Current surface

`?view=work` is the default task surface. It provides:

- a blank natural-language request rather than a preselected spreadsheet task;
- four examples covering cleanup, comparison, report creation, and Google
  Sheets updates;
- optional Context and Activity panels;
- plain-language output choices: **Update data** and **Create a file**;
- a **Set up AI** action that reveals and focuses the provider boundary when no
  on-device model or session provider is ready;
- execution details collapsed by default; and
- automatic review visibility when a real cell or file proposal is staged.

`?view=operator` remains the advanced surface. It exposes all source, planner,
sandbox, workspace, review, and journal controls at once for development,
auditing, and power-user workflows. Both surfaces use the same runtime,
proposal, approval, and connector implementation.

## Shipped work and honest limits

The current release can import CSV/XLSX, use a foreground Google Sheets range,
run bounded QuickJS/Wasm transformations, create reviewed Markdown/CSV/JSON/text
artifacts, and preserve an inspectable local workspace and run journal. Local
files do not need a WasmHatch server.

Google Drive/Docs, calendars, task systems, mail, background schedules, and
multi-step unattended work remain roadmap items. They should enter the same
conversation and review model only after their connector and effect boundaries
exist in code.

## Acceptance checks for future UX work

- A first-time user can name at least three kinds of useful work without reading
  architecture documentation.
- The initial viewport contains one primary action and no required technical
  vocabulary.
- Adding context, preparing an effect, reviewing it, and continuing the task are
  possible without switching to the advanced surface.
- Every simplified path exercises the production Worker/sandbox/proposal code;
  examples must not be decorative simulations.
- Desktop and 390 px mobile layouts have no horizontal overflow.
