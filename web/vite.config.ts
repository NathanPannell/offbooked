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

export default defineConfig({
  plugins: [react()],
  server: { port: 5173 },
  preview: { port: 4173 },
  // The speech model runs in a module worker; transformers.js is only imported there.
  worker: { format: "es", plugins: () => [dropUnusedOrtWasm()] },
  optimizeDeps: { exclude: ["@huggingface/transformers"] },
  build: { target: "es2022" },
  test: { environment: "node", include: ["src/**/*.test.ts"] },
});
