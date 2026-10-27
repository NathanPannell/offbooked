// Pre-renders the marketing pages after `vite build`, so search engines, link previews and anyone
// without JavaScript get the real text: dist/index.html (/), pricing.html, privacy.html and terms.html, each with
// its own title, description, canonical URL, Open Graph and Twitter tags (and structured data on /).
// The browser hydrates that HTML (src/main.tsx). The app's own screens (/app, /join, /i, /signin,
// /auth) are served dist/shell.html, the plain build without any page text, kept out of search.
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createServer } from "vite";

const dist = new URL("../dist/", import.meta.url);
const ROOT = '<div id="root"></div>';
const SEO = /<!--seo-->[\s\S]*?<!--\/seo-->/;

const template = await readFile(new URL("index.html", dist), "utf8");
if (!template.includes(ROOT) || !SEO.test(template)) throw new Error("dist/index.html is missing the root element or the <!--seo--> block");

await writeFile(
  new URL("shell.html", dist),
  template.replace(SEO, (block) => `${block}\n  <meta name="robots" content="noindex">`),
);

const vite = await createServer({
  root: fileURLToPath(new URL("..", import.meta.url)),
  mode: "production",
  appType: "custom",
  logLevel: "error",
  server: { middlewareMode: true, hmr: false, ws: false },
  optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { render, PAGES, headTags } = await vite.ssrLoadModule("/src/prerender.tsx");
  for (const page of PAGES) {
    const body = render(page.path);
    if (!body.includes("<h1")) throw new Error(`${page.path} rendered without a heading`);
    const html = template.replace(SEO, headTags(page)).replace(ROOT, `<div id="root" data-prerendered="${page.path}">${body}</div>`);
    await writeFile(new URL(page.file, dist), html);
    console.log(`prerendered ${page.path} → dist/${page.file} (${Math.round(html.length / 1024)} KB)`);
  }
} finally {
  await vite.close();
}
