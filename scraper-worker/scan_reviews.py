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
import sqlite3
import subprocess
import json
import yaml
from datetime import datetime, timezone, timedelta
from db import get_client
from notify_push import notify_scan_failed
from job_status import start_job, update_progress, finish_job

SCRAPER_DIR = os.environ.get("SCRAPER_ENGINE_DIR", "./google-reviews-scraper-pro")
CONFIG_PATH = os.path.join(SCRAPER_DIR, "config.yaml")
DB_PATH = os.path.join(SCRAPER_DIR, "reviews.db")

PER_BUSINESS_TIMEOUT_SECONDS = 8 * 60  # a single stuck business can't eat the whole job


def _write_config(business: dict):
    ninety_days_ago = (datetime.now(timezone.utc) - timedelta(days=90)).strftime("%Y-%m-%d")

    config = {
        "headless": True,
        "sort_by": "newest",
        "scrape_mode": "new_only",
        "db_path": "reviews.db",
        "backup_to_json": False,
        "download_images": False,
        "use_mongodb": False,
        "log_level": "INFO",
        "max_reviews": 100,
        "date_filter": {
            "after": ninety_days_ago,
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
    with a later run's id. Returns (new_count, negative_count)."""
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


def scan_many(business_list: list[dict], run_type: str, keyword: str = None) -> dict:
    """Scans a list of businesses ONE AT A TIME, syncing each to Supabase
    immediately - a timeout or crash partway through never loses already-
    completed businesses. Creates the scrape_logs row up front so every
    review can be tagged with this session's id, then updates that same
    row with final counts/status once done."""
    client = get_client()
    total_new, total_negative, errors = 0, 0, 0

    log_row = client.table("scrape_logs").insert({
        "run_type": run_type,
        "keyword": keyword,
        "businesses_scanned": len(business_list),
        "status": "running",
        "ran_at": datetime.now(timezone.utc).isoformat(),
    }).execute()
    scan_id = log_row.data[0]["id"]

    try:
        start_job(run_type, total_count=len(business_list))
    except Exception as e:
        print(f"Failed to start job status tracking: {e}")

    for i, biz in enumerate(business_list, start=1):
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

    status = "success" if errors == 0 else ("partial" if total_new or total_negative else "failed")

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

    return {"scanned": len(business_list), "new_reviews": total_new,
            "negative": total_negative, "errors": errors}
