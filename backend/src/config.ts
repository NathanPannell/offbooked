import { availableParallelism } from "node:os";

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
  /** Other frontends on this API (staging) whose sign-in links land back on themselves, exact origins. */
  extraAppUrls: string[];
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
  /** Accounts that may open the admin area (src/admin.ts), lowercased. Empty: nobody. */
  adminEmails: string[];
}

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

// Exact origins only: a sign-in link carries a live token, so a pattern like CORS_ORIGINS'
// "https://*.vercel.app" would let anyone's deployment ask for links that land on it.
function appOrigins(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => trimSlash(s.trim()))
    .filter(Boolean)
    .map((url) => {
      if (url.includes("*") || !URL.canParse(url) || new URL(url).origin !== url)
        throw new Error(`EXTRA_APP_URLS must list exact origins like https://staging.example.com, not ${url}`);
      return url;
    });
}

/** Where a sign-in link lands: the frontend that asked (its Origin) when it is one of EXTRA_APP_URLS, else APP_URL. */
export function signInAppUrl(config: Pick<Config, "appUrl" | "extraAppUrls">, origin: string | undefined): string {
  return origin && config.extraAppUrls.includes(origin) ? origin : config.appUrl;
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
    extraAppUrls: appOrigins(env.EXTRA_APP_URLS),
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
    adminEmails: (env.ADMIN_EMAILS ?? "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  };
}
