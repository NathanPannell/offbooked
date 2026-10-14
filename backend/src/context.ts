import type { Config } from "./config.ts";
import type { Sql } from "./db.ts";
import { createMailer, type Mailer } from "./email/mailer.ts";
import { Jobs } from "./jobs.ts";
import type { Log } from "./log.ts";
import { createClaudeLabeler, type Labeler } from "./parse/label.ts";
import { createStorage } from "./storage/index.ts";
import type { Storage } from "./storage/storage.ts";
import { PiperSynthesizer, type Synthesizer } from "./tts/piper.ts";
import { TtsService } from "./tts/service.ts";

// Everything a route or background job needs. Tests build one with fakes.
export interface Ctx {
  config: Config;
  sql: Sql;
  storage: Storage;
  mailer: Mailer;
  log: Log;
  jobs: Jobs;
  labeler: Labeler | null;
  renderWorker: { kick(): void }; // wakes the in-process render worker after a forced render
  tts: TtsService | null; // null when TTS_DRIVER=off; otherwise it may still report itself unavailable
}

// `synthesizer` replaces Piper (tests pass a fake, or null for no TTS).
export function createCtx(config: Config, sql: Sql, log: Log, overrides: Partial<Ctx> & { synthesizer?: Synthesizer | null } = {}): Ctx {
  const storage = overrides.storage ?? createStorage(config);
  const synthesizer =
    overrides.synthesizer !== undefined
      ? overrides.synthesizer
      : config.tts.driver === "piper"
        ? new PiperSynthesizer({ bin: config.tts.piperBin, voicesDir: config.tts.voicesDir, maxProcs: config.tts.concurrency, log })
        : null;
  return {
    config,
    sql,
    log,
    storage,
    mailer: overrides.mailer ?? createMailer(config, log),
    jobs: overrides.jobs ?? new Jobs(log),
    labeler: overrides.labeler !== undefined ? overrides.labeler : config.anthropicApiKey ? createClaudeLabeler(config.anthropicApiKey) : null,
    renderWorker: overrides.renderWorker ?? { kick() {} },
    tts: synthesizer ? new TtsService({ sql, storage, log, synthesizer, concurrency: config.tts.concurrency }) : null,
  };
}
