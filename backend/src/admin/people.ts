import type { Sql } from "../db.ts";
import { badRequest } from "../errors.ts";

// Who a person is, across productions. Cast members have no accounts: each production they join
// makes a new actors row. So the admin area groups by email where there is one:
//   e:<email>  a director account, and every cast row whose verified email is that address
//   u:<uuid>   a deleted account (its email went with it)
//   a:<uuid>   a cast row with no verified email, which is only ever itself
// The SQL below must agree with personKey's parsing. Aliases are fixed: `u` users, `a` actors and
// `du` the account behind a director's own cast row (actors.director_user_id).

export type PersonKey = { kind: "email"; email: string } | { kind: "user"; id: string } | { kind: "actor"; id: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parsePersonKey(key: string): PersonKey {
  const [prefix, rest] = [key.slice(0, 2), key.slice(2)];
  if (prefix === "e:" && rest.includes("@") && rest.length <= 320) return { kind: "email", email: rest.toLowerCase() };
  if (prefix === "u:" && UUID.test(rest)) return { kind: "user", id: rest.toLowerCase() };
  if (prefix === "a:" && UUID.test(rest)) return { kind: "actor", id: rest.toLowerCase() };
  throw badRequest("That isn't a person key.");
}

/** The one spelling of a key, so the same person is always the same audit subject. */
export const formatPersonKey = (k: PersonKey) => (k.kind === "email" ? `e:${k.email}` : k.kind === "user" ? `u:${k.id}` : `a:${k.id}`);

/** The key of the account `u`. */
export const userKey = (sql: Sql, alias = "u") =>
  sql`(case when ${sql(alias)}.deleted_at is null then 'e:' || lower(${sql(alias)}.email) else 'u:' || ${sql(alias)}.id::text end)`;

/** The key of the cast row `a` (left join `du` on a.director_user_id). */
export const actorKey = (sql: Sql) =>
  sql`(case when du.id is not null then ${userKey(sql, "du")}
            when a.email_verified_at is not null and nullif(btrim(a.email), '') is not null then 'e:' || lower(btrim(a.email))
            else 'a:' || a.id::text end)`;

/** The key of whoever recorded take `t` (left joins: `u` on recorded_by_user_id, `a` on actor_id, `du`). */
export const takeKey = (sql: Sql) => sql`(case when t.recorded_by = 'director' then ${userKey(sql)} else ${actorKey(sql)} end)`;

/** Takes with their recorder's key, name and email: `from ${takesWithPerson(sql)} tp`. */
export const takesWithPerson = (sql: Sql) => sql`(
  select t.id, t.production_id, t.line_id, t.created_at, t.deleted_at, t.recorded_by,
    ${takeKey(sql)} as person,
    case when t.recorded_by = 'director' then coalesce(u.name, u.email) else nullif(btrim(a.name), '') end as name,
    case when t.recorded_by = 'director' then (case when u.deleted_at is null then u.email end)
         when a.email_verified_at is not null then nullif(btrim(a.email), '') end as email
  from takes t
    left join users u on u.id = t.recorded_by_user_id
    left join actors a on a.id = t.actor_id
    left join users du on du.id = a.director_user_id)`;

/** Every (person, production) someone is in: as its owner, a cast row, or by recording in it. */
export const memberships = (sql: Sql) => sql`(
  select ${userKey(sql)} as person, p.id as production_id, 'owner' as role from productions p join users u on u.id = p.owner_id
  union
  select ${actorKey(sql)}, a.production_id, case when du.id is null then 'cast' else 'owner' end
  from actors a left join users du on du.id = a.director_user_id
  union
  select tp.person, tp.production_id, case when tp.recorded_by = 'director' then 'owner' else 'cast' end from ${takesWithPerson(sql)} tp)`;
