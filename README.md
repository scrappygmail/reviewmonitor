## `README.md`

```markdown
# Review Watch

**Automated Google Maps review monitoring — track any set of business listings, get notified the moment a new 1–3★ review lands, before it does damage to a reputation.**

Review Watch is a free, self-hostable tool for monitoring Google Business Profile reviews across multiple locations. Instead of manually checking dozens of listings, it scans on a schedule, detects newly published reviews, filters out anything negative, and pushes an instant browser notification — all on infrastructure that costs nothing to run.

## Who this is for

Anyone who needs to track Google Maps reviews across multiple business listings without paying for a SaaS subscription: local service businesses, small agencies, freelancers managing several client profiles, or anyone just wanting Google review alerts for their own listing. Deploy your own copy — your data, your infrastructure, zero recurring cost.

## Features

-  Discover Google Maps businesses by keyword + location
-  Incremental review monitoring — new reviews are diffed against history, nothing is ever re-processed
-  Instant alerts for new **1–3★ reviews only**
-  Scheduled monitoring plus a rotating full-database sweep, so nothing goes unchecked indefinitely
-  Native browser/PWA push notifications — including alerts if a scan itself fails
-  Automatic 90-day data retention
-  Runs entirely on free-tier infrastructure — no server to maintain, no subscription

## Tech stack

| Layer | Tech |
|---|---|
| Frontend | Next.js (static export), TypeScript, Tailwind CSS |
| Hosting | Cloudflare Pages |
| API layer | Cloudflare Pages Functions |
| Scheduled jobs | GitHub Actions |
| Database | Supabase (Postgres), row-level security enforced |
| Notifications | Web Push (VAPID) |
| Scraping | Headless browser automation with anti-detection handling |

## How it works

```
Discover       →  businesses table  →  choose which to watch
                                                          ↓
