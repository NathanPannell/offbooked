import { buildApp } from "./app.ts";
import { loadConfig } from "./config.ts";
import { createCtx } from "./context.ts";
import { createSql, migrate } from "./db.ts";
import { recoverScriptParses } from "./parse/job.ts";
import { recoverRenders, startRenderWorker } from "./render/queue.ts";
import { startRetentionWorker } from "./retention.ts";

const config = loadConfig();
const sql = createSql(config.databaseUrl);
const revision = process.env.APP_REVISION ?? process.env.RAILWAY_GIT_COMMIT_SHA;
const port = Number(process.env.PORT ?? 8080);

const renderKick = { kick: () => {} };
const retentionKick = { kick: () => {}, touch: () => {} };
let app: ReturnType<typeof buildApp> | undefined;
const log = {
  info: (obj: object, msg?: string) => app?.log.info(obj, msg),
  warn: (obj: object, msg?: string) => app?.log.warn(obj, msg),
  error: (obj: object, msg?: string) => app?.log.error(obj, msg),
};
const ctx = createCtx(config, sql, log, { renderWorker: renderKick, retention: retentionKick });
app = buildApp({ revision, ctx });

try {
  await migrate(sql, log);
  await recoverRenders(ctx);
  await recoverScriptParses(ctx);
  await app.listen({ port, host: "0.0.0.0" });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

const worker = startRenderWorker(ctx);
renderKick.kick = worker.kick;
const retention = startRetentionWorker(ctx);
retentionKick.kick = retention.kick;
retentionKick.touch = retention.touch;

for (const signal of ["SIGTERM", "SIGINT"] as const) {
  process.once(signal, async () => {
    app.log.info({ signal }, "shutting down");
    await app.close();
    await worker.stop();
    await retention.stop();
    await ctx.jobs.idle();
    await ctx.tts?.close();
    await sql.end({ timeout: 5 });
    process.exit(0);
  });
}
