-- Performance dates and content retention. A production's script content and recordings are
-- deleted 7 days after its final performance (src/retention.ts); the row stays as a tombstone with
-- content_deleted_at set. The old single performance_date is no longer read or written.
alter table productions add column if not exists performance_starts_on date;
alter table productions add column if not exists performance_ends_on date;
alter table productions add column if not exists content_deleted_at timestamptz;

-- Productions made before performance dates existed: the old date becomes the opening night, and
-- every production without a final date gets one year from the day this shipped (2026-10-20).
update productions set performance_starts_on = performance_date
  where performance_starts_on is null and performance_date is not null and performance_date <= date '2027-10-20';
update productions set performance_ends_on = date '2027-10-20' where performance_ends_on is null;

alter table productions drop constraint if exists productions_performance_order;
alter table productions add constraint productions_performance_order
  check (performance_starts_on is null or performance_ends_on is null or performance_starts_on <= performance_ends_on);

-- The retention worker's one startup query: the earliest final performance with content left.
create index if not exists productions_content_due_idx on productions (performance_ends_on) where content_deleted_at is null;