Scheduled scan (6h)       →  new reviews diffed →  1-3★ ones trigger a push alert
Rotation sweep (2x/day)   →  covers the full discovered list over time
Daily cleanup             →  reviews older than 90 days purged
```

Every run — successful or failed — is logged, so failures show up in the dashboard instead of only in CI output.

## Engineering notes

A few constraints shaped the design:

- **Zero ongoing infrastructure cost.** Everything runs on free tiers (Cloudflare Pages, Supabase, GitHub Actions, Web Push) — no persistent server, no paid scraping API.
- **Google Maps caps results at roughly 100–120 per search**, so bulk discovery splits one keyword across multiple location queries instead of assuming a single search returns everything.
- **Scanning a large list on a fixed schedule doesn't scale linearly** — a full sweep is batched and rotated (oldest-scanned-first) to stay inside GitHub Actions' job time limit and a sane request rate.
- **No login, but not wide open.** The browser-exposed Supabase key is restricted via row-level security to read-only; all writes go through Cloudflare Pages Functions using a server-side key that never reaches the client.

## Getting started

See [`SETUP.md`](./SETUP.md) for a full step-by-step deployment guide — Supabase, GitHub Actions, Cloudflare Pages, environment variables, push notifications. No prior DevOps experience required.

## What's new

- **Skips businesses that could never have a negative review.** gosom's own search results include a rating breakdown per business (how many 1-star, 2-star, etc. reviews it has, all-time). If that breakdown shows zero 1-3 star reviews ever, the business is skipped entirely for the (slow, ~90s) review scan — it certainly can't have a negative in just the last 90 days if it's never had one at all. Any uncertainty (missing/unparseable data) defaults to scanning it anyway, so this only ever skips businesses it's fully confident about, never a real lead. Tested against 13 different data-shape scenarios (clean, has negatives, malformed, missing, wrong types) before shipping.
- **Fixed the review-scan budget getting eaten by discovery itself.** A real run on 116 businesses (Cleaner, New Jersey) showed discovery + email extraction (-email visits every business's website) taking 20+ minutes on its own for a big search - and since the 25-min scan budget was measured from the very start of the script, only ~1-2 minutes were left for the part that actually finds negatives, so only 2 of 77 candidate businesses ever got scanned. The scan phase now gets its own fresh scan budget (now 45 min, see below) starting right when it begins, no matter how long discovery took. Workflow timeout-minutes bumped to 90 to comfortably cover the realistic worst case of a long discovery phase plus a full scan back to back.
- **Scan budget bumped from 25 to 45 minutes** for max coverage per search.
- **New "⚡ Fast search (numbers only, no email)" button on Discover.** Email extraction is genuinely the slow part of discovery — it's the only piece of business data that isn't already sitting on Google's own Maps listing (phone number, address, rating, etc. all are), so gosom has to separately visit each business's own unpredictable third-party website just for that one field. This new button skips it entirely for maximum discovery speed, freeing far more of the run's time for the review-scanning phase that actually finds leads. The original "Search" button is completely unchanged and still gets email as before — this is a genuine clone (own workflow file, own API route) with one flag different, not a modification of the existing flow.
- **Review-scanning now runs 3 businesses at a time instead of 1.** This is the part "Fast search" above does NOT touch — checking each business's reviews is a completely separate engine from gosom, and it always launches its own browser per business regardless of the email setting. It previously scraped businesses one at a time. The engine wasn't built for concurrent use (it always reads/writes a single fixed config.yaml/reviews.db), so each of the 3 concurrent slots now gets its own isolated copy of the engine directory instead - correctness was verified with real multi-threaded tests before shipping (confirmed businesses actually overlap in flight, confirmed the per-business tally stays accurate no matter what order they finish in, confirmed the time budget and Stop button both still work correctly under concurrency). 3 is intentionally conservative, not maxed out — there are no proxies configured, so higher concurrency trades speed for a real risk of Google noticing and blocking the pattern from one IP (gosom's own docs warn about exactly this with its own concurrency flag). Can be tuned via `SCAN_CONCURRENCY` in scan_reviews.py if real runs show it's safe to push higher, or need to come down if errors/timeouts increase.

A few small additions on top of the original build:

- **Discover now scans reviews automatically, in the same run.** Search a profession+city and it finds the businesses AND scans every one of their reviews for negatives, all in one workflow run — no separate manual "Scan all reviews for negatives" step needed anymore. Negatives now show automatically on EVERY path into a search's results, not just a fresh search — clicking a "Discovery search" row in My Businesses' Recent Activity, or a page refresh restoring the last search, both land straight on the negative reviews too (previously these could land on what looked like a blank page until "Show negative reviews" was clicked manually). Each review has a "+" to add straight to the watch list — the plain business list (no negative found yet) is no longer shown separately, since the whole point is finding leads, not browsing everything.
- **One business, one negative shown.** A business can end up with more than one negative review saved over time (re-running the same search on a different day can find a newer one), but only the single most recent negative per business is ever displayed or exported — showing 10-15 reviews for the same business isn't useful for a lead list, one is enough to know it's worth a call.
- **Fixed why runs still took 40+ minutes despite the "25-minute budget" fix.** Root cause: `PER_BUSINESS_TIMEOUT_SECONDS` was 8 minutes — a single business getting rate-limited/blocked by Google (no proxies configured) could eat almost 10% of the whole run's ceiling by itself, and a handful of them stacking up was enough to blow past everything. Dropped to 90 seconds. Also: the "stop after first negative" logic only ever saved database-write time, not scrape time — the review-scraping engine runs as a full separate process per business and only hands back control once it's completely done, so there was never a way to interrupt it mid-scrape the instant a negative appeared. The actual lever for speed is `max_reviews` (dropped from 20 to 10) and the per-business timeout above. Also fixed the internal time budget itself: it was measured from when review-scanning started, not from the start of the whole run, so setup + business discovery time wasn't counted — a run could still blow past the outer 40-minute GitHub Actions ceiling before the internal graceful-stop ever got a chance to fire and save partial results. It now measures from the true start of the run.
- **Much faster, with a hard 25-minute internal budget.** A combined discover+scan run was taking 80+ minutes for ~75 businesses. Fixed with three changes: (1) each business scan now stops as soon as ONE negative review is found instead of reading up to 100 reviews per business — one negative is enough to flag a lead; (2) `max_reviews` per business dropped from 100 to 20; (3) `scan_many()` now tracks wall-clock time and stops cleanly after 25 minutes no matter how many businesses are left, saving whatever was found rather than running long or getting killed mid-write. The "Stop" button now works properly too — it sends a real signal the Python process catches, finishes the business it's mid-scan on, and saves everything found so far instead of just discarding it.
- **Per-run CSV export.** Every scan/discover run in "Recent activity" now has a ⬇ button — one click gets you a CSV of just that run's negative reviews (business, phone, email, address, rating, review text, author, date, Maps link). Generated client-side, no extra backend needed.
- **Scan window back to 90 days.** Was briefly changed to 28, but that meant a business with no reviews posted in the last 28 days would scan clean even if it has plenty of older negative reviews — reverted.
- **Location accuracy.** Discovery now treats the entered location as a scope rather than a loose search keyword — gosom's search is free-text, not a geographic boundary, and could (and did) return businesses from a same-named city in a completely different state. For ambiguous city names, enter the state/country (e.g. `Rome, GA`). Results are validated against the address before being saved, so a `Rome` search can no longer silently save a `Mesa, AZ` business as a Rome result.
- **Fixed a silent total-failure bug.** After the city column was added to `scrape_logs`, Supabase's PostgREST schema cache didn't immediately pick it up — every single review scan was crashing on its very first database write, before scanning even one business. That's why negative-review counts were showing as 0 across every search after that point. Now falls back to inserting without the city field if that specific stale-cache error occurs.
- **Added the missing `/api/job-check` endpoint.** It was referenced by the frontend but never actually existed, so a crashed or hung GitHub Actions run never got reconciled — this is why "in progress..." could get stuck in Recent Activity for hours.
- **Errors actually show up now.** Discover / scan / check-now used to fail silently and just sit on "Searching…" forever if something went wrong server-side. Now you get an alert telling you what broke.

**Gotcha to remember:** the `GITHUB_ACTIONS_TOKEN` in Cloudflare Pages env vars is a personal access token — it *will* expire or get revoked eventually. If the dashboard buttons start hanging on "Starting…" with no error (or now, a "Bad credentials" alert), that token is almost always the culprit. Fix: generate a fresh one on GitHub, drop it into Cloudflare Pages → Settings → Environment variables, then hit "Retry deployment" so it actually picks up the change.

## License

MIT — use it, fork it, deploy it for yourself or anyone else.
```

