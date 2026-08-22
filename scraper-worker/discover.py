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
from notify_push import notify_scan_failed, notify_new_negative_reviews
from job_status import start_job, update_progress, finish_job
from scan_reviews import scan_many

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


# ---------------------------------------------------------------------------
# Location validation: gosom's search is free-text, not a geographic
# boundary. A "Rome" search can (and did) come back with businesses
# actually in Rome NY, Rome GA, or nowhere near any Rome at all - so every
# result gets checked against the requested city/state/country before
# being saved. For ambiguous city names, pass "City, State" or
# "City, State, Country" and it'll be enforced too.
# ---------------------------------------------------------------------------

US_STATES = {
    "alabama": "al", "alaska": "ak", "arizona": "az", "arkansas": "ar",
    "california": "ca", "colorado": "co", "connecticut": "ct", "delaware": "de",
    "florida": "fl", "georgia": "ga", "hawaii": "hi", "idaho": "id",
    "illinois": "il", "indiana": "in", "iowa": "ia", "kansas": "ks",
    "kentucky": "ky", "louisiana": "la", "maine": "me", "maryland": "md",
    "massachusetts": "ma", "michigan": "mi", "minnesota": "mn", "mississippi": "ms",
    "missouri": "mo", "montana": "mt", "nebraska": "ne", "nevada": "nv",
    "new hampshire": "nh", "new jersey": "nj", "new mexico": "nm", "new york": "ny",
    "north carolina": "nc", "north dakota": "nd", "ohio": "oh", "oklahoma": "ok",
    "oregon": "or", "pennsylvania": "pa", "rhode island": "ri", "south carolina": "sc",
    "south dakota": "sd", "tennessee": "tn", "texas": "tx", "utah": "ut",
    "vermont": "vt", "virginia": "va", "washington": "wa", "west virginia": "wv",
    "wisconsin": "wi", "wyoming": "wy", "district of columbia": "dc",
}
US_STATE_NAMES = {v: k for k, v in US_STATES.items()}
COUNTRY_ALIASES = {
    "us": "united states", "usa": "united states", "u.s.": "united states",
    "uk": "united kingdom", "gb": "united kingdom", "great britain": "united kingdom",
}


def _norm(v):
    return re.sub(r"\s+", " ", str(v or "").strip().lower())


def _norm_state(v):
    value = _norm(v).replace(".", "")
    return US_STATES.get(value, value)


def _norm_country(v):
    value = _norm(v)
    return COUNTRY_ALIASES.get(value, value)


def _parse_location_scope(location: str) -> tuple[str, str | None, str | None]:
    """Parses 'City', 'City, State', or 'City, State, Country'."""
    parts = [p.strip() for p in location.split(",") if p.strip()]
    target_city = _norm(parts[0] if parts else location)
    target_state = _norm_state(parts[1]) if len(parts) >= 2 else None
    target_country = _norm_country(parts[2]) if len(parts) >= 3 else None
    return target_city, target_state, target_country


def _complete_address_fields(raw: str | None) -> dict:
    """gosom's complete_address column is a JSON blob like
    {"borough":"","street":"","city":"","postal_code":"","state":"",
    "country":""} - this pulls out just the non-empty structured parts,
    which is where the real city/state/country actually live (there's no
    separate flat 'city' column in gosom's CSV output)."""
    if not raw:
        return {}
    stripped = raw.strip()
    if not (stripped.startswith("{") and stripped.endswith("}")):
        return {}
    try:
        parts = json.loads(stripped)
    except (ValueError, TypeError):
        return {}
    return {k: str(v).strip() for k, v in parts.items() if v}


