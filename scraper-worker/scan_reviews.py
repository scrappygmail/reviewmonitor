"""
Review-scanning engine, per-business (not batched).

Key changes from the earlier batched version:
  - Each business is scraped and synced to Supabase ONE AT A TIME. If the
    workflow times out or gets cancelled partway through a list of
    businesses, everything scraped BEFORE that point is already saved -
    nothing is lost.
  - MongoDB sync is explicitly disabled (use_mongodb: false). The engine
    was defaulting to attempting a MongoDB connection regardless, wasting
    ~30s per business on a connection timeout we never needed.
  - max_reviews + date_filter (early_stop, last 90 days) cap how much a
    single business scrapes. We only care about recent reviews (matches
    our own 90-day retention), not a business's entire review history -
    scraping hundreds of old reviews on every run was the main cause of
    multi-hour runs.

Still true from before: this only DRIVES the engine via config.yaml +
its own `python start.py` CLI - none of its internals are touched.
"""
import os
import sqlite3
import subprocess
import json
import yaml
from datetime import datetime, timezone, timedelta
from db import get_client
from notify_push import notify_scan_failed

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
            review_text = json.loads(row["review_text"]) if row["review_text"] else {}
            text = review_text.get("en") or next(iter(review_text.values()), "")
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


def _sync_reviews(client, reviews: list[dict]) -> tuple[int, int]:
    """Upserts reviews into Supabase, returns (new_count, negative_count)."""
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
        is_new = len(existing.data) == 0

        client.table("reviews").upsert(
            {
                "business_id": r["business_id"],
                "review_id": r["review_id"],
                "author": r["author"],
                "rating": r["rating"],
                "review_text": r["review_text"],
                "review_date": r["review_date"],
            },
            on_conflict="business_id,review_id",
        ).execute()

        if is_new:
            new_count += 1
            if r["rating"] <= 3:
                negative_count += 1
    return new_count, negative_count


def scan_one_business(client, business: dict) -> dict:
    """Scrapes and syncs a single business. Raises on scrape failure so the
    caller can log it and move on to the next business."""
    _write_config(business)
    _run_scraper()
    reviews = _read_reviews_from_sqlite(business["id"])
    new_count, negative_count = _sync_reviews(client, reviews)

    client.table("businesses").update({
        "last_scanned_at": datetime.now(timezone.utc).isoformat()
    }).eq("id", business["id"]).execute()

    return {"new_reviews": new_count, "negative": negative_count}


def scan_many(business_list: list[dict], run_type: str, keyword: str = None) -> dict:
    """Scans a list of businesses ONE AT A TIME, syncing each to Supabase
    immediately - a timeout or crash partway through never loses already-
    completed businesses. Logs the overall run and returns totals."""
    client = get_client()
    total_new, total_negative, errors = 0, 0, 0

    for i, biz in enumerate(business_list, start=1):
        print(f"--- Scanning {i}/{len(business_list)}: {biz['name']} ---")
        try:
            result = scan_one_business(client, biz)
            total_new += result["new_reviews"]
            total_negative += result["negative"]
        except subprocess.TimeoutExpired:
            errors += 1
            print(f"Timed out scraping {biz['name']} - skipping, moving to next business")
        except subprocess.CalledProcessError as e:
            errors += 1
            print(f"Failed scraping {biz['name']}: {e}")

    now = datetime.now(timezone.utc).isoformat()
    status = "success" if errors == 0 else ("partial" if total_new or total_negative else "failed")

    client.table("scrape_logs").insert({
        "run_type": run_type,
        "keyword": keyword,
        "businesses_scanned": len(business_list),
        "new_reviews_found": total_new,
        "negative_reviews_found": total_negative,
        "status": status,
        "ran_at": now,
    }).execute()

    if status == "failed":
        try:
            notify_scan_failed(run_type, f"All {len(business_list)} businesses failed to scan")
        except Exception as push_err:
            print(f"Failed to send failure push notification: {push_err}")

    return {"scanned": len(business_list), "new_reviews": total_new,
            "negative": total_negative, "errors": errors}
  
