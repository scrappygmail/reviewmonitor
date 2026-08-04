"""
Real integration with gosom/google-maps-scraper.

Important: this tool is distributed as a Docker image (Go binary), NOT a
Python package — GitHub Actions' ubuntu-latest runners have Docker
pre-installed, so we shell out to `docker run` exactly as documented in
their README, then parse the results.csv it writes.

NOTE ON CSV COLUMNS: gosom's README examples don't show the exact CSV
header names in text form. The parsing below tries a few likely aliases
(title/name, link/url, place_id/cid, rating/review_rating). On the very
first real run, check the printed header (this script prints it) and
adjust COLUMN ALIASES below if any field comes back empty — a 2-minute
fix, not a redesign.
"""
import argparse
import csv
import os
import subprocess
import sys
import tempfile
from datetime import datetime, timezone
from db import get_client
from notify_push import notify_scan_failed
from job_status import start_job, update_progress, finish_job

COLUMN_ALIASES = {
    "name": ["title", "name"],
    "google_maps_url": ["link", "google_maps_url", "url"],
    "place_id": ["place_id", "cid", "input_id"],
    "address": ["address", "complete_address", "full_address"],
    "rating": ["review_rating", "rating"],
}


def _first_present(row: dict, keys: list[str]):
    for k in keys:
        if k in row and row[k]:
            return row[k]
    return None


def _to_float(v):
    try:
        return float(v) if v not in (None, "") else None
    except ValueError:
        return None


def run_gosom_search(keyword: str, city: str) -> list[dict]:
    query = f"{keyword} {city}"

    with tempfile.TemporaryDirectory() as tmp:
        queries_path = os.path.join(tmp, "queries.txt")
        results_path = os.path.join(tmp, "results.csv")
        with open(queries_path, "w") as f:
            f.write(query + "\n")
        open(results_path, "w").close()  # docker needs the file to exist to bind-mount it

        subprocess.run(
            [
                "docker", "run", "--rm",
                "-v", f"{queries_path}:/queries.txt:ro",
                "-v", f"{results_path}:/results.csv",
                "gosom/google-maps-scraper",
                "-input", "/queries.txt",
                "-results", "/results.csv",
                # depth = how many times it scrolls the results list to load
                # more listings (engine default is 10; 20 gets a fuller list
                # per keyword+city search without taking too long).
                "-depth", "30",
                "-exit-on-inactivity", "3m",
            ],
            check=True,
            timeout=60 * 20,
        )

        results = []
        with open(results_path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            if reader.fieldnames:
                print(f"gosom CSV columns: {reader.fieldnames}", file=sys.stderr)
            for row in reader:
                results.append({
                    "name": _first_present(row, COLUMN_ALIASES["name"]),
                    "google_maps_url": _first_present(row, COLUMN_ALIASES["google_maps_url"]),
                    "place_id": _first_present(row, COLUMN_ALIASES["place_id"]),
                    "address": _first_present(row, COLUMN_ALIASES["address"]),
                    "rating": _to_float(_first_present(row, COLUMN_ALIASES["rating"])),
                })
        return [r for r in results if r["google_maps_url"]]


def save_results(keyword: str, city: str, results: list[dict]) -> int:
    client = get_client()
    saved = 0
    for r in results:
        row = {
            "name": r.get("name") or "Unknown",
            "google_maps_url": r["google_maps_url"],
            "place_id": r.get("place_id"),
            "address": r.get("address"),
            "rating": r.get("rating"),
            "keyword": keyword,
            "city": city,
            "monitored": False,
        }
        if row["place_id"]:
            client.table("businesses").upsert(row, on_conflict="place_id").execute()
        else:
            # no place_id parsed - fall back to url-based dedup check
            existing = client.table("businesses").select("id").eq("google_maps_url", row["google_maps_url"]).execute()
            if not existing.data:
                client.table("businesses").insert(row).execute()
        saved += 1
    return saved


def log_run(keyword: str, count: int, status: str = "success", error: str = None):
    client = get_client()
    client.table("scrape_logs").insert({
        "run_type": "discover",
        "keyword": keyword,
        "businesses_scanned": count,
        "status": status,
        "error_message": error,
        "ran_at": datetime.now(timezone.utc).isoformat(),
    }).execute()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--keyword", required=True)
    parser.add_argument("--city", required=True)
    args = parser.parse_args()

    try:
        start_job("discover", total_count=0)
        update_progress(0, f"Searching '{args.keyword}' in '{args.city}'…")
    except Exception as e:
        print(f"Failed to start job status tracking: {e}")

    try:
        results = run_gosom_search(args.keyword, args.city)
        count = save_results(args.keyword, args.city, results)
        log_run(args.keyword, count)
        print(f"Discovery done: {count} businesses saved for '{args.keyword}' in '{args.city}'")
        try:
            finish_job("done")
        except Exception as e:
            print(f"Failed to finish job status tracking: {e}")
    except Exception as e:
        log_run(args.keyword, 0, status="failed", error=str(e))
        try:
            finish_job("failed")
        except Exception as job_err:
            print(f"Failed to finish job status tracking: {job_err}")
        try:
            notify_scan_failed("discover", str(e))
        except Exception as push_err:
            print(f"Failed to send failure push notification: {push_err}")
        print(f"Discovery failed: {e}", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
