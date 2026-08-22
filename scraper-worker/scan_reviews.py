"""
Review-scanning engine, per-business (not batched).

Session tracking: the scrape_logs row for this run is created UP FRONT
(before scanning starts) instead of at the end, so its id is known while
syncing reviews - every review gets tagged with scan_id, letting the
dashboard show "this session's results" grouped by run instead of
everything mixed together. The row is then updated (not re-inserted) once
the run finishes with final counts/status.

Other behaviour carried over from before:
  - Each business is scraped and synced to Supabase ONE AT A TIME. If the
    workflow times out or gets cancelled partway through a list of
    businesses, everything scraped BEFORE that point is already saved.
  - MongoDB sync is explicitly disabled (use_mongodb: false).
  - max_reviews + date_filter (early_stop, last 90 days) cap how much a
    single business scrapes.

This only DRIVES the engine via config.yaml + its own `python start.py`
CLI - none of its internals are touched.
"""
import os
import signal
import sqlite3
import subprocess
import json
import time
import yaml
from datetime import datetime, timezone, timedelta
from db import get_client
from notify_push import notify_scan_failed
from job_status import start_job, update_progress, finish_job

SCRAPER_DIR = os.environ.get("SCRAPER_ENGINE_DIR", "./google-reviews-scraper-pro")
CONFIG_PATH = os.path.join(SCRAPER_DIR, "config.yaml")
DB_PATH = os.path.join(SCRAPER_DIR, "reviews.db")

PER_BUSINESS_TIMEOUT_SECONDS = 8 * 60  # a single stuck business can't eat the whole job

# Hard internal cap on the WHOLE scan_many() run, checked between
# businesses. Never rely on GitHub Actions' own timeout-minutes to enforce
# a time limit - that just SIGKILLs the process with zero chance to save
# anything, which is exactly the "83 minutes then nothing" problem this
# fixes. This way a run always finishes cleanly and reports whatever it
# found so far, instead of running long or getting cut off mid-write.
TIME_BUDGET_SECONDS = 25 * 60

SCAN_WINDOW_DAYS = 90

# Set by the "Stop" button (cancel.js cancels the GitHub Actions run,
# which sends SIGTERM to this process) - checked between businesses so a
# stop always wraps up with partial results saved, never just dies
# mid-write and leaves the run stuck at "running" forever.
_stop_requested = False


def _handle_stop_signal(signum, _frame):
    global _stop_requested
    _stop_requested = True
    print(f"Received signal {signum} - finishing the current business, then stopping with partial results saved.")


signal.signal(signal.SIGTERM, _handle_stop_signal)
signal.signal(signal.SIGINT, _handle_stop_signal)


def _write_config(business: dict):
    window_start = (datetime.now(timezone.utc) - timedelta(days=SCAN_WINDOW_DAYS)).strftime("%Y-%m-%d")

    config = {
        "headless": True,
        "sort_by": "newest",
        "scrape_mode": "new_only",
        "db_path": "reviews.db",
        "backup_to_json": False,
        "download_images": False,
        "use_mongodb": False,
        "log_level": "INFO",
        # Reviews are sorted newest-first with early_stop past the 90-day
        # window below, so if a business has any recent negative review
        # it'll be near the top - 20 is plenty to catch it without paying
        # for up to 100 reviews per business when we only need to know
        # "is there at least one negative", not a full history.
        "max_reviews": 20,
        "date_filter": {
            "after": window_start,
            "mode": "early_stop",
        },
        "resilience": {
            "retry_on_session_death": 1,
            "retry_backoff_base_seconds": 3,
            "rate_limit_cooldown_seconds": 60,
        },
        "businesses": [
            {"url": business["google_maps_url"], "custom_params": {"company": business["name"]}}
        ],
    }
    with open(CONFIG_PATH, "w") as f:
        yaml.safe_dump(config, f)


def _run_scraper():
    subprocess.run(
        ["python", "start.py", "-q"],
        cwd=SCRAPER_DIR,
        check=True,
        timeout=PER_BUSINESS_TIMEOUT_SECONDS,
    )


def _read_reviews_from_sqlite(business_id: str) -> list[dict]:
    """
    Since we scrape exactly one business per call, the most-recently
    inserted row in the engine's own `places` table is always the
    business we just scraped - this avoids depending on knowing the
    exact column name the engine uses for the source URL (which isn't
    documented and turned out not to be literally "url").
    """
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    cur.execute("SELECT place_id FROM places ORDER BY rowid DESC LIMIT 1")
    row = cur.fetchone()
    if not row:
        conn.close()
        return []
    place_id = row["place_id"]

    cur.execute("SELECT * FROM reviews WHERE place_id = ?", (place_id,))
    rows = cur.fetchall()
    conn.close()

    results = []
    for row in rows:
        text = ""
        try:
            review_text_json = json.loads(row["review_text"]) if row["review_text"] else {}
            text = review_text_json.get("en") or next(iter(review_text_json.values()), "")
        except Exception:
            text = row["review_text"] or ""

        rating = row["rating"]
        results.append({
            "business_id": business_id,
            "review_id": row["review_id"],
            "author": row["author"],
            "rating": int(round(rating)) if rating is not None else None,
            "review_text": text,
            "review_date": row["review_date"],
        })
    return results


