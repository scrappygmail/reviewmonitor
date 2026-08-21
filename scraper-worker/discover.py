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
import json
import os
import re
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
    "phone": ["phone"],
    "email": ["emails", "email"],
}


_EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")


def _clean_email(v):
    """gosom's -email flag returns an 'emails' column that can hold more
    than one address (format not documented) - split on common
    separators and take the first one that actually looks like an email,
    rather than storing whatever raw punctuation-joined string comes
    back."""
    if not v:
        return None
    for piece in re.split(r"[,;\s]+", v.strip()):
        match = _EMAIL_RE.fullmatch(piece.strip().strip(".,;"))
        if match:
            return match.group(0)
    # fallback: pull the first email-looking substring out of the raw text
    match = _EMAIL_RE.search(v)
    return match.group(0) if match else None


def _clean_address(v):
    """gosom sometimes puts a structured column (complete_address /
    full_address) that comes back as a JSON object string like
    '{"borough":"","street":"","city":"","postal_code":"","state":"",
    "country":""}' instead of plain text - that's non-empty as a string
    even when every field inside it is blank, so it was winning over the
    real (empty) "address" column and showing up as garbage on the
    dashboard. Turn it into a readable address, or drop it if there's
    nothing usable inside."""
    if not v:
        return v
    stripped = v.strip()
    if stripped.startswith("{") and stripped.endswith("}"):
        try:
            parts = json.loads(stripped)
        except (ValueError, TypeError):
            return None
        ordered_keys = ["street", "borough", "city", "state", "postal_code", "country"]
        pieces = [str(parts[k]).strip() for k in ordered_keys if parts.get(k)]
        return ", ".join(pieces) if pieces else None
    return v


def _first_present(row: dict, keys: list[str], transform=None):
    for k in keys:
        if k in row and row[k]:
            value = transform(row[k]) if transform else row[k]
            if value:
                return value
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
                # more listings (engine default is 10; 30 gets a fuller list
                # per keyword+city search without taking too long).
                "-depth", "30",
                # visits each business's website looking for a contact email -
                # gosom's own docs warn this "increases processing time
                # significantly", which is why the timeout below and the
                # workflow's timeout-minutes were both bumped up to match.
                "-email",
                "-exit-on-inactivity", "3m",
            ],
            check=True,
            timeout=60 * 50,
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
                    "address": _first_present(row, COLUMN_ALIASES["address"], transform=_clean_address),
                    "rating": _to_float(_first_present(row, COLUMN_ALIASES["rating"])),
                    "phone": _first_present(row, COLUMN_ALIASES["phone"]),
                    "email": _first_present(row, COLUMN_ALIASES["email"], transform=_clean_email),
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
            "phone": r.get("phone"),
            "email": r.get("email"),
            "keyword": keyword,
            "city": city,
            # NOTE: "monitored" is intentionally NOT included here. Supabase's
            # upsert only touches the columns present in the payload on a
            # conflict, so omitting it means re-discovering a business
            # someone already added to their watch list won't silently
            # un-monitor it. New rows still default to false via the
            # column's schema default.
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


def log_run(keyword: str, city: str, count: int, status: str = "success", error: str = None):
    client = get_client()
    client.table("scrape_logs").insert({
        "run_type": "discover",
        "keyword": keyword,
        "city": city,
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
        log_run(args.keyword, args.city, count)
        print(f"Discovery done: {count} businesses saved for '{args.keyword}' in '{args.city}'")
        try:
            finish_job("done")
        except Exception as e:
            print(f"Failed to finish job status tracking: {e}")
    except Exception as e:
        log_run(args.keyword, args.city, 0, status="failed", error=str(e))
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
