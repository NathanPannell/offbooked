-- Offbooked is in private beta: setting up a production needs an account with beta access, which a
-- director gets by entering the access code (POST /api/me/beta-access, src/beta.ts). Everyone who
-- has an account today already had access, so they keep it. Cast members never need it.
alter table users add column if not exists beta_access_at timestamptz;
update users set beta_access_at = now() where beta_access_at is null and deleted_at is null;
