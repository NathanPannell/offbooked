// Draws the link-preview image (public/og.png, 1200×630) from the HTML below with Playwright's
// Chromium. Run it again when the headline changes: node scripts/og-image.mjs
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const html = `<!doctype html>
<html><head><meta charset="utf-8">
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Hanken+Grotesk:wght@500;700&family=Newsreader:ital,opsz,wght@0,6..72,400;1,6..72,400&display=block">
<style>
  * { box-sizing: border-box; margin: 0; }
  body { width: 1200px; height: 630px; padding: 72px 80px; background: #fff; color: #1d1c1a;
    font-family: "Hanken Grotesk", sans-serif; display: flex; flex-direction: column; justify-content: space-between;
    background-image: radial-gradient(circle at 92% 18%, #f3e2b6 0, transparent 34%); }
  .brand { display: flex; align-items: center; gap: 16px; font-family: Newsreader, serif; font-size: 38px; }
  h1 { font-family: Newsreader, serif; font-weight: 400; font-size: 92px; line-height: 1.02; letter-spacing: -0.02em; max-width: 960px; }
  em { color: #a1352a; background: linear-gradient(transparent 62%, #f3e2b6 62%, #f3e2b6 92%, transparent 92%); }
  .foot { display: flex; justify-content: space-between; align-items: end; font-size: 26px; color: #46423c; }
  .url { font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; font-size: 20px; color: #69645c; }
</style></head>
<body>
  <div class="brand"><svg width="52" height="52" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#a8382a"/><circle cx="16" cy="16" r="7.5" fill="none" stroke="#fff" stroke-width="2"/><circle cx="16" cy="16" r="2" fill="#fff"/></svg>Offbooked</div>
  <h1>Hear your script read by your <em>real cast.</em></h1>
  <div class="foot"><span>Upload the script. Send one link. Run the whole play.</span><span class="url">offbooked.com</span></div>
</body></html>`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1200, height: 630 } });
await page.setContent(html, { waitUntil: "networkidle" });
await page.evaluate("document.fonts.ready");
await page.screenshot({ path: fileURLToPath(new URL("../public/og.png", import.meta.url)) });
await browser.close();
console.log("wrote public/og.png");
