-- Standard flag codes for parsed lines (backend/src/parse/flags.ts has the labels). flag_reason
-- stays as an optional short detail. Older rows only have free text, so they are sorted into the
-- same buckets as classifyFlagReason in flags.ts, by pattern, first match wins.
alter table lines add column flag_code text;
alter table lines add constraint lines_flag_code_check
  check (flag_code in ('speaker', 'missed_cue', 'direction', 'text', 'heading', 'backup'));

update lines set flag_code = case
  when flag_reason ~* 'backup parser|heuristic' then 'backup'
  -- "speech resumes after the direction, no cue": the speaker was inferred.
  when flag_reason ~* '\m(continu\w*|resum\w*|carr(y|ies) on|goes on)\M'
       and flag_reason !~* 'unclear|could be|may be|might be|garbl|misattribut' then 'speaker'
  when flag_reason ~* 'missed|more than one speaker|two speakers|very long speech|inline cue|split at' then 'missed_cue'
  when flag_reason ~* '\m(act|scene)\M.*\m(inferred|not printed|number|header|heading)\M|\mheading\M|running.header' then 'heading'
  when flag_reason ~* 'differs|not found|labell?ed by the parser|not part of the play|skipp|page number|stray|artifact|footnote|garbled line|marginal|editorial' then 'text'
  when flag_reason ~* 'no speaker found|direction|parenthetical|delivery' then 'direction'
  when flag_reason ~* 'speaker|\mcue|speaks only once|assigned to|could be|merged|joint|shared|sung|song|inferred' then 'speaker'
  when kind = 'stage_direction' then 'direction'
  when kind = 'heading' then 'heading'
  else 'speaker'
end
where flagged;

-- Generic reasons that only repeat what the code's label already says.
update lines set flag_reason = null
where flagged and (flag_reason like 'This part was read by the backup parser%' or flag_reason = 'The parser was unsure about this line');
