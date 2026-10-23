import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { isNativeApp } from "./native/platform";
import { getUploader } from "./upload/uploader";
import "./styles/tokens.css";
import "./styles/base.css";
import "./styles/app.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

// Takes an earlier visit left on this device (no signal, a crash, a server fault) go up from any
// screen of the cast or the director, not only once the recorder is open again. In the app, from
// every screen: it opens on its own home screen, and a link may take it anywhere.
if (isNativeApp() || /^\/(i|join|app)(\/|$)/.test(window.location.pathname)) setTimeout(() => getUploader(), 0);
