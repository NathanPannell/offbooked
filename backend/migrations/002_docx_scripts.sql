-- Scripts can now be uploaded as Word .docx files.
alter table scripts drop constraint scripts_source_kind_check;
alter table scripts add constraint scripts_source_kind_check check (source_kind in ('pdf', 'docx', 'text'));