def _sync_reviews(client, reviews: list[dict], scan_id: str) -> tuple[int, int]:
    """Inserts genuinely new reviews into Supabase, tagged with the
    session (scan_id) that found them. Already-known reviews are left
    untouched entirely - no write, no overwriting their original scan_id
    with a later run's id.

    Stops as soon as ONE new negative review has been synced for this
    business - one negative is enough to flag it as a lead, no need to
    keep writing the rest of its (already-fetched) reviews. Returns
    (new_count, negative_count)."""
    new_count, negative_count = 0, 0
    for r in reviews:
        if r["rating"] is None:
            continue

        existing = (
            client.table("reviews")
            .select("id")
            .eq("business_id", r["business_id"])
            .eq("review_id", r["review_id"])
            .execute()
        )
        if existing.data:
            continue  # already known - nothing to do, keep its original scan_id

        client.table("reviews").insert({
            "business_id": r["business_id"],
            "review_id": r["review_id"],
            "author": r["author"],
            "rating": r["rating"],
            "review_text": r["review_text"],
            "review_date": r["review_date"],
            "scan_id": scan_id,
        }).execute()

        new_count += 1
        if r["rating"] <= 3:
            negative_count += 1
            break  # got this business's lead - move on to the next business
    return new_count, negative_count


def scan_one_business(client, business: dict, scan_id: str) -> dict:
    """Scrapes and syncs a single business. Raises on scrape failure so the
    caller can log it and move on to the next business."""
    _write_config(business)
    _run_scraper()
    reviews = _read_reviews_from_sqlite(business["id"])
    new_count, negative_count = _sync_reviews(client, reviews, scan_id)

    client.table("businesses").update({
        "last_scanned_at": datetime.now(timezone.utc).isoformat()
    }).eq("id", business["id"]).execute()

    return {"new_reviews": new_count, "negative": negative_count}


def scan_many(
    business_list: list[dict],
    run_type: str,
    keyword: str = None,
    city: str = None,
    existing_scan_id: str = None,
) -> dict:
    """Scans a list of businesses ONE AT A TIME, syncing each to Supabase
    immediately - a timeout or crash partway through never loses already-
    completed businesses. Creates the scrape_logs row up front so every
    review can be tagged with this session's id, then updates that same
    row with final counts/status once done.

    existing_scan_id: pass this when the caller (discover.py) already
    created the scrape_logs row itself - e.g. discovery finding
    businesses and then immediately scanning their reviews now happens
    as ONE combined run/one activity entry instead of two separate
    steps, so there's no second row to create here."""
    client = get_client()
    total_new, total_negative, errors, skipped = 0, 0, 0, 0
    stopped_early = False
    start_time = time.monotonic()

    if existing_scan_id:
        scan_id = existing_scan_id
    else:
        log_payload = {
            "run_type": run_type,
            "keyword": keyword,
            "city": city,
            "businesses_scanned": len(business_list),
            "status": "running",
            "ran_at": datetime.now(timezone.utc).isoformat(),
        }
        try:
            log_row = client.table("scrape_logs").insert(log_payload).execute()
        except Exception as exc:
            # If the migration that added scrape_logs.city was run recently,
            # Supabase's PostgREST schema cache can take a while to notice the
            # new column (it doesn't always refresh instantly on ALTER TABLE).
            # Without this fallback, EVERY scan died right here before
            # scanning business #1 - which is why "0 negative reviews" was
            # showing up across every single search after that migration,
            # not because of anything wrong with the scanning logic itself.
            if "PGRST204" not in str(exc) or "city" not in str(exc):
                raise
            log_payload.pop("city", None)
            log_row = client.table("scrape_logs").insert(log_payload).execute()
        scan_id = log_row.data[0]["id"]

    try:
        start_job(run_type, total_count=len(business_list))
    except Exception as e:
        print(f"Failed to start job status tracking: {e}")

    for i, biz in enumerate(business_list, start=1):
        if _stop_requested:
            print("Stop button pressed - wrapping up now with results found so far, not discarding them.")
            stopped_early = True
            skipped = len(business_list) - i + 1
            break
        if time.monotonic() - start_time > TIME_BUDGET_SECONDS:
            print(
                f"Hit the {TIME_BUDGET_SECONDS // 60}-minute time budget after {i - 1} business(es) - "
                f"wrapping up with results found so far instead of running long."
            )
            stopped_early = True
            skipped = len(business_list) - i + 1
            break

        print(f"--- Scanning {i}/{len(business_list)}: {biz['name']} ---")
        try:
            update_progress(i, biz["name"])
        except Exception as e:
            print(f"Failed to update job status: {e}")
        try:
            result = scan_one_business(client, biz, scan_id)
            total_new += result["new_reviews"]
            total_negative += result["negative"]
        except subprocess.TimeoutExpired:
            errors += 1
            print(f"Timed out scraping {biz['name']} - skipping, moving to next business")
        except subprocess.CalledProcessError as e:
            errors += 1
            print(f"Failed scraping {biz['name']}: {e}")

    if stopped_early:
        status = "partial"
    elif errors == 0:
        status = "success"
    elif total_new or total_negative:
        status = "partial"
    else:
        status = "failed"

    client.table("scrape_logs").update({
        "new_reviews_found": total_new,
        "negative_reviews_found": total_negative,
        "status": status,
    }).eq("id", scan_id).execute()

    try:
        finish_job("failed" if status == "failed" else "done")
    except Exception as e:
        print(f"Failed to finish job status tracking: {e}")

    if status == "failed":
        try:
            notify_scan_failed(run_type, f"All {len(business_list)} businesses failed to scan")
        except Exception as push_err:
            print(f"Failed to send failure push notification: {push_err}")

    return {
        "scanned": len(business_list) - skipped,
        "skipped": skipped,
        "new_reviews": total_new,
        "negative": total_negative,
        "errors": errors,
        "scan_id": scan_id,
        "stopped_early": stopped_early,
    }
