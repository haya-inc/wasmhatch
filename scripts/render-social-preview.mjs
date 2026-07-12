import { chromium } from "@playwright/test";
import { fileURLToPath } from "node:url";

const outputPath = fileURLToPath(new URL("../public/social-preview.png", import.meta.url));
const browser = await chromium.launch({ headless: true });

try {
  const page = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
  await page.setContent(`<!doctype html>
    <html lang="en">
      <head>
        <meta charset="utf-8" />
        <style>
          * { box-sizing: border-box; }
          html, body { width: 1200px; height: 630px; margin: 0; overflow: hidden; }
          body {
            color: #eef1eb;
            background:
              linear-gradient(rgba(255,255,255,.032) 1px, transparent 1px),
              linear-gradient(90deg, rgba(255,255,255,.032) 1px, transparent 1px),
              radial-gradient(circle at 85% 8%, rgba(217,255,67,.13), transparent 31%),
              #090b09;
            background-size: 56px 56px, 56px 56px, auto, auto;
            font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }
          .frame { position: relative; width: 100%; height: 100%; padding: 42px 58px 38px; }
          .frame::after { content: ""; position: absolute; inset: 0 0 0 auto; width: 13px; background: #d9ff43; }
          header, footer { display: flex; align-items: center; justify-content: space-between; }
          .brand { display: flex; align-items: baseline; gap: 10px; font: 900 24px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: -.08em; }
          .brand span { color: #d9ff43; font-size: 10px; letter-spacing: .06em; }
          .kicker { display: flex; align-items: center; gap: 12px; color: #9fa59b; font: 750 11px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .18em; }
          .kicker i { width: 9px; height: 9px; border-radius: 50%; background: #d9ff43; box-shadow: 0 0 18px rgba(217,255,67,.7); }
          main { height: 460px; margin-top: 38px; display: grid; grid-template-columns: 1.08fr .92fr; gap: 72px; }
          h1 { margin: 0; font-size: 74px; line-height: .88; letter-spacing: -.07em; text-transform: uppercase; }
          h1 span { display: block; }
          h1 em { display: block; margin-top: 24px; color: #d9ff43; font-size: 59px; line-height: .92; font-style: normal; }
          .promise { max-width: 540px; margin: 29px 0 0; color: #a9afa6; font-size: 17px; line-height: 1.5; }
          .conversation { padding: 5px 0 0 30px; border-left: 1px solid rgba(236,239,232,.18); }
          .assistant { display: grid; grid-template-columns: 34px 1fr; gap: 14px; }
          .assistant-mark { width: 34px; height: 34px; display: grid; place-items: center; border: 1px solid #65732d; border-radius: 50%; color: #d9ff43; font: 900 14px/1 ui-monospace, monospace; }
          .assistant strong { display: block; margin-top: 3px; font-size: 21px; letter-spacing: -.025em; }
          .assistant p { margin: 8px 0 0; color: #80877d; font-size: 12px; line-height: 1.5; }
          .request { width: 88%; margin: 34px 0 0 auto; padding: 18px 20px; border: 1px solid #3a4037; border-radius: 14px 14px 3px 14px; background: #151815; color: #dce0d9; font-size: 15px; line-height: 1.45; }
          .request small { display: block; margin-bottom: 9px; color: #737a71; font: 700 9px/1 ui-monospace, monospace; }
          .result { margin-top: 28px; padding: 19px 20px; border-left: 3px solid #d9ff43; background: rgba(217,255,67,.05); }
          .result strong { display: block; font-size: 16px; }.result p { margin: 7px 0 0; color: #82897e; font-size: 11px; line-height: 1.5; }
          .review { width: max-content; margin-top: 16px; padding: 13px 17px; background: #d9ff43; color: #090b09; font: 900 10px/1 ui-monospace, monospace; letter-spacing: .04em; }
          footer { position: absolute; inset: auto 58px 32px; color: #777e75; font: 700 10px/1 ui-monospace, SFMono-Regular, Menlo, monospace; letter-spacing: .11em; text-transform: uppercase; }
          footer strong { color: #b9beb5; font-weight: 700; }
        </style>
      </head>
      <body>
        <div class="frame">
          <header>
            <div class="brand">WH <span>／02</span></div>
            <div class="kicker"><i></i> OPEN SOURCE · BROWSER NATIVE</div>
          </header>
          <main>
            <section>
              <h1><span>Describe</span><span>the work.</span><em>Review the result.</em></h1>
              <p class="promise">AI work for files, connected sheets, and reviewed outputs—with every durable change visible first.</p>
            </section>
            <section class="conversation">
              <div class="assistant">
                <span class="assistant-mark">✦</span>
                <div><strong>What do you want to get done?</strong><p>Start in your own words. Add context only when it helps.</p></div>
              </div>
              <div class="request"><small>YOUR REQUEST</small>Compare these records and show only the exceptions.</div>
              <div class="result"><strong>✓ 7 changes ready</strong><p>Exact before-and-after values prepared. Nothing has changed yet.</p><div class="review">REVIEW CHANGES →</div></div>
            </section>
          </main>
          <footer><strong>haya-inc.github.io/wasmhatch</strong><span>FILES · SHEETS · REVIEWED OUTPUTS</span></footer>
        </div>
      </body>
    </html>`);
  await page.screenshot({ path: outputPath, type: "png" });
} finally {
  await browser.close();
}
