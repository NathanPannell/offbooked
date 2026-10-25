import { availableParallelism } from "node:os";
import { DEFAULT_BETA_ACCESS_CODE } from "./beta.ts";

export type StorageConfig =
  { driver: "local"; dir: string } | { driver: "s3"; endpoint: string; bucket: string; region: string; accessKeyId: string; secretAccessKey: string };

export interface TtsConfig {
  driver: "piper" | "off";
  piperBin: string;
  voicesDir: string;
  concurrency: number; // clips synthesized at once (Piper keeps one process per model on top, see pooledProcs)
  cueWaitMs: number; // how long a lines request waits for missing TTS cue clips
}

export interface AlignConfig {
  driver: "wav2vec2" | "off";
  modelPath: string; // the aligner's ONNX model (align/model.ts), as in the Docker image
  threads: number; // CPU threads one alignment uses
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
  /** Normalize each take as soon as it is uploaded (its cut, levelled clip and re-timed words), one at a time. */
  normalizeOnUpload: boolean;
  tts: TtsConfig;
  align: AlignConfig;
  /** The phrase a director enters once for beta access, which setting up a production needs (src/beta.ts). */
  betaAccessCode: string;
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
    corsOrigins: (env.CORS_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    sessionSecret: required(env, "SESSION_SECRET"),
    inviteSecret: required(env, "INVITE_TOKEN_SECRET"),
    anthropicApiKey: env.ANTHROPIC_API_KEY?.trim() || null,
    email: { driver: emailDriver, resendApiKey, from: env.EMAIL_FROM?.trim() || "Offbooked <hello@offbooked.com>" },
    storage,
    renderDebounceMs: Number(env.RENDER_DEBOUNCE_MS ?? 15_000),
    normalizeOnUpload: env.NORMALIZE_ON_UPLOAD?.trim() !== "0",
    tts: {
      driver: env.TTS_DRIVER?.trim() === "off" ? "off" : "piper",
      piperBin: env.PIPER_BIN?.trim() || "/opt/piper/piper",
      voicesDir: env.PIPER_VOICES_DIR?.trim() || "/opt/piper/voices",
      concurrency: Math.max(1, Number(env.TTS_CONCURRENCY) || Math.min(2, availableParallelism())),
      cueWaitMs: Math.max(0, Number(env.TTS_CUE_WAIT_MS ?? 2500)),
    },
    align: {
      driver: env.ALIGN_DRIVER?.trim() === "off" ? "off" : "wav2vec2",
      modelPath: env.ALIGN_MODEL?.trim() || "/opt/align/wav2vec2-base-960h-q4.onnx",
      threads: Math.max(1, Number(env.ALIGN_THREADS) || Math.min(2, availableParallelism())),
    },
    betaAccessCode: env.BETA_ACCESS_CODE?.trim() || DEFAULT_BETA_ACCESS_CODE,
  };
}
