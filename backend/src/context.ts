import type { Config } from "./config.ts";
import type { Sql } from "./db.ts";
import { createMailer, type Mailer } from "./email/mailer.ts";
import { Jobs } from "./jobs.ts";
import type { Log } from "./log.ts";
import { createClaudeChunkParser, type ChunkParser } from "./parse/llm.ts";
import { createStorage } from "./storage/index.ts";
import type { Storage } from "./storage/storage.ts";

// Everything a route or background job needs. Tests build one with fakes.
export interface Ctx {
  config: Config;
  sql: Sql;
  storage: Storage;
  mailer: Mailer;
  log: Log;
  jobs: Jobs;
  chunkParser: ChunkParser | null;
  renderWorker: { kick(): void }; // wakes the in-process render worker after a forced render
}

export function createCtx(config: Config, sql: Sql, log: Log, overrides: Partial<Ctx> = {}): Ctx {
  return {
    config,
    sql,
    log,
    storage: overrides.storage ?? createStorage(config),
    mailer: overrides.mailer ?? createMailer(config, log),
    jobs: overrides.jobs ?? new Jobs(log),
    chunkParser:
      overrides.chunkParser !== undefined
        ? overrides.chunkParser
        : config.anthropicApiKey
          ? createClaudeChunkParser(config.anthropicApiKey)
          : null,
    renderWorker: overrides.renderWorker ?? { kick() {} },
  };
}
