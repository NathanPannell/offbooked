-- The director can record a part themselves through the normal actor flow. Their cast member
-- row points back at them, one per production, so picking another part reuses it.
alter table actors add column if not exists director_user_id uuid references users(id);
create unique index if not exists actors_director_user on actors (production_id, director_user_id) where director_user_id is not null;
