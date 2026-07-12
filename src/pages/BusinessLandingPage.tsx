import {
  ArrowRight,
  Check,
  FileText,
  MessageCircle,
  Paperclip,
  ShieldCheck,
  Sparkles
} from "lucide-react";

const repositoryUrl = "https://github.com/haya-inc/wasmhatch";
const contributorUrl = `${repositoryUrl}/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22`;
const contributorGuideUrl = `${repositoryUrl}/blob/main/CONTRIBUTING.md`;
const codespacesUrl = "https://codespaces.new/haya-inc/wasmhatch?quickstart=1";

const workExamples = [
  {
    title: "Clean up an export",
    prompt: "Standardize the names and regions, and make the amounts usable.",
    detail: "CSV and XLSX stay in the browser while WasmHatch prepares exact cell changes."
  },
  {
    title: "Compare records",
    prompt: "Find the mismatches between the ERP export and the payout records.",
    detail: "Turn repetitive reconciliation into a short exception list you can review."
  },
  {
    title: "Create a useful report",
    prompt: "Summarize the important findings as a concise Markdown report.",
    detail: "Create a reviewed file from bounded snapshots without giving scripts live access."
  },
  {
    title: "Prepare a Sheets update",
    prompt: "Review this range and prepare only the changes that need my attention.",
    detail: "Connect Google Sheets for the current session and approve before any write."
  }
] as const;

const starterIssues = [
  { number: 13, title: "Make write review easier to focus", scope: "Accessibility" },
  { number: 14, title: "Fail closed when guided counts drift", scope: "Safety invariant" },
  { number: 15, title: "Expose the selected source clearly", scope: "Accessibility" }
] as const;

