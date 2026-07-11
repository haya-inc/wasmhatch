import { useMemo, useState } from "react";
import {
  ArrowRight,
  Check,
  Code2,
  Copy,
  GitFork,
  ShieldCheck,
  Sparkles,
  TerminalSquare
} from "lucide-react";
import { createBadgeMarkdown, createWorkspaceShareUrl } from "../lib/share";
import { exampleTasks, getExampleIssueNumber } from "../data/examples";
import { contributionTasks } from "../data/contributions";

const repositoryUrl = "https://github.com/haya-inc/wasmhatch";
const landscapeUrl = `${repositoryUrl}/blob/main/docs/landscape.md`;
const adoptionRegistryUrl = `${repositoryUrl}/issues/9`;

export function LandingPage() {
  const homeUrl = import.meta.env.BASE_URL;
  const workspaceUrl = `${homeUrl}?view=workspace`;
  const [shareRepo, setShareRepo] = useState(exampleTasks[0].repository);
  const [shareRef, setShareRef] = useState(exampleTasks[0].ref);
  const [shareTask, setShareTask] = useState(exampleTasks[0].task);
  const [shareIssue, setShareIssue] = useState(exampleTasks[0].issueUrl || "");
  const [copied, setCopied] = useState<"url" | "badge" | "error" | null>(null);
  const absoluteHomeUrl = new URL(homeUrl, window.location.origin).toString();
  const shareUrl = useMemo(
    () => createWorkspaceShareUrl(absoluteHomeUrl, shareRepo, shareTask, shareRef, shareIssue),
    [absoluteHomeUrl, shareIssue, shareRepo, shareRef, shareTask]
  );
  const badgeMarkdown = createBadgeMarkdown(
    shareUrl,
    new URL("open-in-wasmhatch.svg", absoluteHomeUrl).toString()
  );

  const copyText = async (value: string, kind: "url" | "badge") => {
    try {
      if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
      await navigator.clipboard.writeText(value);
      setCopied(kind);
    } catch {
      const temporary = document.createElement("textarea");
      temporary.value = value;
      temporary.setAttribute("readonly", "");
      temporary.style.position = "fixed";
      temporary.style.opacity = "0";
      document.body.append(temporary);
      temporary.select();
      const succeeded = document.execCommand("copy");
      temporary.remove();
      setCopied(succeeded ? kind : "error");
    }
    window.setTimeout(() => setCopied(null), 1600);
  };

  return (
    <main className="landing">
      <header className="site-header">
        <a className="wordmark" href={homeUrl} aria-label="WasmHatch home">
          WH<span>／01</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#how">How it works</a>
          <a href="#examples">Examples</a>
          <a href="#contribute">Contribute</a>
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

      <section className="fit-section" id="fit" aria-labelledby="fit-title">
        <div className="section-label">Choose the right surface</div>
        <div className="fit-heading">
          <h2 id="fit-title">Not a cloud IDE.<br />A shorter path.</h2>
          <div>
            <p>
              Use WasmHatch when a public issue can become one reviewed text patch.
              Reach for a runtime-first tool when the task must build, test, or debug.
            </p>
            <a href={landscapeUrl}>Read the product landscape <ArrowRight size={16} /></a>
          </div>
        </div>
        <div className="fit-list" aria-label="Product fit comparison">
          <article className="fit-primary">
            <span>01</span><h3>WasmHatch</h3><p>Focused public issue → reviewable patch</p><small>No core runtime</small>
          </article>
          <article>
            <span>02</span><h3>github.dev</h3><p>Lightweight repository edit → commit or PR</p><small>Browser editor</small>
          </article>
          <article>
            <span>03</span><h3>Codespaces</h3><p>Build, test, and debug a whole project</p><small>Cloud VM + dev container</small>
          </article>
          <article>
            <span>04</span><h3>WebContainers</h3><p>Embed Node.js execution in a web product</p><small>In-browser runtime</small>
          </article>
          <article>
            <span>05</span><h3>OpenHands</h3><p>Delegate command-running work to an agent</p><small>Sandbox runtime</small>
          </article>
        </div>
      </section>

      <section className="examples-section" id="examples" aria-labelledby="examples-title">
        <div className="section-label">Start with a real task</div>
        <div className="examples-heading">
          <h2 id="examples-title">Small scope.<br />Pinned source.</h2>
          <p>
            Each example points to an exact public commit and a change that can be
            reviewed as one patch. No synthetic tutorial repository required.
          </p>
        </div>
        <div className="example-list">
          {exampleTasks.map((example, index) => {
            const issueNumber = getExampleIssueNumber(example.issueUrl);
            const url = createWorkspaceShareUrl(
              absoluteHomeUrl,
              example.repository,
              example.task,
              example.ref,
              example.issueUrl
            );
            return (
              <article key={example.repository}>
                <span className="example-number">0{index + 1}</span>
                <div className="example-repo">
                  <code>{example.repository}</code>
                  <small>{example.ref.slice(0, 7)} · {example.scope}</small>
                </div>
                <div className="example-copy">
                  <h3>{example.title}</h3>
                  <p>{example.description}</p>
                </div>
                <div className="example-actions">
                  {example.issueUrl && issueNumber && (
                    <a href={example.issueUrl} aria-label={`View the GitHub issue for ${example.title}`}>
                      Issue #{issueNumber}
                    </a>
                  )}
                  <a href={url} aria-label={`Open ${example.title} in WasmHatch`}>
                    Open task <ArrowRight size={17} />
                  </a>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="contribute-section" id="contribute" aria-labelledby="contribute-title">
        <div className="section-label">Five contribution lanes</div>
        <div className="contribute-heading">
          <h2 id="contribute-title">Pick one.<br />Claim it. Ship it.</h2>
          <div>
            <p>
              Each task is pinned, independently scoped, and sized for one pull request.
              Comment <strong>I’m working on this</strong> on GitHub before editing; if it is claimed, choose another lane.
            </p>
            <a href={`${repositoryUrl}/issues?q=is%3Aissue+is%3Aopen+label%3A%22good+first+issue%22`}>
              View all open starter issues <ArrowRight size={16} />
            </a>
          </div>
        </div>
        <div className="contribution-list" aria-label="WasmHatch contribution tasks">
          {contributionTasks.map((contribution) => {
            const issueUrl = `${repositoryUrl}/issues/${contribution.issueNumber}`;
            const taskUrl = createWorkspaceShareUrl(
              absoluteHomeUrl,
              contribution.repository,
              contribution.task,
              contribution.ref,
              issueUrl
            );
            return (
              <article key={contribution.issueNumber}>
                <span className="contribution-issue">#{contribution.issueNumber}</span>
                <div>
                  <small>{contribution.scope}</small>
                  <h3>{contribution.title}</h3>
                </div>
                <p>{contribution.description}</p>
                <div className="contribution-actions">
                  <a href={issueUrl}>Read &amp; claim</a>
                  <a className="contribution-open" href={taskUrl}>Open task <ArrowRight size={15} /></a>
                </div>
              </article>
            );
          })}
        </div>
      </section>

      <section className="share-section" id="share" aria-labelledby="share-title">
        <div className="section-label">For maintainers</div>
        <div className="share-intro">
          <h2 id="share-title">Make a task<br />one click away.</h2>
          <p>
            Build a link that opens WasmHatch with the repository and contribution task
            already in place. Visitors remain in control of the import.
          </p>
        </div>
        <div className="share-builder">
          <label>
            <span>01 / Repository</span>
            <input value={shareRepo} onChange={(event) => setShareRepo(event.target.value)} placeholder="owner/repository" />
          </label>
          <label>
            <span>02 / Ref</span>
            <input value={shareRef} onChange={(event) => setShareRef(event.target.value)} placeholder="default branch" />
          </label>
          <label>
            <span>03 / Focused task</span>
            <textarea value={shareTask} onChange={(event) => setShareTask(event.target.value)} />
          </label>
          <label>
            <span>04 / GitHub issue · optional</span>
            <input value={shareIssue} onChange={(event) => setShareIssue(event.target.value)} placeholder="https://github.com/owner/repo/issues/1" />
          </label>
          <div className="share-output">
            <span>05 / Share</span>
            <code>{shareUrl}</code>
            <div>
              <button onClick={() => void copyText(shareUrl, "url")}>
                {copied === "url" ? <Check size={15} /> : <Copy size={15} />}
                {copied === "url" ? "Copied URL" : copied === "error" ? "Select URL above" : "Copy URL"}
              </button>
              <button onClick={() => void copyText(badgeMarkdown, "badge")}>
                {copied === "badge" ? <Check size={15} /> : <Copy size={15} />}
                {copied === "badge" ? "Copied badge" : "Copy badge Markdown"}
              </button>
              <a href={shareUrl}>Open link <ArrowRight size={15} /></a>
            </div>
          </div>
          <div className="badge-preview">
            <p>README badge preview</p>
            <img src={`${homeUrl}open-in-wasmhatch.svg`} alt="Open in WasmHatch" />
          </div>
          <div className="adoption-report">
            <div>
              <span>06 / Report</span>
              <p>Published a task or tried the workflow? Share the public repository in the opt-in adoption registry.</p>
            </div>
            <a href={adoptionRegistryUrl}>Register adoption <ArrowRight size={15} /></a>
          </div>
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
          <div><span>Model access</span><strong>Protected, bounded reads</strong><em>02</em></div>
          <div><span>Writes</span><strong>Staged until you approve</strong><em>03</em></div>
          <div><span>API key</span><strong>Session memory only</strong><em>04</em></div>
        </div>
        <p className="trust-note">
          <ShieldCheck size={20} /> Every model-bound task, file list, and file read appears in the
          workspace ledger. Path protection is defensive, not a substitute for reviewing access.
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

      <footer className="site-footer">
        <a className="wordmark wordmark-dark" href={homeUrl}>WH<span>／01</span></a>
        <p>Browser-native tools for the next open-source contributor.</p>
        <div><a href={repositoryUrl}>GitHub</a><a href={`${repositoryUrl}/blob/main/docs/plan.md`}>Plan</a><span>Apache-2.0</span></div>
      </footer>
    </main>
  );
}
