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
import shutil
import signal
import sqlite3
import subprocess
import json
import threading
import time
import yaml
from concurrent.futures import ThreadPoolExecutor, wait, FIRST_COMPLETED
from datetime import datetime, timezone, timedelta
from db import get_client
from notify_push import notify_scan_failed
from job_status import start_job, update_progress, finish_job

SCRAPER_DIR = os.environ.get("SCRAPER_ENGINE_DIR", "./google-reviews-scraper-pro")

PER_BUSINESS_TIMEOUT_SECONDS = 90  # was 8 min - if a business isn't done in
# 90s (with a light ~10-review request), it's almost always Google
# rate-limiting/blocking the headless browser (no proxies configured), not
# something that finishing the wait would fix. A handful of businesses
# hitting the OLD 8-min cap was enough to burn 30-40+ minutes on their own -
# this was the single biggest cause of slow runs, not the review-checking
# logic itself.

# How many businesses get scraped AT ONCE. Deliberately conservative (not
# maxed out) - there are no proxies configured, so this is a genuine
# trade-off between speed and the risk of Google noticing/blocking the
# repeated pattern from one IP. gosom's own docs warn about exactly this
# with its own -c concurrency flag. Start here; can be tuned up or down
# based on how real runs behave (errors/timeouts creeping up = dial back).
SCAN_CONCURRENCY = 3

# Hard internal cap on the WHOLE run (discovery + scanning together, once
# job_start_time is threaded through from discover.py), checked between
# businesses. Never rely on GitHub Actions' own timeout-minutes to enforce
# a time limit - that just SIGKILLs the process with zero chance to save
# anything, which is exactly the "83 minutes then nothing" problem this
# fixes. This way a run always finishes cleanly and reports whatever it
# found so far, instead of running long or getting cut off mid-write.
TIME_BUDGET_SECONDS = 45 * 60

SCAN_WINDOW_DAYS = 90

# Set by the "Stop" button (cancel.js cancels the GitHub Actions run,
# which sends SIGTERM to this process) - checked between businesses so a
# stop always wraps up with partial results saved, never just dies
# mid-write and leaves the run stuck at "running" forever.
_stop_requested = False


def _handle_stop_signal(signum, _frame):
    global _stop_requested
    _stop_requested = True
    print(f"Received signal {signum} - finishing in-flight businesses, then stopping with partial results saved.")


signal.signal(signal.SIGTERM, _handle_stop_signal)
signal.signal(signal.SIGINT, _handle_stop_signal)


def _prepare_worker_dirs(n: int) -> list[str]:
    """The review-scraping engine uses a FIXED config.yaml/reviews.db path
    per directory - it was built assuming one business is scraped at a
    time. Running businesses concurrently against the SAME directory would
    mean worker A's config gets overwritten by worker B before A even
    reads it, and both workers' reviews would land in the same sqlite
    file with no reliable way to tell which review came from which
    business (see _read_reviews_from_sqlite's "most recent row" trick,
    which only works for exactly one business at a time).

    So each concurrent slot gets its OWN full copy of the already-cloned
    engine directory instead - slot 0 reuses the original clone (no copy
    needed), slots 1..n-1 are cheap filesystem copies of it (no re-clone,
    no re-pip-install, just files). This is what actually makes
    concurrent scanning safe rather than just fast."""
    worker_dirs = [SCRAPER_DIR]
    parent = os.path.dirname(os.path.abspath(SCRAPER_DIR)) or "."
    base_name = os.path.basename(os.path.abspath(SCRAPER_DIR))
    for i in range(1, n):
        worker_dir = os.path.join(parent, f"{base_name}_worker_{i}")
        if not os.path.isdir(worker_dir):
            shutil.copytree(SCRAPER_DIR, worker_dir)
        worker_dirs.append(worker_dir)
    return worker_dirs


