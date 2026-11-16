import { useCallback, useState, useSyncExternalStore } from "react";
import { t } from "@lingui/core/macro";
import { Trans } from "@lingui/react/macro";
import {
  ArrowRight,
  Bot,
  Check,
  FileSpreadsheet,
  FileText,
  HardDrive,
  LayoutDashboard,
  Lock,
  MessageCircle,
  Minus,
  Package,
  Plug,
  RotateCcw,
  Sparkles,
  Ticket,
  Zap
} from "lucide-react";
import { i18n, localePreference, setLocalePreference } from "../lib/i18n";
import { AUTO_LOCALE, UI_LOCALES } from "../lib/locales";
import type { OfficeCharacter } from "../lib/pixel-office";
import { HatchlingOffice } from "../components/HatchlingOffice";

const repositoryUrl = "https://github.com/haya-inc/wasmhatch";

type ShowcaseChickId = "pip" | "mame" | "yuzu";

export function BusinessLandingPage() {
  useSyncExternalStore(
    useCallback((onStoreChange) => {
      i18n.on("change", onStoreChange);
      return () => { i18n.removeListener("change", onStoreChange); };
    }, []),
    () => i18n.locale,
    () => i18n.locale
  );
  const homeUrl = import.meta.env.BASE_URL;
  const appUrl = `${homeUrl}?view=chat`;
  const [activeChick, setActiveChick] = useState<ShowcaseChickId>("pip");
  const [langPref, setLangPref] = useState<string>(() => localePreference());

  const showcaseChicks: readonly {
    id: ShowcaseChickId;
    character: OfficeCharacter;
    role: string;
    detail: string;
  }[] = [
    {
      id: "pip",
      character: {
        id: "pip",
        name: "Pip",
        species: 0,
        mood: "write",
        running: true,
        scheduled: false,
        selected: activeChick === "pip"
      },
      role: t`Main desk · everyday partner`,
      detail: t`Tidies spreadsheets, drafts Google Docs, and keeps every edit one click from undo.`
    },
    {
      id: "mame",
      character: {
        id: "mame",
        name: "Mame",
        species: 2,
        mood: "tool",
        running: true,
        scheduled: false,
        selected: activeChick === "mame"
      },
      role: t`Data wrangler · isolated workspace`,
      detail: t`Runs local cleanup scripts on CSV and JSON files so counts and totals never rely on guesswork.`
    },
    {
      id: "yuzu",
      character: {
        id: "yuzu",
        name: "Yuzu",
        species: 4,
        mood: "idle",
        running: false,
        scheduled: true,
        selected: activeChick === "yuzu"
      },
      role: t`Report builder · tab-open auto work`,
      detail: t`Checks the shared ticket board on your timer and turns finished notes into single-file HTML dashboards.`
    }
  ];

  const selectedChick = showcaseChicks.find((entry) => entry.id === activeChick) ?? showcaseChicks[0];

  const useCases = [
    {
      icon: FileSpreadsheet,
      title: t`Fix messy spreadsheets`,
      prompt: t`Clean up this export — normalize regions, deduplicate rows, and check the totals.`,
      detail: t`Drop in a CSV or Excel file; local code transforms the rows accurately and lists every change.`
    },
    {
      icon: FileText,
      title: t`Draft docs and decks`,
      prompt: t`Turn these release notes into a Google Doc and a short slide deck.`,
      detail: t`Connect Google in a couple of clicks and hand over only the specific files you pick.`
    },
    {
      icon: LayoutDashboard,
      title: t`Build reports and dashboards`,
      prompt: t`Make a one-page HTML status report I can send to the team.`,
      detail: t`Self-contained HTML pages render right beside the chat, ready to download or share.`
    },
    {
      icon: Plug,
      title: t`Connect Slack, search, and MCP`,
      prompt: t`Post the Q3 highlights to #ops on Slack and check our local MCP tools.`,
      detail: t`60-second Slack setup, cited web search, and loopback MCP servers running on your own machine.`
    }
  ];

  return (
    <div className="fresh home">
      <header className="home-header">
        <a className="home-brand" href={homeUrl}>
          <img src={`${homeUrl}mark.svg`} alt="" aria-hidden="true" />
          WasmHatch
        </a>
        <nav aria-label={t`Primary`}>
          <a href="#setup"><Trans>No setup</Trans></a>
          <a href="#hatchlings"><Trans>Hatchlings</Trans></a>
          <a href="#can-do"><Trans>What it can do</Trans></a>
          <a href="#trust"><Trans>Privacy</Trans></a>
          <a href={repositoryUrl}>GitHub</a>
        </nav>
        <div className="home-header-actions">
          <select
            className="home-lang"
            aria-label={t`Language`}
            value={langPref}
            onChange={(event) => {
              const next = event.target.value;
              setLangPref(next);
              void setLocalePreference(next);
            }}
          >
            <option value={AUTO_LOCALE}>{t`Auto language`}</option>
            {UI_LOCALES.map((entry) => (
              <option key={entry.code} value={entry.code}>{entry.label}</option>
            ))}
          </select>
          <a className="btn btn-brand" href={appUrl}><Trans>Open WasmHatch</Trans></a>
        </div>
      </header>

      <main>
        <section className="home-hero">
          <div>
            <h1 id="hero-title">
              <Trans>The AI assistant that <em>actually does the work.</em></Trans>
            </h1>
            <p className="home-lede">
              <Trans>
                Open the link — no server, no Docker, no signup. Clean messy spreadsheets with local
                code, draft Google Docs and Sheets, build one-file HTML reports, or hatch a tiny team
                of agents right in this tab.
              </Trans>
            </p>
            <div className="home-cta-row">
              <a className="btn btn-brand" href={appUrl}>
                <Trans>Try it now — it’s free</Trans> <ArrowRight size={17} aria-hidden="true" />
              </a>
              <a className="btn btn-ghost" href="#hatchlings"><Trans>Meet the hatchlings</Trans></a>
            </div>
            <ul className="home-assure" role="list">
              <li><Check size={15} aria-hidden="true" /> <Trans>No install, no account</Trans></li>
              <li><Check size={15} aria-hidden="true" /> <Trans>Your API key, local Ollama, or Chrome’s built-in AI</Trans></li>
              <li><Check size={15} aria-hidden="true" /> <Trans>Undo anything in one click</Trans></li>
            </ul>
          </div>

          <div className="home-demo" aria-label={t`Example conversation`}>
            <header><i aria-hidden="true" /> Pip · WasmHatch</header>
            <div className="home-demo-thread">
              <div className="home-msg-user">
                <Trans>Turn this sales export into a clean summary I can share.</Trans>
              </div>
              <div className="home-msg-bot">
                <p><Trans>On it — running a local cleanup script and building your report now.</Trans></p>
                <div className="home-chip">
                  <Check size={14} aria-hidden="true" />
                  <span><Trans><strong>Cleaned</strong> sales-export.csv · 214 fixes</Trans></span>
                  <span className="home-undo"><Trans>Undo</Trans></span>
                </div>
                <div className="home-chip">
                  <Sparkles size={14} aria-hidden="true" />
                  <span><Trans><strong>Created</strong> q3-summary.html — open beside the chat</Trans></span>
                </div>
                <p><Trans>Done! Download the HTML report, update a Google Sheet, or send highlights to Slack.</Trans></p>
              </div>
            </div>
            <footer><MessageCircle size={15} aria-hidden="true" /> <Trans>Ask Pip for anything…</Trans></footer>
          </div>
        </section>

        <section className="home-section" id="setup">
          <h2><Trans>There is no setup.</Trans></h2>
          <p className="home-sub">
            <Trans>
              Built for developers and prosumers tired of maintaining Docker stacks — with a calm,
              plain-language desk instead of config files.
            </Trans>
          </p>
          <div className="home-setup">
            <div className="home-setup-card">
              <h3><Trans>Typical self-hosted or cloud stacks</Trans></h3>
              <ul role="list">
                <li><Minus size={15} aria-hidden="true" /> <Trans>Spin up Docker containers, databases, or desktop apps</Trans></li>
                <li><Minus size={15} aria-hidden="true" /> <Trans>Create another account and upload files to a vendor server</Trans></li>
                <li><Minus size={15} aria-hidden="true" /> <Trans>Keep an always-on machine patched and running</Trans></li>
                <li><Minus size={15} aria-hidden="true" /> <Trans>Wrestle with config files just to wire up tools</Trans></li>
              </ul>
            </div>
            <div className="home-setup-card home-setup-us">
              <h3><Trans>Starting with WasmHatch</Trans></h3>
              <p className="home-setup-big"><Trans>Open the link.</Trans></p>
              <p><Trans>That’s the whole setup — it’s a static web page.</Trans></p>
              <ul role="list">
                <li>
                  <Check size={15} aria-hidden="true" />
                  <span>
                    <Trans>
                      <strong>Local and free:</strong> connect Ollama on your own machine or use Chrome’s
                      built-in AI — no API key at all.
                    </Trans>
                  </span>
                </li>
                <li>
                  <Check size={15} aria-hidden="true" />
                  <span>
                    <Trans>
                      <strong>Bring your own key:</strong> paste a Claude, OpenAI, or OpenRouter key — it
                      stays in your browser and goes straight to that provider.
                    </Trans>
                  </span>
                </li>
                <li>
                  <Check size={15} aria-hidden="true" />
                  <span>
                    <Trans>
                      <strong>Self-host in 30 seconds:</strong> fork on GitHub, enable Pages, done.
                    </Trans>
                  </span>
                </li>
              </ul>
            </div>
          </div>
          <p className="home-setup-note">
            <Trans>
              <strong>Why is it this fast? There’s no account — and no server.</strong> No signup, no
              password, and nothing sitting between your browser and the tools you connect; because no
              server registers you, there’s no account of yours here that could ever leak. Open
              DevTools and check the Network tab yourself.
            </Trans>
          </p>
        </section>

        <section className="home-section" id="hatchlings">
          <h2><Trans>Hatch a tiny team in one tab.</Trans></h2>
          <p className="home-sub">
            <Trans>
              Keep one focused chat, or hatch up to eight named hatchlings at pixel-art desks — each
              with its own private workspace, shared ticket board, and shareable <code>.agent</code> package.
            </Trans>
          </p>
          <div className="home-swarm">
            <div className="home-swarm-stage">
              <div className="home-swarm-canvas-wrap">
                <HatchlingOffice
                  characters={showcaseChicks.map((entry) => entry.character)}
                  onSelect={(id) => {
                    if (id === "pip" || id === "mame" || id === "yuzu") setActiveChick(id);
                  }}
                />
              </div>
              <div className="home-swarm-tabs" role="group" aria-label={t`Inspect a hatchling`}>
                {showcaseChicks.map((entry) => (
                  <button
                    key={entry.id}
                    type="button"
                    className={entry.id === activeChick ? "home-swarm-tab home-swarm-tab-active" : "home-swarm-tab"}
                    aria-pressed={entry.id === activeChick}
                    onClick={() => setActiveChick(entry.id)}
                  >
                    {entry.character.name}
                  </button>
                ))}
              </div>
              <div className="home-swarm-detail">
                <strong>{selectedChick.character.name} — {selectedChick.role}</strong>
                <p>{selectedChick.detail}</p>
              </div>
            </div>

            <div className="home-swarm-points">
              <article className="home-swarm-point">
                <Bot size={20} aria-hidden="true" />
                <div>
                  <h3><Trans>Separate desks, zero collisions</Trans></h3>
                  <p>
                    <Trans>
                      Every hatchling owns an isolated workspace and chat thread — or starts from a
                      one-click specialist preset like Data Wrangler or Report Builder.
                    </Trans>
                  </p>
                </div>
              </article>
              <article className="home-swarm-point">
                <Ticket size={20} aria-hidden="true" />
                <div>
                  <h3><Trans>Shared ticket board &amp; honest auto work</Trans></h3>
                  <p>
                    <Trans>
                      Drop tasks on the board and put a hatchling on a timer while the tab stays open,
                      with a visible run budget, automatic backoff, and one-click pause.
                    </Trans>
                  </p>
                </div>
              </article>
              <article className="home-swarm-point">
                <Package size={20} aria-hidden="true" />
                <div>
                  <h3><Trans>Portable .agent files &amp; local MCP</Trans></h3>
                  <p>
                    <Trans>
                      Package any hatchling’s playbook and scoped permissions (never your keys) into a
                      shareable <code>.agent</code> file or link, and plug in local MCP servers.
                    </Trans>
                  </p>
                </div>
              </article>
            </div>
          </div>
        </section>

        <section className="home-section" id="can-do">
          <h2><Trans>One assistant for the busywork.</Trans></h2>
          <p className="home-sub">
            <Trans>
              The tedious parts of everyday work — cleaning local data, drafting documents, shipping
              clean HTML deliverables — described in a sentence, done in moments.
            </Trans>
          </p>
          <div className="home-cards">
            {useCases.map((useCase) => (
              <a key={useCase.title} className="home-card" href={appUrl}>
                <useCase.icon size={22} aria-hidden="true" />
                <h3>{useCase.title}</h3>
                <blockquote>&ldquo;{useCase.prompt}&rdquo;</blockquote>
                <p>{useCase.detail}</p>
              </a>
            ))}
          </div>
        </section>

        <section className="home-section" id="how">
          <h2><Trans>How it works</Trans></h2>
          <p className="home-sub"><Trans>No setup wizard, no manual. Three moments, start to done.</Trans></p>
          <div className="home-steps">
            <article className="home-step">
              <span>1</span>
              <h3><Trans>Say what you need</Trans></h3>
              <p><Trans>Type it like you’d tell a teammate. Drop in local files, connect Google in a couple of clicks, or point at local Ollama or MCP.</Trans></p>
            </article>
            <article className="home-step">
              <span>2</span>
              <h3><Trans>Watch it happen</Trans></h3>
              <p><Trans>It gets to work right away. Every tool call and file edit appears live in the conversation — no black box.</Trans></p>
            </article>
            <article className="home-step">
              <span>3</span>
              <h3><Trans>Keep it or undo it</Trans></h3>
              <p><Trans>Each change shows its exact diff with one-click undo. Prefer to approve writes first? Switch on Careful mode.</Trans></p>
            </article>
          </div>
        </section>

        <section className="home-section" id="trust">
          <h2><Trans>Fast, and still yours.</Trans></h2>
          <p className="home-sub"><Trans>Speed and approachability don’t have to cost you control or verifiable privacy.</Trans></p>
          <div className="home-trust">
            <article>
              <Zap size={20} aria-hidden="true" />
              <h3><Trans>It just acts</Trans></h3>
              <p><Trans>No approval pop-ups slowing every step by default. The assistant does the work and shows exact diffs as it goes.</Trans></p>
            </article>
            <article>
              <RotateCcw size={20} aria-hidden="true" />
              <h3><Trans>Everything is undoable</Trans></h3>
              <p><Trans>Every workspace edit records what changed before and after. One click puts your file back the way it was.</Trans></p>
            </article>
            <article>
              <Lock size={20} aria-hidden="true" />
              <h3><Trans>Private by design</Trans></h3>
              <p>
                <Trans>
                  Everything lives in your browser tab — there is no WasmHatch server to upload your
                  files to. Prompts go straight to the provider you chose, or stay 100% on your machine
                  with Ollama or Chrome’s built-in AI.
                </Trans>
              </p>
            </article>
            <article>
              <HardDrive size={20} aria-hidden="true" />
              <h3><Trans>Yours to keep</Trans></h3>
              <p>
                <Trans>
                  Pin browser storage so your workspaces stay put, export individual hatchlings as{" "}
                  <code>.agent</code> files, or download a full ZIP backup in one click.
                </Trans>
              </p>
            </article>
          </div>
        </section>

        <section className="home-section">
          <div className="home-oss">
            <Sparkles size={18} aria-hidden="true" />
            <span>
              <Trans>
                <strong>Free and open source</strong> under Apache-2.0 — audit every line, fork to
                GitHub Pages in seconds, or help build it.
              </Trans>
            </span>
            <a href={repositoryUrl}><Trans>Star on GitHub</Trans> <ArrowRight size={14} aria-hidden="true" /></a>
          </div>
        </section>

        <section className="home-section home-final">
          <h2><Trans>What should Pip do for you first?</Trans></h2>
          <p><Trans>Open the tab and ask. That’s the whole onboarding.</Trans></p>
          <a className="btn btn-brand" href={appUrl}>
            <Trans>Open WasmHatch</Trans> <ArrowRight size={17} aria-hidden="true" />
          </a>
        </section>
      </main>

      <footer className="home-footer">
        <a className="home-brand" href={homeUrl}>
          <img src={`${homeUrl}mark.svg`} alt="" aria-hidden="true" />
          WasmHatch
        </a>
        <span><Trans>Your AI team in a single browser tab — no server, no signup.</Trans></span>
        <a href={repositoryUrl}>GitHub</a>
        <a href={`${repositoryUrl}/blob/main/CONTRIBUTING.md`}><Trans>Contribute</Trans></a>
        <a href={`${homeUrl}privacy.html`}><Trans>Privacy</Trans></a>
        <span>Apache-2.0</span>
      </footer>
    </div>
  );
}
