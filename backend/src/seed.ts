// Demo data for local development: `npm run seed` (idempotent) or `npm run seed -- --reset`
// (archives the previous demo production and builds a fresh one; nothing is deleted).
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { loadConfig } from "./config.ts";
import { createCtx } from "./context.ts";
import { randomToken, sha256 } from "./crypto.ts";
import { createSql, migrate } from "./db.ts";
import { inviteUrl } from "./invite.ts";
import { consoleLog } from "./log.ts";
import { startScriptParse } from "./parse/job.ts";
import { makeTone, probeDurationSeconds } from "./render/ffmpeg.ts";
import { wordCount } from "./render/plan.ts";
import { processDueRenders, scheduleRender } from "./render/queue.ts";
import { SEED_SCENE, SEED_TITLE } from "./seed-scene.ts";

const DIRECTOR_EMAIL = "director@example.test";
const CAST = [
  { name: "Riz Ahmed", firstName: "Riz", email: null, characters: ["HAMLET"], tone: 220 },
  { name: "Jo Martin", firstName: "Jo", email: "jo@example.test", characters: ["HORATIO", "MARCELLUS"], tone: 330 },
  { name: "Lee Chan", firstName: "Lee", email: null, characters: ["KING", "POLONIUS"], tone: 165 },
  { name: "Ana Ruiz", firstName: null, email: "ana@example.test", characters: ["QUEEN"], tone: 440 },
];

const config = loadConfig();
const sql = createSql(config.databaseUrl, { max: 4 });
const ctx = createCtx(config, sql, consoleLog, { labeler: null });

try {
  await migrate(sql, consoleLog);
  const [director] = await sql<{ id: string }[]>`
    insert into users (email, name) values (${DIRECTOR_EMAIL}, 'Sam Director')
    on conflict (email) do update set name = coalesce(users.name, excluded.name) returning id`;
  if (process.argv.includes("--reset")) {
    await sql`update productions set archived_at = now() where owner_id = ${director!.id} and title = ${SEED_TITLE} and archived_at is null`;
  }
  let [production] = await sql<{ id: string }[]>`
    select id from productions where owner_id = ${director!.id} and title = ${SEED_TITLE} and archived_at is null order by created_at desc limit 1`;
  if (!production) production = await createDemo(director!.id);

  const token = randomToken();
  await sql`insert into login_tokens (token_hash, email, expires_at) values (${sha256(token)}, ${DIRECTOR_EMAIL}, now() + interval '15 minutes')`;
  const actors = await sql<{ id: string; name: string; tokenVersion: number }[]>`
    select id, name, token_version from actors where production_id = ${production.id} order by created_at`;
  console.log(`\nProduction: ${SEED_TITLE} (${production.id})`);
  console.log(`Director sign-in (15 min, single use): ${config.appUrl}/auth/verify?token=${token}`);
  for (const a of actors) console.log(`Invite for ${a.name}: ${inviteUrl(config.appUrl, config.inviteSecret, a.id, a.tokenVersion)}`);
} finally {
  await ctx.jobs.idle();
  await ctx.tts?.close();
  await sql.end({ timeout: 5 });
}

async function createDemo(ownerId: string): Promise<{ id: string }> {
  const [p] = await sql<{ id: string }[]>`
    insert into productions (owner_id, title, performance_starts_on, performance_ends_on)
    values (${ownerId}, ${SEED_TITLE}, current_date + 53, current_date + 60) returning id`;
  await startScriptParse(ctx, p!.id, { kind: "text", text: SEED_SCENE });
  await ctx.jobs.idle();
  const characters = new Map(
    (await sql<{ id: string; name: string }[]>`select id, name from characters where production_id = ${p!.id}`).map((c) => [c.name, c.id]),
  );
  const dir = await mkdtemp(path.join(tmpdir(), "offbooked-seed-"));
  try {
    let lineIndex = 0;
    for (const member of CAST) {
      const [actor] = await sql<{ id: string }[]>`
        insert into actors (production_id, name, email, email_verified_at, first_name, opened_at, last_active_at)
        values (${p!.id}, ${member.name}, ${member.email}, ${member.email ? new Date() : null}, ${member.firstName},
          ${member.firstName ? new Date() : null}, ${member.firstName ? new Date() : null})
        returning id`;
      const ids = member.characters.map((name) => characters.get(name)).filter((id): id is string => Boolean(id));
      for (const characterId of ids) await sql`insert into actor_characters (actor_id, character_id) values (${actor!.id}, ${characterId})`;
      const lines = await sql<{ id: string; text: string }[]>`
        select id, text from lines where production_id = ${p!.id} and kind = 'dialogue' and character_id = any(${ids}::uuid[]) order by seq`;
      for (const line of lines) {
        // Leave roughly one line in five unrecorded so the run-through shows placeholders.
        if (++lineIndex % 5 === 0 || !member.firstName) continue;
        const takeId = randomUUID();
        const file = path.join(dir, `${takeId}.wav`);
        await makeTone(Math.min(8, Math.max(0.8, wordCount(line.text) * 0.33)), member.tone, file);
        const key = `productions/${p!.id}/takes/${takeId}.wav`;
        const audio = await readFile(file);
        await ctx.storage.put(key, audio, "audio/wav");
        const durationMs = Math.round(((await probeDurationSeconds(file)) ?? 1) * 1000);
        await sql`insert into takes (id, production_id, line_id, actor_id, storage_key, content_type, bytes, duration_ms)
                  values (${takeId}, ${p!.id}, ${line.id}, ${actor!.id}, ${key}, 'audio/wav', ${audio.length}, ${durationMs})`;
        await sql`update lines set current_take_id = ${takeId} where id = ${line.id}`;
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  await scheduleRender(ctx, p!.id, { force: true });
  await processDueRenders(ctx);
  return p!;
}
