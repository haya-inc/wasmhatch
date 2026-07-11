import {
  ArrowRight,
  Check,
  Code2,
  GitFork,
  ShieldCheck,
  Sparkles,
  TerminalSquare
} from "lucide-react";

const repositoryUrl = "https://github.com/haya-inc/wasmhatch";

export function LandingPage() {
  const homeUrl = import.meta.env.BASE_URL;
  const workspaceUrl = `${homeUrl}workspace`;

  return (
    <main className="landing">
      <header className="site-header">
        <a className="wordmark" href={homeUrl} aria-label="WasmHatch home">
          WH<span>／01</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#how">How it works</a>
          <a href="#trust">Trust model</a>
          <a href={repositoryUrl}>GitHub</a>
        </nav>
        <a className="header-cta" href={workspaceUrl}>
          Open workspace <ArrowRight size={16} />
        </a>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-grid" aria-hidden="true" />
        <div className="hero-glow" aria-hidden="true" />

        <div className="hero-copy">
          <p className="kicker reveal reveal-one">
            <span /> Open-source · browser-native
          </p>
          <h1 id="hero-title" className="reveal reveal-two">
            <span>Wasm</span>
            <span>Hatch.</span>
          </h1>
          <p className="hero-promise reveal reveal-three">
            From issue to patch.
            <br />
            No setup in between.
          </p>
          <div className="hero-actions reveal reveal-four">
            <a className="button button-primary" href={workspaceUrl}>
              Hatch a sample <ArrowRight size={18} />
            </a>
            <a className="button button-quiet" href={repositoryUrl}>
              <GitFork size={17} /> View source
            </a>
          </div>
        </div>

        <div className="hero-product reveal reveal-five" aria-label="WasmHatch product preview">
          <div className="product-bar">
            <span className="product-mark">WH</span>
            <span>tiny-hatch / issue #14</span>
            <span className="local-state"><i /> local workspace</span>
          </div>
          <div className="product-body">
            <div className="product-files">
              <small>WORKSPACE</small>
              <span>README.md</span>
              <span className="active">src/greet.ts</span>
              <span>src/greet.test.ts</span>
              <span>package.json</span>
            </div>
            <pre className="product-code" aria-label="Example patch">
              <code>
                <span className="code-muted"> 1</span> export function greet(name: string) &#123;{"\n"}
                <span className="code-muted"> 2</span>
                <span className="diff-remove">- return `Hello, $&#123;name&#125;!`;</span>{"\n"}
                <span className="code-muted"> 2</span>
                <span className="diff-add">+ const clean = name.trim();</span>{"\n"}
                <span className="code-muted"> 3</span>
                <span className="diff-add">+ return `Hello, $&#123;clean || "friend"&#125;!`;</span>{"\n"}
                <span className="code-muted"> 4</span> &#125;
              </code>
            </pre>
            <div className="product-agent">
              <small>AGENT ACTIVITY</small>
              <p><Check size={14} /> Read 3 files</p>
              <p><Check size={14} /> Found edge case</p>
              <p className="agent-current"><Sparkles size={14} /> Patch ready for review</p>
              <button>Review 1 change <ArrowRight size={14} /></button>
            </div>
          </div>
        </div>

        <div className="hero-foot">
          <span>01 / IMPORT</span>
          <span>02 / INSPECT</span>
          <span>03 / PATCH</span>
          <span>Runs where your code already is — your browser.</span>
        </div>
      </section>

      <section className="workflow" id="how" aria-labelledby="workflow-title">
        <div className="section-label">The contribution loop</div>
        <div className="workflow-heading">
          <h2 id="workflow-title">Skip the setup tax.</h2>
          <p>
            Open a public repository, give the agent a focused task, and leave with a
            reviewable patch—not another half-configured dev environment.
          </p>
        </div>

        <div className="workflow-sequence">
          <article>
            <span className="step-number">01</span>
            <Code2 aria-hidden="true" />
            <h3>Bring a repository</h3>
            <p>Paste an owner/repo link or load a local archive. Text files stay in browser storage.</p>
          </article>
          <article>
            <span className="step-number">02</span>
            <TerminalSquare aria-hidden="true" />
            <h3>Let the agent inspect</h3>
            <p>The model asks for specific files through bounded tools instead of receiving everything.</p>
          </article>
          <article>
            <span className="step-number">03</span>
            <Check aria-hidden="true" />
            <h3>Approve the patch</h3>
            <p>Every proposed write stops at a visible diff. Accept it, keep editing, or export the workspace.</p>
          </article>
        </div>
      </section>

      <section className="proof" aria-label="Product demonstration">
        <div className="proof-sticky">
          <p className="section-label">One URL. One task.</p>
          <h2>A workspace that hatches on demand.</h2>
          <p className="proof-copy">
            Built for first-time contributors, maintainers reproducing small issues, and
            anyone working on a machine they do not want to configure.
          </p>
          <a href={workspaceUrl} className="text-link">Try the live workspace <ArrowRight size={17} /></a>
        </div>
        <div className="proof-log" aria-label="Example agent log">
          <div><span>00:00</span><p>Imported <strong>tiny-hatch</strong> into OPFS</p></div>
          <div><span>00:02</span><p>Indexed 4 text files · 1.8 KB</p></div>
          <div><span>00:05</span><p>Read <strong>src/greet.ts</strong></p></div>
          <div><span>00:08</span><p>Read <strong>src/greet.test.ts</strong></p></div>
          <div className="log-accent"><span>00:14</span><p>Staged a focused change for review</p></div>
          <div><span>00:16</span><p>Workspace remained on this device</p></div>
        </div>
      </section>

      <section className="trust" id="trust" aria-labelledby="trust-title">
        <div className="section-label">Trust is a product feature</div>
        <h2 id="trust-title">Local-first.<br />Not hand-wavy.</h2>
        <div className="trust-lines">
          <div><span>Workspace</span><strong>Browser-managed storage</strong><em>01</em></div>
          <div><span>Model access</span><strong>Only tool-requested content</strong><em>02</em></div>
          <div><span>Writes</span><strong>Staged until you approve</strong><em>03</em></div>
          <div><span>API key</span><strong>Session memory only</strong><em>04</em></div>
        </div>
        <p className="trust-note">
          <ShieldCheck size={20} /> Browser BYOK is explicit, not magic: use a dedicated key with a
          spend limit. WasmHatch never claims the browser is a secret vault.
        </p>
      </section>

      <section className="final-cta">
        <div>
          <p className="section-label">Ready to contribute?</p>
          <h2>Hatch the patch.</h2>
        </div>
        <div className="final-actions">
          <a className="button button-dark" href={workspaceUrl}>
            Open WasmHatch <ArrowRight size={19} />
          </a>
          <p>Free and open source.<br />No account required.</p>
        </div>
      </section>

      <footer>
        <a className="wordmark wordmark-dark" href={homeUrl}>WH<span>／01</span></a>
        <p>Browser-native tools for the next open-source contributor.</p>
        <div><a href={repositoryUrl}>GitHub</a><a href={`${repositoryUrl}/blob/main/docs/plan.md`}>Plan</a><span>Apache-2.0</span></div>
      </footer>
    </main>
  );
}
