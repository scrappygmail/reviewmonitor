-- Run this once in the Supabase SQL editor for an EXISTING database.
-- (schema.sql already includes these columns for anyone setting up fresh.)
--
-- Adds phone/email to businesses so discover.py's new -email extraction
-- and phone parsing have somewhere to be saved. Existing rows will have
-- NULL here until they're re-discovered (same keyword+city search again -
-- it upserts on place_id, so it'll backfill on that run, not automatically).

alter table businesses add column if not exists phone text;
alter table businesses add column if not exists email text;
