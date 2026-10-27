-- The admin area (src/admin.ts, routes/admin.ts). Admins are the accounts whose email is in
-- ADMIN_EMAILS; nothing in the database says who is one. Every time an admin opens a production
-- they don't own, or a person's trace, a row lands here (at most one per admin, action and subject
-- every 10 minutes, so playing a run-through doesn't write a row a line).
create table if not exists admin_audit (
  id uuid primary key default gen_random_uuid(),
  admin_user_id uuid not null references users(id),
  action text not null check (action in ('view_production', 'view_person')),
  production_id uuid references productions(id),
  subject text,
  created_at timestamptz not null default now()
);
create index if not exists admin_audit_recent_idx on admin_audit (created_at desc);
create index if not exists admin_audit_admin_idx on admin_audit (admin_user_id, action, created_at desc);

-- The admin figures group takes by production and by the director who recorded them.
create index if not exists takes_production_idx on takes (production_id, created_at);
create index if not exists takes_director_idx on takes (recorded_by_user_id) where recorded_by_user_id is not null;
create index if not exists admin_audit_production_idx on admin_audit (production_id, created_at desc) where production_id is not null;
