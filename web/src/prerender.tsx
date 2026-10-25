import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { App } from "./App";

export { headTags, PAGES } from "./seo";

/** The app's HTML at `path`, as the browser will hydrate it (main.tsx). Used by scripts/prerender.mjs. */
export function render(path: string): string {
  return renderToString(
    <StrictMode>
      <App location={path} />
    </StrictMode>,
  );
}
