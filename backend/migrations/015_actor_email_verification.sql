-- A cast member's email counts only once they have opened the link sent to it. `email` holds the
-- verified address; `pending_email` the one waiting for its link (sent at `pending_email_sent_at`).
alter table actors add column if not exists email_verified_at timestamptz;
alter table actors add column if not exists pending_email text;
alter table actors add column if not exists pending_email_sent_at timestamptz;

-- Addresses left before verification existed stay as they were: verified, so nobody loses the
-- completion emails or the details kept with an email.
update actors set email_verified_at = created_at
where email_verified_at is null and coalesce(btrim(email), '') <> '';
