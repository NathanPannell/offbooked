-- No script review: parsed lines are taken as read, so existing flags are cleared.
update lines set flagged = false, flag_code = null, flag_reason = null where flagged;
