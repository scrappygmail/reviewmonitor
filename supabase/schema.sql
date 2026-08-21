-- ============================================================
-- Google Maps Negative Review Monitor — Supabase Schema
-- Single-user, no auth. Run this in Supabase SQL editor.
-- ============================================================

create extension if not exists "pgcrypto";

-- All businesses ever discovered (via keyword search) live here.
-- "monitored" = true means the 6-hourly cron scans it for reviews.
-- "last_scanned_at" drives the rotation logic for full-scan.
create table businesses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  google_maps_url text not null,
  place_id text unique,
  address text,
  phone text,                    -- business's own contact number (from Google listing)
  email text,                    -- best-effort, scraped from the business website if listed
  keyword text not null,        -- e.g. "plumber", "electrician"
  city text,                    -- e.g. "Manchester"
  rating numeric,                -- overall business rating (from discovery)
  monitored boolean default false,   -- true = in the small watch list (cron every 6h)
  last_scanned_at timestamptz,       -- used for full-scan rotation priority
  created_at timestamptz default now()
);

create index idx_businesses_keyword on businesses(keyword);
create index idx_businesses_monitored on businesses(monitored);
create index idx_businesses_last_scanned on businesses(last_scanned_at nulls first);

-- Reviews found for any business (discovered or monitored).
create table reviews (
  id uuid primary key default gen_random_uuid(),
  business_id uuid references businesses(id) on delete cascade,
  review_id text not null,          -- google's own review id (dedup key)
  author text,
  rating int not null,
  review_text text,
  review_date timestamptz,
  is_negative boolean generated always as (rating <= 3) stored,
  notified boolean default false,
  scraped_at timestamptz default now(),
  unique(business_id, review_id)
);

create index idx_reviews_negative on reviews(is_negative) where is_negative = true;
create index idx_reviews_business on reviews(business_id);

-- Web push subscriptions (PWA notifications, single user but could be
-- multiple devices/browsers).
create table push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  endpoint text not null unique,
  p256dh text not null,
  auth text not null,
  created_at timestamptz default now()
);

-- Every scraper run (discovery, profession-scan, full-scan, monitor)
-- logs here so the UI can show "last checked" and history.
create table scrape_logs (
  id uuid primary key default gen_random_uuid(),
  run_type text not null,        -- 'discover' | 'monitor' | 'profession_scan' | 'full_scan'
  keyword text,                  -- populated for discover/profession_scan
  city text,                     -- populated for discover/profession_scan - without this,
                                  -- "plumber" searches in different cities got merged together
  businesses_scanned int default 0,
  new_reviews_found int default 0,
  negative_reviews_found int default 0,
  status text default 'success', -- running | success | failed | partial
  error_message text,
  ran_at timestamptz default now()
);

-- Links each review back to the specific run that found it, so the
-- dashboard can show "this session's results" grouped by scan instead of
-- everything mixed together. Added via ALTER since scrape_logs has to
-- exist first for the foreign key.
alter table reviews add column scan_id uuid references scrape_logs(id) on delete set null;
create index idx_reviews_scan_id on reviews(scan_id);

-- Simple settings row (single user, single row).
create table app_settings (
  id int primary key default 1,
  push_enabled boolean default true,
  min_rating_alert int default 3,
  full_scan_batch_size int default 150,   -- how many businesses per full-scan run
  constraint single_row check (id = 1)
);

insert into app_settings (id) values (1) on conflict do nothing;

-- Single shared row tracking whatever job is currently running (discover,
-- monitor, full_scan, profession_scan). Since this is a single-user app,
-- only one job realistically runs at a time. The Python workers update
-- this as they go (per business), and the dashboard polls it to show a
-- real progress bar + elapsed time, and to know which GitHub Actions run
-- to cancel if the user hits Stop.
create table job_status (
  id int primary key default 1,
  job_type text,               -- 'discover' | 'monitor' | 'full_scan' | 'profession_scan'
  status text default 'idle',  -- idle | running | done | failed | cancelled
  current_index int default 0,
  total_count int default 0,
  current_label text,          -- e.g. business name currently being scanned
  run_id text,                 -- GitHub Actions run id, used by the Stop button
  started_at timestamptz,
  updated_at timestamptz default now(),
  constraint single_row check (id = 1)
);

insert into job_status (id) values (1) on conflict do nothing;

-- 90-day retention: delete reviews older than 90 days.
-- Call this from cleanup_old_reviews.py on a schedule (or pg_cron if enabled).
create or replace function delete_old_reviews() returns void as $$
begin
  delete from reviews where scraped_at < now() - interval '90 days';
end;
$$ language plpgsql security definer;

-- ============================================================
-- Row Level Security
--
-- No login means the "anon" key is public by design (it ships inside
-- the browser JS bundle, anyone can read it via devtools). Without RLS,
-- that key would have full read+write+delete access to every table.
-- These policies make the anon key READ-ONLY - it can display data but
-- can never insert/update/delete a row. All writes (discovery results,
-- review syncs, the monitored on/off toggle, push subscriptions) go
-- through the Next.js API routes or GitHub Actions scripts instead,
-- both of which use the service_role key - which bypasses RLS entirely
-- and is NEVER exposed to the browser.
-- ============================================================

alter table businesses enable row level security;
alter table reviews enable row level security;
alter table scrape_logs enable row level security;
alter table app_settings enable row level security;
alter table job_status enable row level security;
-- push_subscriptions has NO read policy below - the dashboard never
-- needs to read it client-side, so the anon key gets zero access to it.
alter table push_subscriptions enable row level security;

create policy "anon can read businesses" on businesses for select using (true);
create policy "anon can read reviews" on reviews for select using (true);
create policy "anon can read scrape_logs" on scrape_logs for select using (true);
create policy "anon can read app_settings" on app_settings for select using (true);
create policy "anon can read job_status" on job_status for select using (true);

-- RLS policies control ROW-level access, but Postgres still requires a
-- base table-level GRANT for any role to touch a table at all - this
-- applies to "anon" (the browser) just as much as "service_role"
-- (the scraper/Functions). Without these grants, both sides fail with
-- "permission denied for table X" even though RLS is configured
-- correctly.
grant usage on schema public to anon, authenticated, service_role;
grant select on businesses, reviews, scrape_logs, app_settings, job_status to anon, authenticated;
grant all privileges on all tables in schema public to service_role;
grant all privileges on all sequences in schema public to service_role;
alter default privileges in schema public grant select on tables to anon, authenticated;
alter default privileges in schema public grant all on tables to service_role;
