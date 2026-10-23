-- A director can delete their account (DELETE /api/me, retention.ts deleteAccount). The row stays
-- as a tombstone, with no email or name, because productions keep their owner_id; deleted_at says
-- when it went.
alter table users add column if not exists deleted_at timestamptz;
