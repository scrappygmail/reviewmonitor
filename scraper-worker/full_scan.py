"""
Runs twice a day (cron). Scans a BATCH of businesses across ALL keywords,
prioritising whichever have gone longest without being scanned
(last_scanned_at nulls first, then oldest first). This rotation ensures
every discovered business eventually gets checked, without ever trying
to scan the whole list (which could be 1000+) in a single run.

Batch size is read from app_settings.full_scan_batch_size (default 150)
so it can be tuned later without touching code.
"""
from db import get_client
from scan_reviews import scan_many
from notify_push import notify_new_negative_reviews


def main():
    client = get_client()

    settings = client.table("app_settings").select("*").eq("id", 1).single().execute().data
    batch_size = settings.get("full_scan_batch_size", 150)

    result = (
        client.table("businesses")
        .select("*")
        .order("last_scanned_at", desc=False, nullsfirst=True)
        .limit(batch_size)
        .execute()
    )
    businesses = result.data

    if not businesses:
        print("No discovered businesses yet — nothing to scan.")
        return

    summary = scan_many(businesses, run_type="full_scan")
    print(f"Full scan (rotation batch of {len(businesses)}): {summary}")

    if summary["negative"] > 0:
        notify_new_negative_reviews()


if __name__ == "__main__":
    main()
