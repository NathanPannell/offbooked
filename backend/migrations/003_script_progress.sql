-- How far a script parse has got, shown to the director while it runs.
alter table scripts add column progress jsonb;

-- Where each line came from in the uploaded file, for the side-by-side source view.
alter table lines add column source_line int;
alter table lines add column source_page int;

-- One link the whole cast can use to pick their characters; bumping the version revokes it.
alter table productions add column join_version int not null default 1;
