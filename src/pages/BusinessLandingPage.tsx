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
    description: "Read a bounded range, clean names and amounts in a Wasm sandbox, then review every changed cell."
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
    description: "Transform local tabular data without installing Python or uploading credentials to a script runtime."
  }
];

export function BusinessLandingPage() {
  const homeUrl = import.meta.env.BASE_URL;
  const operatorUrl = `${homeUrl}?view=operator`;

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
        <a className="header-cta" href={operatorUrl}>Open operator <ArrowRight size={16} /></a>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-grid" aria-hidden="true" />
        <div className="hero-glow" aria-hidden="true" />
        <div className="hero-copy">
          <p className="kicker reveal reveal-one"><span /> Open-source · browser-native</p>
          <h1 id="hero-title" className="reveal reveal-two"><span>Wasm</span><span>Hatch.</span></h1>
          <p className="hero-promise reveal reveal-three">AI work, with<br />every action visible.</p>
          <div className="hero-actions reveal reveal-four">
            <a className="button button-primary" href={operatorUrl}>Run the local demo <ArrowRight size={18} /></a>
            <a className="button button-quiet" href={repositoryUrl}><GitFork size={17} /> View source</a>
          </div>
        </div>

        <div className="hero-product reveal reveal-five business-product" aria-label="WasmHatch business operator preview">
          <div className="product-bar">
            <span className="product-mark">WH</span>
            <span>weekly pipeline / Sheet1!A1:D20</span>
            <span className="local-state"><i /> foreground session</span>
          </div>
          <div className="product-body">
            <div className="product-files">
              <small>CONNECTORS</small>
              <span className="active">Google Sheets</span>
              <span>Local workbook</span>
              <span>HTTP API</span>
              <span className="connector-note">Broker attaches tokens after validation</span>
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
              <p className="agent-current"><Sparkles size={14} /> 8 cells ready</p>
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
          <article><span className="step-number">01</span><Database aria-hidden="true" /><h3>Connect the data</h3><p>Grant a bounded spreadsheet range or local workbook for the current browser session.</p></article>
          <article><span className="step-number">02</span><Play aria-hidden="true" /><h3>Run isolated logic</h3><p>The agent can compose a transformation that runs in a resource-limited Wasm Worker without network access.</p></article>
          <article><span className="step-number">03</span><Check aria-hidden="true" /><h3>Approve the effect</h3><p>Review cell-level changes and the complete audit trail before an external API write occurs.</p></article>
        </div>
      </section>

      <section className="fit-section" id="capabilities" aria-labelledby="capabilities-title">
        <div className="section-label">Architecture, not magic</div>
        <div className="fit-heading">
          <h2 id="capabilities-title">Browser first.<br />Capability bound.</h2>
          <div><p>The first release works while the user is present. Versioned connector manifests bind operations and resources; the host broker keeps raw credentials out of connector code.</p><a href={`${repositoryUrl}/blob/main/docs/connector-authoring.md`}>Build a connector <ArrowRight size={16} /></a></div>
        </div>
        <div className="fit-list" aria-label="WasmHatch architecture layers">
          <article className="fit-primary"><span>01</span><h3>Connector broker</h3><p>Manifest-bound operations, resources, origins, and response limits</p><small>No raw credential in connector code</small></article>
          <article><span>02</span><h3>Agent planner</h3><p>Selects tools and prepares bounded operations</p><small>No raw tokens</small></article>
          <article><span>03</span><h3>Wasm script worker</h3><p>Transforms JSON and tabular data under CPU and memory limits</p><small>No fetch or DOM</small></article>
          <article><span>04</span><h3>Write review</h3><p>Shows exact cells and destinations before mutation</p><small>Human in loop</small></article>
          <article><span>05</span><h3>Audit trail</h3><p>Records model egress, tool calls, scripts, and approvals</p><small>Inspectable</small></article>
        </div>
      </section>

      <section className="examples-section" id="workflows" aria-labelledby="workflows-title">
        <div className="section-label">Pilot workflows</div>
        <div className="examples-heading">
          <h2 id="workflows-title">Start with<br />real operations.</h2>
          <p>The first pilots should validate business outcomes, approval clarity, and time saved—not coding contribution metrics.</p>
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
          <a href={operatorUrl} className="text-link">Try the foundation slice <ArrowRight size={17} /></a>
        </div>
        <div className="proof-log">
          <div><span>00:00</span><p>Granted read access to <strong>Sheet1!A1:D20</strong></p></div>
          <div><span>00:02</span><p>Returned 4 rows to the task context</p></div>
          <div><span>00:04</span><p>Ran transformation in <strong>QuickJS Wasm</strong></p></div>
          <div><span>00:05</span><p>Sandbox had no network, token, or DOM access</p></div>
          <div className="log-accent"><span>00:06</span><p>Staged 8 changed cells for approval</p></div>
          <div><span>00:08</span><p>No external write occurred without approval</p></div>
        </div>
      </section>

      <section className="trust" id="trust" aria-labelledby="trust-title">
        <div className="section-label">Trust is the operating system</div>
        <h2 id="trust-title">Local-first.<br />Effect-aware.</h2>
        <div className="trust-lines">
          <div><span>Credentials</span><strong>Host broker only</strong><em>01</em></div>
          <div><span>Model access</span><strong>Typed, bounded tool results</strong><em>02</em></div>
          <div><span>Scripts</span><strong>Wasm Worker · no host access</strong><em>03</em></div>
          <div><span>Writes</span><strong>Cell-level approval first</strong><em>04</em></div>
          <div><span>Autonomy</span><strong>Foreground session in alpha</strong><em>05</em></div>
        </div>
        <p className="trust-note"><ShieldCheck size={20} /> The alpha deliberately excludes background execution and persisted OAuth tokens. Those require a separate server trust model.</p>
      </section>

      <section className="final-cta">
        <div><p className="section-label">Foundation slice</p><h2>Operate visibly.</h2></div>
        <div className="final-actions"><a className="button button-dark" href={operatorUrl}>Open WasmHatch <ArrowRight size={19} /></a><p>Open source.<br />No account required for the local demo.</p></div>
      </section>

      <footer className="site-footer">
        <a className="wordmark wordmark-dark" href={homeUrl}>WH<span>／02</span></a>
        <p>Browser-native AI operations with explicit effects.</p>
        <div><a href={repositoryUrl}>GitHub</a><a href={`${repositoryUrl}/blob/main/docs/plan.md`}>Plan</a><span>Apache-2.0</span></div>
      </footer>
    </main>
  );
}
