import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// The journeys run against the production build (`npm run build` first) served by `vite preview`,
// built with VITE_API_URL=http://localhost:8080 and talking to the real backend (ffmpeg on PATH,
// TTS off, heuristic script parser) on a throwaway Postgres. Set DATABASE_URL to that database; never Neon.
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("Set DATABASE_URL to a throwaway Postgres database for the e2e run");

const webUrl = "http://localhost:4173";
const apiUrl = "http://localhost:8080";

export default defineConfig({
  testDir: "e2e",
  timeout: 60_000,
  expect: { timeout: 15_000 },
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: { baseURL: webUrl, trace: "retain-on-failure" },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
  ],
  webServer: [
    {
      command: "npm --prefix ../backend start",
      url: `${apiUrl}/health`,
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        DATABASE_URL: databaseUrl,
        PORT: "8080",
        SESSION_SECRET: "e2e-session-secret",
        INVITE_TOKEN_SECRET: "e2e-invite-secret",
        APP_URL: webUrl,
        API_URL: apiUrl,
        CORS_ORIGINS: webUrl,
        EMAIL_DRIVER: "log",
        STORAGE_DRIVER: "local",
        STORAGE_DIR: path.resolve("test-results/e2e-storage"),
        TTS_DRIVER: "off",
        ANTHROPIC_API_KEY: "",
      },
    },
    {
      command: "npx vite preview --port 4173 --strictPort",
      url: webUrl,
      reuseExistingServer: false,
      timeout: 30_000,
    },
  ],
});
