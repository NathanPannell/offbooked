import { createSql, migrate } from "./db.ts";

// Applies backend/migrations to DATABASE_URL and exits. CI runs it against a throwaway Postgres;
// the server applies the same migrations at startup.
const url = process.env.DATABASE_URL;
if (!url) throw new Error("Missing required environment variable DATABASE_URL");
const sql = createSql(url, { max: 1 });
try {
  const applied = await migrate(sql);
  console.log(applied.length ? `applied ${applied.join(", ")}` : "already up to date");
} finally {
  await sql.end({ timeout: 5 });
}
