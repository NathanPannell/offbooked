import { availableParallelism } from "node:os";

export type StorageConfig =
  | { driver: "local"; dir: string }
  | { driver: "s3"; endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string };

export interface TtsConfig {
  driver: "piper" | "off";
  piperBin: string;
  voicesDir: string;
  concurrency: number; // clips synthesized at once (and Piper processes alive at most)
  cueWaitMs: number; // how long a lines request waits for missing TTS cue clips
}

export interface Config {
  databaseUrl: string;
  appUrl: string;
  apiUrl: string;
  corsOrigins: string[];
  sessionSecret: string;
  inviteSecret: string;
  anthropicApiKey: string | null;
  email: { driver: "log" | "resend"; resendApiKey: string | null; from: string };
  storage: StorageConfig;
  renderDebounceMs: number;
  tts: TtsConfig;
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const port = env.PORT ?? "8080";
  const resendApiKey = env.RESEND_API_KEY?.trim() || null;
  const emailDriver = env.EMAIL_DRIVER?.trim() || (resendApiKey ? "resend" : "log");
  if (emailDriver !== "log" && emailDriver !== "resend") throw new Error("EMAIL_DRIVER must be log or resend");
  if (emailDriver === "resend" && !resendApiKey) throw new Error("EMAIL_DRIVER=resend needs RESEND_API_KEY");

  const storageDriver = env.STORAGE_DRIVER?.trim() || "local";
  let storage: StorageConfig;
  if (storageDriver === "s3") {
    storage = {
      driver: "s3",
      endpoint: required(env, "S3_ENDPOINT"),
      bucket: required(env, "S3_BUCKET"),
      region: env.S3_REGION?.trim() || "auto",
      accessKeyId: required(env, "S3_ACCESS_KEY_ID"),
      secretAccessKey: required(env, "S3_SECRET_ACCESS_KEY"),
    };
  } else if (storageDriver === "local") {
    storage = { driver: "local", dir: env.STORAGE_DIR?.trim() || "./.data" };
  } else {
    throw new Error("STORAGE_DRIVER must be local or s3");
  }

  return {
    databaseUrl: required(env, "DATABASE_URL"),
    appUrl: trimSlash(env.APP_URL?.trim() || "http://localhost:5173"),
    apiUrl: trimSlash(env.API_URL?.trim() || `http://localhost:${port}`),
    corsOrigins: (env.CORS_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    sessionSecret: required(env, "SESSION_SECRET"),
    inviteSecret: required(env, "INVITE_TOKEN_SECRET"),
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    email: { driver: emailDriver, resendApiKey, from: env.EMAIL_FROM?.trim() || "Offbooked <hello@offbooked.com>" },
    storage,
    renderDebounceMs: Number(env.RENDER_DEBOUNCE_MS ?? 15_000),
    tts: {
      driver: env.TTS_DRIVER?.trim() === "off" ? "off" : "piper",
      piperBin: env.PIPER_BIN?.trim() || "/opt/piper/piper",
      voicesDir: env.PIPER_VOICES_DIR?.trim() || "/opt/piper/voices",
      concurrency: Math.max(1, Number(env.TTS_CONCURRENCY) || Math.min(2, availableParallelism())),
      cueWaitMs: Math.max(0, Number(env.TTS_CUE_WAIT_MS ?? 2500)),
    },
  };
}