def _matches_location(row: dict, location: str) -> bool:
    """Prefers the structured complete_address fields; falls back to a
    word-boundary regex match against the plain address text when those
    aren't present for a given business."""
    target_city, target_state, target_country = _parse_location_scope(location)
    fields = _complete_address_fields(row.get("complete_address"))
    actual_city = _norm(fields.get("city"))
    actual_state = _norm_state(fields["state"]) if fields.get("state") else ""
    actual_country = _norm_country(fields["country"]) if fields.get("country") else ""
    address_text = _norm(row.get("address"))

    if actual_city:
        city_ok = actual_city == target_city
    else:
        city_ok = bool(
            target_city and re.search(rf"(?<![a-z]){re.escape(target_city)}(?![a-z])", address_text)
        )
    if not city_ok:
        return False

    if target_state:
        if actual_state:
            if actual_state != target_state:
                return False
        else:
            state_full = US_STATE_NAMES.get(target_state, target_state)
            if not re.search(
                rf"(?<![a-z])(?:{re.escape(target_state)}|{re.escape(state_full)})(?![a-z])", address_text
            ):
                return False

    if target_country and actual_country and actual_country != target_country:
        return False

    return True


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
        rejected = 0
        with open(results_path, newline="", encoding="utf-8") as f:
            reader = csv.DictReader(f)
            if reader.fieldnames:
                print(f"gosom CSV columns: {reader.fieldnames}", file=sys.stderr)
            for row in reader:
                if not _matches_location(row, city):
                    rejected += 1
                    continue
                results.append({
                    "name": _first_present(row, COLUMN_ALIASES["name"]),
                    "google_maps_url": _first_present(row, COLUMN_ALIASES["google_maps_url"]),
                    "place_id": _first_present(row, COLUMN_ALIASES["place_id"]),
                    "address": _first_present(row, COLUMN_ALIASES["address"], transform=_clean_address),
                    "rating": _to_float(_first_present(row, COLUMN_ALIASES["rating"])),
                    "phone": _first_present(row, COLUMN_ALIASES["phone"]),
                    "email": _first_present(row, COLUMN_ALIASES["email"], transform=_clean_email),
                })
        if rejected:
            print(f"Rejected {rejected} result(s) outside requested location '{city}'", file=sys.stderr)
        if not results and rejected:
            print(f"No businesses matched the exact requested location '{city}'", file=sys.stderr)
        return [r for r in results if r["google_maps_url"]]


def save_results(keyword: str, city: str, results: list[dict]) -> list[dict]:
    """Saves discovered businesses and returns the saved rows (with their
    real database ids), so the caller can hand them straight to
    scan_many() for review scanning without a second round trip."""
    client = get_client()
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

    # ilike (case-insensitive exact match) so this picks up everything
    # under this keyword+city regardless of how it was capitalized before.
    saved = client.table("businesses").select("*").ilike("keyword", keyword).ilike("city", city).execute()
    return saved.data or []


def log_run(keyword: str, city: str, count: int, status: str = "success", error: str = None) -> str:
    client = get_client()
    payload = {
        "run_type": "discover",
        "keyword": keyword,
        "city": city,
        "businesses_scanned": count,
        "status": status,
        "error_message": error,
        "ran_at": datetime.now(timezone.utc).isoformat(),
    }
    try:
        row = client.table("scrape_logs").insert(payload).execute()
    except Exception as exc:
        # Same stale-PostgREST-schema-cache issue as scan_reviews.py - a
        # discover run finishing (or failing) must never itself throw just
        # because the cache hasn't picked up the city column yet.
        if "PGRST204" not in str(exc) or "city" not in str(exc):
            raise
        payload.pop("city", None)
        row = client.table("scrape_logs").insert(payload).execute()
    return row.data[0]["id"]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--keyword", required=True)
    parser.add_argument("--city", required=True, help="City, or 'City, State' / 'City, State, Country' for an exact scope")
    args = parser.parse_args()

    try:
        start_job("discover", total_count=0)
        update_progress(0, f"Searching '{args.keyword}' in '{args.city}'…")
    except Exception as e:
        print(f"Failed to start job status tracking: {e}")

    scan_id = None
    try:
        results = run_gosom_search(args.keyword, args.city)
        saved_businesses = save_results(args.keyword, args.city, results)
        # Row starts as "running" - it doesn't flip to a real final status
        # until the review-scanning phase below finishes too, since this
        # is now ONE combined run (find businesses AND scan their reviews),
        # not two separate steps the user has to trigger by hand.
        scan_id = log_run(args.keyword, args.city, len(saved_businesses), status="running")
        print(f"Discovery done: {len(saved_businesses)} businesses saved for '{args.keyword}' in '{args.city}'")

        if saved_businesses:
            summary = scan_many(
                saved_businesses,
                run_type="discover",
                keyword=args.keyword,
                city=args.city,
                existing_scan_id=scan_id,
            )
            print(f"Review scan done: {summary}")
            if summary["negative"] > 0:
                try:
                    notify_new_negative_reviews()
                except Exception as push_err:
                    print(f"Failed to send negative-review push notification: {push_err}")
        else:
            client = get_client()
            client.table("scrape_logs").update({"status": "success"}).eq("id", scan_id).execute()
            try:
                finish_job("done")
            except Exception as e:
                print(f"Failed to finish job status tracking: {e}")
    except Exception as e:
        if scan_id:
            try:
                client = get_client()
                client.table("scrape_logs").update(
                    {"status": "failed", "error_message": str(e)}
                ).eq("id", scan_id).execute()
            except Exception as log_err:
                print(f"Failed to mark run as failed: {log_err}")
        else:
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