def _write_config(business: dict, scraper_dir: str):
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
        # it'll be near the top. This only needs to be big enough to
        # answer "is there at least one negative" - it does NOT save any
        # time to stop early mid-scrape once one is found, because the
        # engine returns its whole batch in one shot (see the note on
        # scan_one_business below), so the real lever for speed is
        # keeping this number small in the first place.
        "max_reviews": 10,
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
    with open(os.path.join(scraper_dir, "config.yaml"), "w") as f:
        yaml.safe_dump(config, f)


def _run_scraper(scraper_dir: str):
    subprocess.run(
        ["python", "start.py", "-q"],
        cwd=scraper_dir,
        check=True,
        timeout=PER_BUSINESS_TIMEOUT_SECONDS,
    )


def _read_reviews_from_sqlite(business_id: str, scraper_dir: str) -> list[dict]:
    """
    Since each worker directory scrapes exactly one business at a time
    (that's the whole point of the per-worker isolation above), the
    most-recently inserted row in the engine's own `places` table is
    always the business that worker just scraped - this avoids depending
    on knowing the exact column name the engine uses for the source URL
    (which isn't documented and turned out not to be literally "url").
    """
    conn = sqlite3.connect(os.path.join(scraper_dir, "reviews.db"))
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


def scan_one_business(client, business: dict, scan_id: str, scraper_dir: str) -> dict:
    """Scrapes and syncs a single business using its own isolated
    scraper_dir (see _prepare_worker_dirs) - safe to call concurrently
    for different businesses as long as each call gets a distinct
    scraper_dir. Raises on scrape failure so the caller can move on to
    the next business.

    IMPORTANT limitation: _run_scraper() launches the review-scraping
    engine as a whole separate process (browser launch, page navigation,
    scrolling to load reviews) and only returns control once it's
    completely done - there's no way to peek at reviews as they're found
    and bail out mid-scrape the moment a negative shows up. The "stop
    after first negative" logic in _sync_reviews() only skips WRITING the
    rest of an already-fully-scraped batch to Supabase - it does not (and
    structurally can't, without patching the engine itself) shorten the
    scrape time for that business. The real levers for speed here are
    max_reviews (how much the engine has to scroll/load per business),
    PER_BUSINESS_TIMEOUT_SECONDS (how long a stuck/blocked business is
    allowed to hang before giving up on it), and SCAN_CONCURRENCY (how
    many businesses get scraped in parallel)."""
    _write_config(business, scraper_dir)
    _run_scraper(scraper_dir)
    reviews = _read_reviews_from_sqlite(business["id"], scraper_dir)
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
    job_start_time: float = None,
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
    steps, so there's no second row to create here.

    job_start_time: time.monotonic() captured at the very start of the
    WHOLE run (e.g. before gosom's own discovery phase in discover.py),
    not just when this function was called. The 25-minute budget below
    needs to cover total wall time for the run to reliably finish before
    GitHub Actions' own outer timeout hard-kills it (which saves nothing) -
    if this isn't passed, it falls back to timing from here instead."""
    client = get_client()
    total_new, total_negative, errors, skipped = 0, 0, 0, 0
    error_details = []
    stopped_early = False
    start_time = job_start_time if job_start_time is not None else time.monotonic()

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

    n_workers = max(1, min(SCAN_CONCURRENCY, len(business_list)))
    worker_dirs = _prepare_worker_dirs(n_workers)
    print(f"Scanning with {n_workers} concurrent worker(s) (SCAN_CONCURRENCY={SCAN_CONCURRENCY})")

    results_lock = threading.Lock()
    completed = 0

    def _scan_task(worker_index: int, biz: dict):
        scraper_dir = worker_dirs[worker_index % n_workers]
        try:
            result = scan_one_business(client, biz, scan_id, scraper_dir)
            return ("ok", biz["name"], result)
        except subprocess.TimeoutExpired:
            return ("timeout", biz["name"], None)
        except subprocess.CalledProcessError as e:
            return ("error", biz["name"], str(e))
        except Exception as e:
            # Catches everything else too (sqlite errors, yaml/file issues,
            # unexpected engine output, a flaky Supabase call, etc.) - a
            # single business failing here must NEVER be allowed to crash
            # the whole run and lose already-completed results. Previously
            # only the two subprocess-specific exceptions above were
            # caught; anything else propagated all the way up through
            # scan_many() and got the ENTIRE scrape_logs row marked
            # "failed" by discover.py's outer exception handler - even
            # when most of the batch (99 businesses, 2 real negatives in
            # one real run) had already succeeded and was safely synced.
            import traceback
            traceback.print_exc()
            return ("error", biz["name"], f"{type(e).__name__}: {e}")

    # Sliding window: keep up to n_workers businesses in flight at once.
    # Each time one finishes, immediately submit the next one (if the time
    # budget/stop flag still allow it) rather than waiting for the whole
    # batch to complete before starting more - keeps all workers busy.
    biz_iter = enumerate(business_list)
    pending = {}
    next_worker_slot = 0

    def _submit_next() -> bool:
        nonlocal next_worker_slot
        if _stop_requested or (time.monotonic() - start_time > TIME_BUDGET_SECONDS):
            return False
        try:
            _, biz = next(biz_iter)
        except StopIteration:
            return False
        future = executor.submit(_scan_task, next_worker_slot, biz)
        pending[future] = biz["name"]
        next_worker_slot += 1
        return True

    with ThreadPoolExecutor(max_workers=n_workers) as executor:
        for _ in range(n_workers):
            if not _submit_next():
                break

        while pending:
            done, _ = wait(pending.keys(), return_when=FIRST_COMPLETED)
            for done_future in done:
                biz_name = pending.pop(done_future)
                try:
                    status, name, result = done_future.result()
                except Exception as e:
                    # Belt-and-suspenders: _scan_task already catches
                    # everything internally, but if a future somehow still
                    # raises here (e.g. the executor itself misbehaving),
                    # this must still not take down the whole run.
                    status, name, result = "error", biz_name, f"{type(e).__name__}: {e}"
                    print(f"Unexpected error retrieving result for {biz_name}: {result}")
                completed += 1
                with results_lock:
                    if status == "ok":
                        total_new += result["new_reviews"]
                        total_negative += result["negative"]
                    elif status == "timeout":
                        errors += 1
                        reason = f"{name}: timeout timeout"
                    {PER_BUSINESS_TIMEOUT_SECONDS}s"
                        error_details.append(reason)
                        print(f"Timed out scraping {name} - skipping")
                    elif status == "error":
                        errors += 1
                        reason = f"{name}: {result}"
                        error_details.append(reason)
                        print(f"Failed scraping {name}: {result}")
                try:
                    update_progress(completed, name)
                except Exception as e:
                    print(f"Failed to update job status: {e}")
                print(f"--- Completed {completed}/{len(business_list)}: {biz_name} ({status}) ---")

                _submit_next()

    skipped = len(business_list) - completed
    stopped_early = skipped > 0
    if stopped_early:
        reason = "Stop button pressed" if _stop_requested else f"hit the {TIME_BUDGET_SECONDS // 60}-minute time budget"
        print(f"{reason} after {completed} business(es) - wrapping up with results found so far, not discarding them.")

    if stopped_early:
    status = "partial"

       if _stop_requested:
        error_message = (
            f"Stopped by user after {completed}/{len(business_list)} businesses."
           )
       else:
        error_message = (
            f"Time budget reached after {completed}/{len(business_list)} businesses. "
            f"{skipped} business(es) were not scanned."
           )

       if error_details:
        error_message += " Errors: " + " | ".join(error_details)

    elif errors == 0:
        status = "success"
        error_message = None

    elif total_new or total_negative:
        status = "partial"
        error_message = (
            f"{errors} business scan(s) failed. "
            f"Completed {completed}/{len(business_list)}."
        )

        if error_details:
            error_message += " " + " | ".join(error_details)

    else:
        status = "failed"
        error_message = (
            f"{errors} business scan(s) failed. "
            + " | ".join(error_details)
        )

    client.table("scrape_logs").update({
        "new_reviews_found": total_new,
        "negative_reviews_found": 
    total_negative,
        "status": status,
        "error_message": error_message,
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
