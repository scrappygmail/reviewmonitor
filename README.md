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
Discover (on-demand)      →  businesses table  →  choose which to watch
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

A few small additions on top of the original build:

- **Per-run CSV export.** Every scan/discover run in "Recent activity" now has a ⬇ button — one click gets you a CSV of just that run's negative reviews (business, address, rating, review text, author, date, Maps link). Generated client-side, no extra backend needed.
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
