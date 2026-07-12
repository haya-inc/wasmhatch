import {
  ArrowRight,
  Check,
  FileSpreadsheet,
  FileText,
  FolderOpen,
  LayoutDashboard,
  Lock,
  MessageCircle,
  RotateCcw,
  Sparkles,
  Zap
} from "lucide-react";

const repositoryUrl = "https://github.com/haya-inc/wasmhatch";

const useCases = [
  {
    icon: FileSpreadsheet,
    title: "Fix messy spreadsheets",
    prompt: "Clean up this export — the names and amounts are all over the place.",
    detail: "Drop in a CSV or Excel file and it comes back tidy, with every change listed."
  },
  {
    icon: FileText,
    title: "Draft docs and decks",
    prompt: "Turn these notes into a Google Doc and a short slide deck.",
    detail: "Connect Google once and it creates Docs, Sheets, and Slides for you."
  },
  {
    icon: LayoutDashboard,
    title: "Build reports and dashboards",
    prompt: "Make a one-page report I can send to the team.",
    detail: "Polished pages appear right beside the chat, ready to download and share."
  },
  {
    icon: FolderOpen,
    title: "Organize your files",
    prompt: "Merge these three lists and flag anything that looks off.",
    detail: "It reads, compares, and rewrites files in a private workspace in your browser."
  }
] as const;

export function BusinessLandingPage() {
  const homeUrl = import.meta.env.BASE_URL;
  const appUrl = `${homeUrl}?view=chat`;

  return (
    <div className="fresh home">
      <header className="home-header">
        <a className="home-brand" href={homeUrl} aria-label="WasmHatch home">
          <img src={`${homeUrl}mark.svg`} alt="" aria-hidden="true" />
          WasmHatch
        </a>
        <nav aria-label="Primary navigation">
          <a href="#can-do">What it can do</a>
          <a href="#how">How it works</a>
          <a href="#trust">Privacy</a>
          <a href={repositoryUrl}>GitHub</a>
        </nav>
        <a className="btn btn-brand" href={appUrl}>Open WasmHatch</a>
      </header>

      <main>
        <section className="home-hero" aria-labelledby="hero-title">
          <div>
            <h1 id="hero-title">The AI assistant that <em>actually does the work.</em></h1>
            <p className="home-lede">
              Ask for what you need in plain words. WasmHatch cleans your spreadsheets, writes
              your docs, and builds your reports — right here in your browser, while you watch.
            </p>
            <div className="home-cta-row">
              <a className="btn btn-brand" href={appUrl}>Try it now — it&rsquo;s free <ArrowRight size={17} /></a>
              <a className="btn btn-ghost" href="#how">See how it works</a>
            </div>
            <ul className="home-assure">
              <li><Check size={15} /> No install, no account</li>
              <li><Check size={15} /> Your files stay on your device</li>
              <li><Check size={15} /> Undo anything in one click</li>
            </ul>
          </div>

          <div className="home-demo" aria-label="Example conversation">
            <header><i /> WasmHatch</header>
            <div className="home-demo-thread">
              <div className="home-msg-user">Turn this sales export into a clean summary I can share.</div>
              <div className="home-msg-bot">
                <p>On it — tidying the data and building your summary now.</p>
                <div className="home-chip">
                  <Check size={14} />
                  <span><strong>Cleaned</strong> sales-export.csv · 214 fixes</span>
                  <span className="home-undo">Undo</span>
                </div>
                <div className="home-chip">
                  <Sparkles size={14} />
                  <span><strong>Created</strong> Q3 summary — open beside the chat</span>
                </div>
                <p>Done! The summary is ready to download. Want it as a Google Doc too?</p>
              </div>
            </div>
            <footer><MessageCircle size={15} /> Ask for anything…</footer>
          </div>
        </section>

        <section className="home-section" id="can-do" aria-labelledby="can-do-title">
          <h2 id="can-do-title">One assistant for the busywork.</h2>
          <p className="home-sub">
            The tedious parts of everyday work — cleaning data, drafting documents, pulling
            things together — described in a sentence, done in moments.
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

        <section className="home-section" id="how" aria-labelledby="how-title">
          <h2 id="how-title">How it works</h2>
          <p className="home-sub">No setup wizard, no manual. Three moments, start to done.</p>
          <div className="home-steps">
            <article className="home-step">
              <span>1</span>
              <h3>Say what you need</h3>
              <p>Type it like you&rsquo;d tell a colleague. Add a file if it helps, or connect Google in a couple of clicks.</p>
            </article>
            <article className="home-step">
              <span>2</span>
              <h3>Watch it happen</h3>
              <p>It gets to work immediately. Every step shows up in the conversation as it runs — no black box.</p>
            </article>
            <article className="home-step">
              <span>3</span>
              <h3>Keep it or undo it</h3>
              <p>Each change lists exactly what happened, with one-click undo. Prefer to approve things first? Turn on Careful mode.</p>
            </article>
          </div>
        </section>

        <section className="home-section" id="trust" aria-labelledby="trust-title">
          <h2 id="trust-title">Fast, and still yours.</h2>
          <p className="home-sub">Speed doesn&rsquo;t have to cost you control or privacy.</p>
          <div className="home-trust">
            <article>
              <Zap size={20} aria-hidden="true" />
              <h3>It just acts</h3>
              <p>No approval pop-ups slowing every step. The assistant does the work and keeps you in the picture as it goes.</p>
            </article>
            <article>
              <RotateCcw size={20} aria-hidden="true" />
              <h3>Everything is undoable</h3>
              <p>Every change is shown with exactly what changed. One click puts it back the way it was.</p>
            </article>
            <article>
              <Lock size={20} aria-hidden="true" />
              <h3>Private by design</h3>
              <p>It runs in your browser tab. Your files stay on your device, and your keys never leave this tab or get stored anywhere.</p>
            </article>
          </div>
        </section>

        <section className="home-section">
          <div className="home-oss">
            <Sparkles size={18} aria-hidden="true" />
            <span><strong>Free and open source</strong> under Apache-2.0 — read every line, run it yourself, or help build it.</span>
            <a href={repositoryUrl}>Star on GitHub <ArrowRight size={14} /></a>
          </div>
        </section>

        <section className="home-section home-final">
          <h2>What should it do for you first?</h2>
          <p>Open it and ask. That&rsquo;s the whole onboarding.</p>
          <a className="btn btn-brand" href={appUrl}>Open WasmHatch <ArrowRight size={17} /></a>
        </section>
      </main>

      <footer className="home-footer">
        <a className="home-brand" href={homeUrl}>
          <img src={`${homeUrl}mark.svg`} alt="" aria-hidden="true" />
          WasmHatch
        </a>
        <span>Your AI assistant, right in the browser.</span>
        <a href={repositoryUrl}>GitHub</a>
        <a href={`${repositoryUrl}/blob/main/CONTRIBUTING.md`}>Contribute</a>
        <a href={`${homeUrl}privacy.html`}>Privacy</a>
        <span>Apache-2.0</span>
      </footer>
    </div>
  );
}
