-- Line-by-line playback: each take's normalized audio as a small AAC .m4a, made with the
-- normalized FLAC the render uses (or on demand for takes normalized before this).
alter table takes add column stream_key text;
