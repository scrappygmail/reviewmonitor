# Review Watch

**Automated Google Maps reputation monitoring — surfaces new 1–3★ reviews across dozens of business listings and pushes an alert before they become a problem.**

Built for local service businesses and agencies that need to know about a negative review within hours, not whenever someone happens to check manually.

## Features

- Keyword + location discovery for Google Maps businesses
- Incremental review monitoring — new reviews are diffed against history, nothing is re-processed
- Negative-review filtering (1–3★ only) with instant push alerts
- Rotating full-sweep scanning across every discovered business, not just the active watch list
- Native browser/PWA push notifications, including alerts when a scan run itself fails
- Automatic 90-day data retention
- Zero-login, single-tenant dashboard — built for a focused operator workflow, not generic multi-account SaaS

## Tech stack

**Frontend:** Next.js (static export), TypeScript, Tailwind, deployed on Cloudflare Pages
**Backend:** Python, orchestrated through scheduled/on-demand GitHub Actions — no server to maintain
**Edge functions:** Cloudflare Pages Functions (handles the write-side API without a Node.js runtime)
**Data:** Supabase (Postgres), with row-level security restricting the public client key to read-only
**Notifications:** Web Push (VAPID) — no third-party notification service
**Scraping:** Headless browser automation with anti-detection handling; discovery runs in a containerized engine

## How it works

```
Discover (on-demand)      →  businesses table  →  user selects which to watch
                                                          ↓
Scheduled scan (6h)       →  new reviews diffed →  1-3★ ones trigger a push alert
Rotation sweep (2x/day)   →  covers the full discovered list over time, oldest-scanned first
Daily cleanup             →  reviews older than 90 days purged
```

Every run — successful or failed — is logged with type, count, and status, so failures surface in the dashboard rather than only in CI logs.

## Engineering notes

A few constraints shaped the design:

- **Zero ongoing infrastructure cost.** Everything runs on free tiers (Cloudflare Pages, Supabase, GitHub Actions, Web Push), which ruled out a persistent server or paid scraping APIs — the scan/notification pipeline is entirely event- and schedule-driven.
- **Google Maps has an unofficial ~100–120 result cap per search**, so bulk discovery is done by splitting one keyword across multiple location queries rather than assuming a single search returns everything.
- **Scanning hundreds of businesses on a fixed schedule doesn't scale linearly** — a full sweep of a large discovered list is batched and rotated (oldest-scanned-first) instead of attempting all of them every run, to stay inside both GitHub Actions' job time limit and a sane request rate against Google.
- **No login, but not wide open.** Since there's no auth layer, the public (browser-exposed) Supabase key is restricted via row-level security to read-only — all writes go through Cloudflare Pages Functions using a server-side key that never reaches the client.

## Setup

See `Review-Watch-Setup-Guide.docx` for a full step-by-step deployment walkthrough (Supabase, GitHub Actions secrets, Cloudflare Pages) — no prior DevOps experience required.

## Notes

No business data lives in this repository — everything is stored in Supabase, provisioned separately per deployment, so the codebase itself stays reusable across clients.
