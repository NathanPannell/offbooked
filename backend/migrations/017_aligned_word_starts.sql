-- Word starts re-timed on the server (src/realign.ts): the app's live word starts laid on the
-- take's voice once it is normalized, in ms of the uploaded recording like word_starts_ms, which
-- keeps what the app sent. Null until the take is normalized (or when they couldn't be re-timed);
-- served in place of word_starts_ms when set.
alter table takes add column if not exists aligned_word_starts_ms integer[];
