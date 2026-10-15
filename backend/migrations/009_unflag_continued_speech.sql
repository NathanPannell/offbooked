-- A speech that carries on after a stage direction, page break or heading without a new cue
-- keeps its speaker and is no longer flagged (the inference has held up in review). Older rows
-- flagged only for that are settled here; 006 had given them the code 'speaker'.
update lines set flagged = false, flag_code = null, flag_reason = null
where flagged
  and flag_reason ~* '\m(continu\w*|resum\w*|carr(y|ies) on|goes on)\M'
  and flag_reason !~* 'unclear|could be|may be|might be|garbl|misattribut';
