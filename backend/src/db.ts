import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import type { Log } from "./log.ts";

export type Sql = postgres.Sql;
export type Tx = postgres.TransactionSql;

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const MIGRATION_LOCK = 4_204_771_001;

export function createSql(url: string, opts: { schema?: string; max?: number } = {}): Sql {
  return postgres(url, {
    max: opts.max ?? 10,
    transform: postgres.camel,
    onnotice: () => {},
    // Neon ignores a bare search_path startup parameter but honours it through options.
    connection: opts.schema ? { options: `-c search_path=${opts.schema}` } : {},
  });
}

// Each file runs in its own transaction under a transaction-scoped advisory lock, so
// concurrent boots (or a pooled connection) never apply the same file twice.
export async function migrate(sql: Sql, log?: Log): Promise<string[]> {
  const files = (await readdir(MIGRATIONS_DIR)).filter((f) => /^\d{3}_.+\.sql$/.test(f)).sort();
  const applied: string[] = [];
  for (const file of files) {
    const body = await readFile(MIGRATIONS_DIR + file, "utf8");
    await sql.begin(async (tx) => {
      await tx`select pg_advisory_xact_lock(${MIGRATION_LOCK})`;
      await tx`create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())`;
      const [done] = await tx`select 1 from schema_migrations where name = ${file}`;
      if (done) return;
      await tx.unsafe(body);
      await tx`insert into schema_migrations (name) values (${file})`;
      applied.push(file);
    });
  }
  if (applied.length) log?.info({ applied }, "migrations applied");
  return applied;
}