## `SETUP.md`

```markdown
# Setup Guide

This walks through deploying your own copy of Review Watch from scratch. No coding required — just follow the steps in order.

## Before you start

- A computer with internet access
- An email address (for creating accounts)
- Node.js installed ([nodejs.org](https://nodejs.org), LTS version)

## 1. Fork or clone this repo

Fork this repository to your own GitHub account (or clone it and push to a new repo of your own).

## 2. Supabase (database)

1. Go to [supabase.com](https://supabase.com) → **New Project**.
2. Set a project name and a strong database password (save it).
3. Once created, open **SQL Editor → New query**, paste the contents of `supabase/schema.sql`, and run it.
4. Go to **Project Settings → API** and copy: Project URL, `anon` public key, and `service_role` key.

## 3. Push notification keys (VAPID)

```
npx web-push generate-vapid-keys
```

Save the Public and Private keys shown.

## 4. GitHub Actions secrets

In your repo: **Settings → Secrets and variables → Actions → New repository secret**. Add:

| Name | Value |
|---|---|
| `SUPABASE_URL` | Project URL from step 2 |
| `SUPABASE_SERVICE_ROLE_KEY` | service_role key from step 2 |
| `VAPID_PRIVATE_KEY` | Private key from step 3 |
| `VAPID_CONTACT_EMAIL` | Your email address |

## 5. GitHub token (for the dashboard's action buttons)

1. **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
2. Scope it to this repository only, with **Actions: Read and write** permission.
3. Save the generated token — it's shown only once.

## 6. Deploy to Cloudflare Pages

1. [dash.cloudflare.com](https://dash.cloudflare.com) → **Workers & Pages → Create → Pages → Connect to Git**.
2. Select your repo. Build settings:
   - Framework preset: **Next.js (Static HTML Export)**
   - Build command: `npm run build`
   - Build output directory: `out`
   - Root directory: `frontend`
3. Add these environment variables:

| Variable | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase Project URL |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon key |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` | VAPID Public Key |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase service_role key |
| `GITHUB_OWNER` | Your GitHub username |
| `GITHUB_REPO` | Your repo name |
| `GITHUB_ACTIONS_TOKEN` | Token from step 5 |

4. **Save and Deploy**. You'll get a live URL in a couple of minutes.

## 7. Using it

- **Discover tab** — search a profession + location, review results, click **+** to start watching a business.
- **My Businesses tab** — see everything you're watching, hit **Check now** for an on-demand scan, view **Negative reviews** separately from all reviews.
- **Enable notifications** — click once to get push alerts for new negative reviews and for failed scan runs.

Automatic scanning runs on its own every 6 hours once deployed — nothing further to configure..
```
Live Link: https://reviewmonitor.pages.dev/
