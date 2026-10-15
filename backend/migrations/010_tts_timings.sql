-- When each spoken segment of a synthesized clip starts and ends (ms, in the normalized clip):
-- one segment per printed line, and the narrator's parts of a line apart from the character's.
-- The run-through highlights words as they are read from these. Null for clips made before.
alter table tts_clips add column if not exists timings jsonb;