export function BusinessLandingPage() {
  const homeUrl = import.meta.env.BASE_URL;
  const workUrl = `${homeUrl}?view=work`;
  const sampleUrl = `${workUrl}&demo=local`;

  return (
    <main className="landing work-landing">
      <header className="site-header work-site-header">
        <a className="wordmark" href={homeUrl} aria-label="WasmHatch home">WH<span>／02</span></a>
        <nav aria-label="Primary navigation">
          <a href="#possibilities">What it can do</a>
          <a href="#how">How it works</a>
          <a href="#trust">Trust</a>
          <a href={repositoryUrl}>GitHub</a>
        </nav>
        <a className="header-cta" href={workUrl}>Start a task <ArrowRight size={16} /></a>
      </header>

      <section className="work-hero" aria-labelledby="hero-title">
        <div className="work-hero-copy">
          <p className="kicker"><span /> Open-source · browser-native</p>
          <h1 id="hero-title">Describe the work.<br /><em>Review the result.</em></h1>
          <p className="work-hero-lede">WasmHatch is an AI workspace for everyday work. Add the context you choose, explain the outcome in natural language, and stay in control of every change.</p>
          <div className="hero-actions">
            <a className="button button-primary" href={workUrl}>Start a task <ArrowRight size={18} /></a>
            <a className="button button-quiet" href={sampleUrl}>Try a safe sample</a>
          </div>
          <p className="hero-assurance"><ShieldCheck size={14} /> No account needed for local files. Nothing writes without approval.</p>
        </div>

        <div className="conversation-preview" aria-label="Conversation-first work preview">
          <header><span className="product-mark">WH</span><strong>New task</strong><small><i /> Ready</small></header>
          <div className="preview-thread">
            <div className="preview-welcome">
              <Sparkles size={18} />
              <p><strong>What do you want to get done?</strong><span>I can work with files and connected sheets, compare records, and create reviewed outputs.</span></p>
            </div>
            <div className="preview-prompt"><Paperclip size={15} /><span>pipeline.csv</span><p>Find inconsistent owner names and prepare a clean version.</p></div>
            <div className="preview-answer"><span><Check size={14} /></span><p><strong>I found 3 names to standardize.</strong><small>I prepared the exact before-and-after values. Nothing has changed yet.</small><button>Review 3 changes <ArrowRight size={13} /></button></p></div>
          </div>
          <footer><MessageCircle size={15} /><span>Ask a follow-up or describe the next step…</span></footer>
        </div>
      </section>

      <section className="work-possibilities" id="possibilities" aria-labelledby="possibilities-title">
        <div className="section-label">Start with the outcome</div>
        <div className="work-section-heading">
          <h2 id="possibilities-title">Work that starts with a request,<br />not a tool.</h2>
          <p>A spreadsheet is one kind of context—not the product. The same conversation can move from understanding information to transforming it and producing a useful result.</p>
        </div>
        <div className="work-example-grid">
          {workExamples.map((example, index) => (
            <a key={example.title} href={`${workUrl}${index === 1 ? "&demo=reconciliation" : index === 0 ? "&demo=local" : index === 2 ? "&example=report" : "&example=sheets"}`}>
              <span>0{index + 1}</span>
              <h3>{example.title}</h3>
              <blockquote>“{example.prompt}”</blockquote>
              <p>{example.detail}</p>
              <em>Try this request <ArrowRight size={14} /></em>
            </a>
          ))}
        </div>
      </section>

      <section className="work-how" id="how" aria-labelledby="how-title">
        <div className="section-label">One understandable loop</div>
        <h2 id="how-title">Talk naturally.<br />See what happens.</h2>
        <div className="work-steps">
          <article><span>01</span><Paperclip /><div><h3>Add context when it helps</h3><p>Choose a local file, a workspace artifact, or a Google Sheets range. WasmHatch shows what is in scope.</p></div></article>
          <article><span>02</span><MessageCircle /><div><h3>Describe the outcome</h3><p>Ask in plain language and continue the conversation. Execution details stay available without taking over the screen.</p></div></article>
          <article><span>03</span><Check /><div><h3>Review the real effect</h3><p>Inspect exact cell or file changes before saving. If the source changes, the old proposal becomes invalid.</p></div></article>
        </div>
      </section>

      <section className="work-trust" id="trust" aria-labelledby="trust-title">
        <div>
          <p className="section-label">Control without the complexity</p>
          <h2 id="trust-title">The technical boundary stays underneath the conversation.</h2>
        </div>
        <div className="work-trust-points">
          <p><ShieldCheck size={18} /><span><strong>Local by default</strong>Files are parsed in a Worker and are not uploaded to a WasmHatch server.</span></p>
          <p><FileText size={18} /><span><strong>Bounded execution</strong>Scripts receive copied snapshots—not credentials, the DOM, live storage, or unrestricted network access.</span></p>
          <p><Check size={18} /><span><strong>Approval before effects</strong>Durable changes wait for an exact diff review, with the decision recorded in the run journal.</span></p>
          <a href={`${repositoryUrl}/blob/main/docs/conversation-first-ux.md`}>Read the product and UX direction <ArrowRight size={15} /></a>
        </div>
      </section>

      <section className="work-contribute" id="contribute" aria-labelledby="contribute-title">
        <div className="work-section-heading">
          <div><p className="section-label">Open source</p><h2 id="contribute-title">Help make AI work understandable.</h2></div>
          <div><p>Small, scoped issues use synthetic data and explicit acceptance criteria.</p><a href={contributorGuideUrl}>Contributor guide <ArrowRight size={15} /></a><a href={codespacesUrl}>Open a Codespace <ArrowRight size={15} /></a></div>
        </div>
        <div className="work-issue-list">
          {starterIssues.map((issue) => <a key={issue.number} href={`${repositoryUrl}/issues/${issue.number}`}><span>#{issue.number}</span><small>{issue.scope}</small><strong>{issue.title}</strong><ArrowRight size={15} /></a>)}
        </div>
      </section>

      <section className="work-final-cta">
        <Sparkles size={24} />
        <h2>What do you want to get done?</h2>
        <p>Start with a sample, a file, or simply a request.</p>
        <a className="button button-primary" href={workUrl}>Open WasmHatch <ArrowRight size={18} /></a>
      </section>

      <footer className="site-footer work-footer">
        <a className="wordmark wordmark-dark" href={homeUrl}>WH<span>／02</span></a>
        <p>Open-source AI work with visible, permissioned effects.</p>
        <div><a href={repositoryUrl}>GitHub</a><a href={contributorUrl}>Contribute</a><a href={`${repositoryUrl}/blob/main/docs/plan.md`}>Plan</a><span>Apache-2.0</span></div>
      </footer>
    </main>
  );
}
