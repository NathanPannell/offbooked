import { defineConfig, type Plugin } from "vitest/config";
import react from "@vitejs/plugin-react";

/**
 * ONNX Runtime's bundle points at its 27 MB asyncify WASM build, so Vite emits it, but the speech
 * worker always loads the plain build it imports itself (stt.worker.ts). Leave the dead copy out.
 */
function dropUnusedOrtWasm(): Plugin {
  return {
    name: "drop-unused-ort-wasm",
    apply: "build",
    generateBundle(_, bundle) {
      for (const name of Object.keys(bundle)) {
        if (/ort-wasm-simd-threaded\.(asyncify|jsep|jspi)-.*\.wasm$/.test(name)) delete bundle[name];
      }
    },
  };
}

/**
 * `vite preview` serves the build the way vercel.json does: the pre-rendered marketing pages at /,
 * /privacy and /terms, and the plain app shell (dist/shell.html) for every other page, so the e2e
 * journeys see what production serves.
 */
function serveLikeVercel(): Plugin {
  const pages = new Set(["/", "/privacy", "/terms"]);
  return {
    name: "serve-like-vercel",
    configurePreviewServer(server) {
      server.middlewares.use((req, _res, next) => {
        const [path = "/", query] = (req.url ?? "/").split("?");
        if (req.method === "GET" && !pages.has(path) && !/\.[a-z0-9]+$/i.test(path)) req.url = `/shell.html${query ? `?${query}` : ""}`;
        next();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), serveLikeVercel()],
  server: { port: 5173 },
  preview: { port: 4173 },
  // The speech model runs in a module worker; transformers.js is only imported there.
  worker: { format: "es", plugins: () => [dropUnusedOrtWasm()] },
  optimizeDeps: { exclude: ["@huggingface/transformers"] },
  build: { target: "es2022" },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    coverage: {
      provider: "v8",
      include: ["src/**"],
      // The floor is the coverage the unit tests reached when it was set; raise it, never lower it.
      // Screens are covered by the Playwright journeys in e2e/, not here.
      thresholds: { lines: 31, statements: 31, branches: 30, functions: 24 },
    },
  },
});
