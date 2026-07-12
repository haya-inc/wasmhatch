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
              radial-gradient(circle at 88% -10%, rgba(212,87,46,.10), transparent 42%),
              radial-gradient(circle at -8% 110%, rgba(212,87,46,.07), transparent 38%),
              #fdfcfa;
            font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
          }
          .frame { position: relative; width: 100%; height: 100%; padding: 46px 60px 40px; }
          header { display: flex; align-items: center; justify-content: space-between; }
          .brand { display: flex; align-items: center; gap: 12px; font-weight: 800; font-size: 26px; letter-spacing: -.02em; }
          .brand i { width: 30px; height: 30px; border-radius: 9px; background: #d4572e; display: inline-block; }
          .pill { padding: 9px 18px; border: 1px solid #ebe7e0; border-radius: 999px; background: #fff; color: #6f6a61; font-size: 14px; font-weight: 600; }
          main { height: 452px; margin-top: 34px; display: grid; grid-template-columns: 1.02fr .98fr; gap: 64px; align-items: center; }
          h1 { margin: 0; font-size: 62px; line-height: 1.04; letter-spacing: -.035em; font-weight: 800; }
          h1 em { color: #d4572e; font-style: normal; }
          .promise { max-width: 480px; margin: 24px 0 0; color: #6f6a61; font-size: 19px; line-height: 1.55; }
          .badges { display: flex; gap: 10px; margin-top: 26px; }
          .badges span { padding: 8px 14px; border-radius: 999px; background: #faeee6; color: #b8461f; font-size: 13.5px; font-weight: 700; }
          .demo { border: 1px solid #ebe7e0; border-radius: 22px; background: #fff; box-shadow: 0 24px 60px rgba(34,31,26,.10); overflow: hidden; }
          .demo header { padding: 14px 18px; border-bottom: 1px solid #ebe7e0; color: #6f6a61; font-size: 13px; font-weight: 700; justify-content: flex-start; gap: 8px; }
          .demo header i { width: 9px; height: 9px; border-radius: 50%; background: #2e7d4f; }
          .thread { padding: 20px; display: grid; gap: 13px; font-size: 15.5px; line-height: 1.5; }
          .user { justify-self: end; max-width: 88%; padding: 12px 16px; border-radius: 15px 15px 4px 15px; background: #faeee6; border: 1px solid #f2ddcd; }
          .bot { margin: 0; padding: 12px 16px; border-radius: 15px 15px 15px 4px; background: #f6f4f0; max-width: 90%; }
          .chip { display: flex; align-items: center; gap: 10px; padding: 11px 14px; border: 1px solid #ebe7e0; border-left: 4px solid #d4572e; border-radius: 12px; font-size: 14px; color: #6f6a61; }
          .chip strong { color: #221f1a; }
          .chip .undo { margin-left: auto; color: #d4572e; font-weight: 700; }
          footer { position: absolute; inset: auto 60px 34px; display: flex; justify-content: space-between; color: #6f6a61; font-size: 14.5px; font-weight: 600; }
          footer strong { color: #221f1a; }
        </style>
      </head>
      <body>
        <div class="frame">
          <header>
            <div class="brand"><i></i> WasmHatch</div>
            <div class="pill">Free · Open source · No install</div>
          </header>
          <main>
            <section>
              <h1>The AI assistant that <em>actually does the work.</em></h1>
              <p class="promise">Fixes spreadsheets, writes docs, builds reports — right in your browser, while you watch.</p>
              <div class="badges"><span>Acts fast</span><span>Every change visible</span><span>Undo anytime</span></div>
            </section>
            <section class="demo">
              <header><i></i> WasmHatch</header>
              <div class="thread">
                <div class="user">Turn this sales export into a clean summary I can share.</div>
                <p class="bot">On it — tidying the data and building your summary now.</p>
                <div class="chip"><span>✓</span><span><strong>Cleaned</strong> sales-export.csv · 214 fixes</span><span class="undo">Undo</span></div>
                <div class="chip"><span>✦</span><span><strong>Created</strong> Q3 summary — ready to share</span></div>
              </div>
            </section>
          </main>
          <footer><strong>wasmhatch.com</strong><span>Your AI assistant, right in the browser.</span></footer>
        </div>
      </body>
    </html>`);
  await page.screenshot({ path: outputPath, type: "png" });
} finally {
  await browser.close();
}
