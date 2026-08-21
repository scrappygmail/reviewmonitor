-- Run this once in the Supabase SQL editor for an EXISTING database.
-- (schema.sql already includes this column for anyone setting up fresh.)
--
-- Without a city on scrape_logs, "plumber in Manchester" and "plumber in
-- Texas" were indistinguishable runs - and worse, businesses.py/profession
-- scans matched by keyword ALONE (see the code fix in the same commit),
-- so scanning/showing "plumber" results silently merged every city ever
-- searched under that keyword together.

alter table scrape_logs add column if not exists city text;
