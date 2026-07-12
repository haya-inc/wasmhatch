import {
  ArrowRight,
  Check,
  Database,
  GitFork,
  Play,
  ShieldCheck,
  Sparkles
} from "lucide-react";

const repositoryUrl = "https://github.com/haya-inc/wasmhatch";

const workflows = [
  {
    number: "01",
    source: "Google Sheets",
    scope: "Sales operations",
    title: "Normalize a weekly pipeline",
    description: "Grant one exact range, materialize a credential-free snapshot, then sandbox and review the resulting cells or report."
  },
  {
    number: "02",
    source: "Spreadsheet + API",
    scope: "Back-office reconciliation",
    title: "Match records across systems",
    description: "Let the agent choose connector reads, calculate exceptions locally, and stage only the required updates."
  },
  {
    number: "03",
    source: "CSV / XLSX",
    scope: "Ad-hoc analysis",
    title: "Turn raw exports into a report",
    description: "Save the generated script and manifest, run against an exact snapshot, then approve the output file diff."
  }
];

export function BusinessLandingPage() {
  const homeUrl = import.meta.env.BASE_URL;
  const operatorUrl = `${homeUrl}?view=operator`;
  const localDemoUrl = `${operatorUrl}&demo=local`;

  return (
    <main className="landing business-landing">
      <header className="site-header">
        <a className="wordmark" href={homeUrl} aria-label="WasmHatch home">WH<span>／02</span></a>
        <nav aria-label="Primary navigation">
          <a href="#how">How it works</a>
          <a href="#workflows">Workflows</a>
          <a href="#trust">Trust model</a>
          <a href={repositoryUrl}>GitHub</a>
        </nav>
        <a className="header-cta" href={localDemoUrl}>Try local demo <ArrowRight size={16} /></a>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-grid" aria-hidden="true" />
        <div className="hero-glow" aria-hidden="true" />
        <div className="hero-copy">
          <p className="kicker reveal reveal-one"><span /> Open-source · browser-native</p>
          <h1 id="hero-title" className="reveal reveal-two"><span>Wasm</span><span>Hatch.</span></h1>
          <p className="hero-promise reveal reveal-three">AI work, with<br />every action visible.</p>
          <div className="hero-actions reveal reveal-four">
            <a className="button button-primary" href={localDemoUrl}>Try in 60 seconds <ArrowRight size={18} /></a>
            <a className="button button-quiet" href={repositoryUrl}><GitFork size={17} /> View source</a>
          </div>
        </div>

        <div className="hero-product reveal reveal-five business-product" aria-label="WasmHatch business operator preview">
          <div className="product-bar">
            <span className="product-mark">WH</span>
            <span>pipeline.xlsx / Forecast</span>
            <span className="local-state"><i /> foreground session</span>
          </div>
          <div className="product-body">
            <div className="product-files">
              <small>SOURCES</small>
              <span className="active">CSV / XLSX</span>
              <span>Google Sheets</span>
              <span>OPFS snapshots</span>
              <span className="connector-note">Local bytes become bounded values + provenance</span>
            </div>
            <div className="business-sheet" aria-label="Example spreadsheet changes">
              <div className="sheet-head"><span>OWNER</span><span>REGION</span><span>AMOUNT</span></div>
              <div><span><del> aya tanaka </del><ins>Aya Tanaka</ins></span><span><del> west </del><ins>WEST</ins></span><span><del>12,400</del><ins>12400</ins></span></div>
              <div><span><del>KEN ITO</del><ins>Ken Ito</ins></span><span>EAST</span><span><del>8300</del><ins>8300</ins></span></div>
              <div><span><del> mei sato </del><ins>Mei Sato</ins></span><span><del> north</del><ins>NORTH</ins></span><span><del>6,250</del><ins>6250</ins></span></div>
            </div>
            <div className="product-agent">
              <small>AGENT ACTIVITY</small>
              <p><Check size={14} /> Read 4 rows</p>
              <p><Check size={14} /> Ran local script</p>
              <p className="agent-current"><Sparkles size={14} /> 12 cells ready</p>
              <button>Review write <ArrowRight size={14} /></button>
            </div>
          </div>
        </div>

        <div className="hero-foot">
          <span>01 / READ</span><span>02 / DECIDE</span><span>03 / TRANSFORM</span><span>04 / APPROVE</span>
          <span>Credentials never enter generated scripts.</span>
        </div>
      </section>

      <section className="workflow" id="how" aria-labelledby="workflow-title">
        <div className="section-label">The operating loop</div>
        <div className="workflow-heading">
          <h2 id="workflow-title">Give AI tools.<br />Keep control.</h2>
          <p>WasmHatch lets the model plan with typed business connectors, while scripts receive data—not credentials—and writes stop for review.</p>
        </div>
        <div className="workflow-sequence">
          <article><span className="step-number">01</span><Database aria-hidden="true" /><h3>Connect the data</h3><p>Authorize a short-lived Google session or grant a local workbook for the foreground task.</p></article>
          <article><span className="step-number">02</span><Play aria-hidden="true" /><h3>Run isolated logic</h3><p>A saved script reads only its declared snapshots and writes only to ephemeral outputs in a resource-limited Wasm Worker.</p></article>
          <article><span className="step-number">03</span><Check aria-hidden="true" /><h3>Approve the effect</h3><p>Review a cell or file diff before anything durable is written. Changed dependencies invalidate the proposal.</p></article>
        </div>
      </section>

      <section className="fit-section" id="capabilities" aria-labelledby="capabilities-title">
        <div className="section-label">Architecture, not magic</div>
        <div className="fit-heading">
          <h2 id="capabilities-title">Browser first.<br />Capability bound.</h2>
          <div><p>The operator imports local workbooks without a server and uses short-lived Google authorization only when requested. File codecs and credentialed connectors remain separate capabilities.</p><a href={`${repositoryUrl}/blob/main/docs/tabular-artifacts.md`}>Read the artifact boundary <ArrowRight size={16} /></a></div>
        </div>
        <div className="fit-list" aria-label="WasmHatch architecture layers">
          <article className="fit-primary"><span>01</span><h3>Artifact worker</h3><p>Turns untrusted CSV/XLSX bytes into bounded values and provenance</p><small>Value-only · no network</small></article>
          <article><span>02</span><h3>Connector broker</h3><p>GIS session token plus manifest-bound operations and resources</p><small>Expiry requires user gesture</small></article>
          <article><span>03</span><h3>Agent checkpoints</h3><p>Reads only identity-bound files or one host-bound Sheets range, then records bounded model egress</p><small>No token or provider ID</small></article>
          <article><span>04</span><h3>Artifact workflow</h3><p>Derives one typed output manifest on the host and mounts only copied inputs inside QuickJS</p><small>Markdown · CSV · JSON · text</small></article>
          <article><span>05</span><h3>Effect review</h3><p>Cell mutations or file diffs bind the reviewed base and payload</p><small>Exact approval</small></article>
          <article><span>06</span><h3>Run journal</h3><p>Joins policy, tools, approvals, conflicts, receipts, and pilot timing</p><small>Credential fields excluded</small></article>
        </div>
      </section>

      <section className="examples-section" id="workflows" aria-labelledby="workflows-title">
        <div className="section-label">Pilot workflows</div>
        <div className="examples-heading">
          <h2 id="workflows-title">Start with<br />real operations.</h2>
          <div><p>The first pilots should validate business outcomes, approval clarity, and time saved—not coding contribution metrics.</p><a className="example-report-link" href={`${repositoryUrl}/issues/new?template=pilot_report.yml`}>Share a sanitized pilot report <ArrowRight size={16} /></a></div>
        </div>
        <div className="example-list">
          {workflows.map((workflow) => (
            <article key={workflow.number}>
              <span className="example-number">{workflow.number}</span>
              <div className="example-repo"><code>{workflow.source}</code><small>{workflow.scope}</small></div>
              <div className="example-copy"><h3>{workflow.title}</h3><p>{workflow.description}</p></div>
              <div className="example-actions"><a href={operatorUrl}>Open demo <ArrowRight size={17} /></a></div>
            </article>
          ))}
        </div>
      </section>

      <section className="proof" aria-label="Example operation log">
        <div className="proof-sticky">
          <p className="section-label">One task. Visible effects.</p>
          <h2>Let the agent reason. Bound what it can do.</h2>
          <p className="proof-copy">Business automation becomes trustworthy when credentials, computation, and external writes are separate capabilities.</p>
          <a href={localDemoUrl} className="text-link">Try without an account or key <ArrowRight size={17} /></a>
        </div>
        <div className="proof-log">
          <div><span>00:00</span><p>Imported <strong>pipeline.xlsx / Forecast</strong> in a codec Worker</p></div>
          <div><span>00:02</span><p>Stored a SHA-256-bound normalized snapshot in OPFS</p></div>
          <div><span>00:03</span><p>Previewed locally, attached one exact hash, then returned a bounded row window</p></div>
          <div><span>00:04</span><p>Staged one typed output path and inspectable script; nothing executed</p></div>
          <div><span>00:05</span><p>Ran <strong>QuickJS Wasm</strong> against exact input snapshots and one ephemeral output</p></div>
          <div className="log-accent"><span>00:06</span><p>Staged an exact file diff; OPFS output still unchanged</p></div>
          <div><span>00:08</span><p>Rechecked manifest, source, input, and base after approval</p></div>
          <div><span>00:09</span><p>Exported a structured run journal with proposal and commit timing</p></div>
          <div><span>00:10</span><p>Verified a portable workspace ZIP; restore still requires exact review</p></div>
        </div>
      </section>

      <section className="trust" id="trust" aria-labelledby="trust-title">
        <div className="section-label">Trust is the operating system</div>
        <h2 id="trust-title">Local-first.<br />Effect-aware.</h2>
        <div className="trust-lines">
          <div><span>Local files</span><strong>Isolated OPFS → verified portable ZIP</strong><em>01</em></div>
          <div><span>Credentials</span><strong>Short-lived GIS → host broker</strong><em>02</em></div>
          <div><span>Model access</span><strong>Reviewed hashes or one exact range · visible tool egress</strong><em>03</em></div>
          <div><span>Scripts</span><strong>Snapshot VFS · no live host access</strong><em>04</em></div>
          <div><span>Writes</span><strong>Cell or file diff approval first</strong><em>05</em></div>
          <div><span>Autonomy</span><strong>Foreground session in alpha</strong><em>06</em></div>
        </div>
        <p className="trust-note"><ShieldCheck size={20} /> The alpha deliberately excludes background execution and persisted OAuth tokens. Those require a separate server trust model.</p>
      </section>

      <section className="final-cta">
        <div><p className="section-label">Foundation slice</p><h2>Operate visibly.</h2></div>
        <div className="final-actions"><a className="button button-dark" href={localDemoUrl}>Run the local demo <ArrowRight size={19} /></a><p>Open source.<br />No account or API key required.</p></div>
      </section>

      <footer className="site-footer">
        <a className="wordmark wordmark-dark" href={homeUrl}>WH<span>／02</span></a>
        <p>Browser-native AI operations with explicit effects.</p>
        <div><a href={repositoryUrl}>GitHub</a><a href={`${repositoryUrl}/blob/main/docs/plan.md`}>Plan</a><span>Apache-2.0</span></div>
      </footer>
    </main>
  );
}
