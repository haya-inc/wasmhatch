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
            color: #221f1a;
            background:
              radial-gradient(circle at 88% -10%, rgba(212,87,46,.11), transparent 42%),
              radial-gradient(circle at -8% 110%, rgba(212,87,46,.08), transparent 38%),
              #fdfcfa;
            font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }
          .frame { position: relative; width: 100%; height: 100%; padding: 44px 60px 38px; }
          header { display: flex; align-items: center; justify-content: space-between; }
          .brand { display: flex; align-items: center; gap: 12px; font-weight: 800; font-size: 26px; letter-spacing: -.02em; }
          .brand i { width: 30px; height: 30px; border-radius: 9px; background: #d4572e; display: inline-block; }
          .pill { padding: 9px 18px; border: 1px solid #ebe7e0; border-radius: 999px; background: #fff; color: #6f6a61; font-size: 14px; font-weight: 600; }
          main { height: 454px; margin-top: 32px; display: grid; grid-template-columns: 1.04fr .96fr; gap: 56px; align-items: center; }
          h1 { margin: 0; font-size: 58px; line-height: 1.05; letter-spacing: -.035em; font-weight: 800; }
          h1 em { color: #d4572e; font-style: normal; }
          .promise { max-width: 500px; margin: 22px 0 0; color: #6f6a61; font-size: 18.5px; line-height: 1.55; }
          .badges { display: flex; flex-wrap: wrap; gap: 9px; margin-top: 24px; }
          .badges span { padding: 8px 14px; border-radius: 999px; background: #faeee6; color: #b8461f; font-size: 13.5px; font-weight: 700; }
          .demo { border: 1px solid #ebe7e0; border-radius: 22px; background: #fff; box-shadow: 0 24px 60px rgba(34,31,26,.10); overflow: hidden; }
          .demo header { padding: 13px 18px; border-bottom: 1px solid #ebe7e0; color: #6f6a61; font-size: 13px; font-weight: 700; justify-content: space-between; }
          .demo-who { display: flex; align-items: center; gap: 9px; color: #221f1a; }
          .demo-who i { width: 9px; height: 9px; border-radius: 50%; background: #2e7d4f; display: inline-block; }
          .chick { width: 22px; height: 22px; image-rendering: pixelated; display: block; }
          .thread { padding: 18px 20px; display: grid; gap: 12px; font-size: 15px; line-height: 1.48; }
          .user { justify-self: end; max-width: 88%; padding: 11px 15px; border-radius: 15px 15px 4px 15px; background: #faeee6; border: 1px solid #f2ddcd; }
          .bot { margin: 0; padding: 11px 15px; border-radius: 15px 15px 15px 4px; background: #f6f4f0; max-width: 92%; }
          .chip { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border: 1px solid #ebe7e0; border-left: 4px solid #d4572e; border-radius: 12px; font-size: 13.5px; color: #6f6a61; }
          .chip strong { color: #221f1a; }
          .chip .undo { margin-left: auto; color: #d4572e; font-weight: 700; }
          footer { position: absolute; inset: auto 60px 32px; display: flex; justify-content: space-between; color: #6f6a61; font-size: 14.5px; font-weight: 600; }
          footer strong { color: #221f1a; }
        </style>
      </head>
      <body>
        <div class="frame">
          <header>
            <div class="brand"><i></i> WasmHatch</div>
            <div class="pill">No server · Open source · BYOK or local Ollama</div>
          </header>
          <main>
            <section>
              <h1>The AI assistant that <em>actually does the work.</em></h1>
              <p class="promise">Clean data with local code, draft docs, build one-file HTML reports, or hatch a tiny team — right in your browser tab.</p>
              <div class="badges"><span>Zero server</span><span>Local code &amp; MCP</span><span>Undo anytime</span></div>
            </section>
            <section class="demo">
              <header>
                <div class="demo-who">
                  <svg class="chick" viewBox="0 0 8 8" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges">
                    <rect x="2" y="1" width="4" height="4" fill="#f3b63a" />
                    <rect x="1" y="3" width="6" height="3" fill="#f3b63a" />
                    <rect x="4" y="2" width="1" height="1" fill="#221f1a" />
                    <rect x="6" y="3" width="1" height="1" fill="#d4572e" />
                    <rect x="2" y="6" width="1" height="1" fill="#d4572e" />
                    <rect x="4" y="6" width="1" height="1" fill="#d4572e" />
                  </svg>
                  <span>Pip · Main desk</span>
                </div>
                <span><i></i> In your browser</span>
              </header>
              <div class="thread">
                <div class="user">Clean up this export — normalize regions, deduplicate rows, and build a Q3 summary.</div>
                <p class="bot">On it — running a local cleanup script and building your HTML report now.</p>
                <div class="chip"><span>✓</span><span><strong>Cleaned</strong> sales-export.csv · 214 fixes</span><span class="undo">Undo</span></div>
                <div class="chip"><span>✦</span><span><strong>Created</strong> q3-summary.html — open beside chat</span></div>
              </div>
            </section>
          </main>
          <footer><strong>wasmhatch.com</strong><span>Your AI team in a single browser tab — no server, no signup.</span></footer>
        </div>
      </body>
    </html>`);
  await page.screenshot({ path: outputPath, type: "png" });
} finally {
  await browser.close();
}
