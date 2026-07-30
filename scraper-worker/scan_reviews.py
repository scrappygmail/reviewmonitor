"""
Real integration with georgekhananaev/google-reviews-scraper-pro.

How this works (matches their documented CLI/config exactly — their
anti-detection SeleniumBase UC-mode internals are never touched, only
driven via config.yaml + `python start.py`, same as their README):

  1. Write a config.yaml listing every business to scan this run
     (scrape_mode: new_only — their own incremental engine decides
     what's actually new).
  2. Run `python start.py -q` as a subprocess inside the cloned
     engine directory (cloned by the GitHub Actions workflow —
     see .github/workflows/*.yml).
  3. Read their own reviews.db (SQLite) afterwards and map rows back
     to our Supabase business_id via the scraped URL.
  4. Diff against what's already in our Supabase `reviews` table to
     know what's genuinely new, then upsert + count negatives.

SCRAPER_ENGINE_DIR must point at the cloned
google-reviews-scraper-pro folder (the workflow clones it next to
this script and sets that env var).
"""
import os
import sqlite3
import subprocess
import json
import yaml
from datetime import datetime, timezone
from db import get_client
from notify_push import notify_scan_failed

SCRAPER_DIR = os.environ.get("SCRAPER_ENGINE_DIR", "./google-reviews-scraper-pro")
CONFIG_PATH = os.path.join(SCRAPER_DIR, "config.yaml")
DB_PATH = os.path.join(SCRAPER_DIR, "reviews.db")


def _write_config(businesses: list[dict]):
    config = {
        "headless": True,
        "sort_by": "newest",
        "scrape_mode": "new_only",
        "db_path": "reviews.db",
        "backup_to_json": False,
        "download_images": False,
        "log_level": "INFO",
        "resilience": {
            "retry_on_session_death": 1,
            "retry_backoff_base_seconds": 3,
            "rate_limit_cooldown_seconds": 60,
        },
        "businesses": [
            {"url": b["google_maps_url"], "custom_params": {"company": b["name"]}}
            for b in businesses
        ],
    }
    with open(CONFIG_PATH, "w") as f:
        yaml.safe_dump(config, f)


def _run_scraper():
    subprocess.run(
        ["python", "start.py", "-q"],
        cwd=SCRAPER_DIR,
        check=True,
        timeout=60 * 60 * 5,  # 5h safety cap - matches the Actions job timeout
    )


def _read_reviews_from_sqlite(url_to_business_id: dict) -> list[dict]:
    """Reads every review row from the engine's own reviews.db (per its
    documented schema: places, reviews, review_history, scrape_sessions)
    and maps each one back to our Supabase business_id via the scraped URL."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    cur.execute("SELECT place_id, url FROM places")
    place_to_url = {row["place_id"]: row["url"] for row in cur.fetchall()}

    cur.execute("SELECT * FROM reviews")
    rows = cur.fetchall()
    conn.close()

    results = []
    for row in rows:
        url = place_to_url.get(row["place_id"])
        business_id = url_to_business_id.get(url)
        if not business_id:
            continue

        # `description` is stored as a JSON object keyed by language code
        # (per README's documented review payload) - prefer English.
        text = ""
        try:
            desc = json.loads(row["description"]) if row["description"] else {}
            text = desc.get("en") or next(iter(desc.values()), "")
        except Exception:
            text = row["description"] or ""

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


def scan_batch(businesses: list[dict]) -> list[dict]:
    """Runs the scraper once for the whole batch (its own multi-business
    mode), returns every review row found, mapped to our business_id."""
    if not businesses:
        return []
    _write_config(businesses)
    _run_scraper()
    url_to_id = {b["google_maps_url"]: b["id"] for b in businesses}
    return _read_reviews_from_sqlite(url_to_id)


def scan_many(business_list: list[dict], run_type: str, keyword: str = None) -> dict:
    """Scans a batch of businesses, syncs genuinely-new reviews into
    Supabase, updates last_scanned_at, logs the run, returns totals."""
    client = get_client()

    try:
        all_reviews = scan_batch(business_list)
    except subprocess.CalledProcessError as e:
        client.table("scrape_logs").insert({
            "run_type": run_type, "keyword": keyword,
            "businesses_scanned": len(business_list),
            "status": "failed", "error_message": str(e),
            "ran_at": datetime.now(timezone.utc).isoformat(),
        }).execute()
        try:
            notify_scan_failed(run_type, str(e))
        except Exception as push_err:
            print(f"Failed to send failure push notification: {push_err}")
        return {"scanned": len(business_list), "new_reviews": 0, "negative": 0, "errors": 1}

    total_new, total_negative = 0, 0

    for r in all_reviews:
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
            total_new += 1
            if r["rating"] <= 3:
                total_negative += 1

    now = datetime.now(timezone.utc).isoformat()
    for b in business_list:
        client.table("businesses").update({"last_scanned_at": now}).eq("id", b["id"]).execute()

    client.table("scrape_logs").insert({
        "run_type": run_type,
        "keyword": keyword,
        "businesses_scanned": len(business_list),
        "new_reviews_found": total_new,
        "negative_reviews_found": total_negative,
        "status": "success",
        "ran_at": now,
    }).execute()

    return {"scanned": len(business_list), "new_reviews": total_new,
            "negative": total_negative, "errors": 0}
