import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import { App } from "./App";
import { isNativeApp } from "./native/platform";
import { getUploader } from "./upload/uploader";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";
import "./styles/landing.css";

const root = document.getElementById("root")!;
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);
// The marketing pages arrive as pre-rendered HTML (scripts/prerender.mjs). Where that HTML was made
// for this very path, the app picks it up as it is; anywhere else (the iOS app, whose first screen
// isn't the landing page, or a path the HTML wasn't made for) it starts afresh.
if (root.dataset.prerendered === window.location.pathname && !isNativeApp()) {
  hydrateRoot(root, app);
} else {
  delete root.dataset.prerendered;
  root.replaceChildren();
  createRoot(root).render(app);
}

// Takes an earlier visit left on this device (no signal, a crash, a server fault) go up from any
// screen of the cast or the director, not only once the recorder is open again. In the app, from
// every screen: it opens on its own home screen, and a link may take it anywhere.
if (isNativeApp() || /^\/(i|join|app)(\/|$)/.test(window.location.pathname)) setTimeout(() => getUploader(), 0);
