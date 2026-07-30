"""
Runs every 6 hours (and on manual "Check Now"). Scans ONLY businesses
where monitored=true — the small watch list (4-20 businesses).
"""
from db import get_client
from scan_reviews import scan_many
from notify_push import notify_new_negative_reviews


def main():
    client = get_client()
    result = client.table("businesses").select("*").eq("monitored", True).execute()
    businesses = result.data

    if not businesses:
        print("No monitored businesses yet — nothing to scan.")
        return

    summary = scan_many(businesses, run_type="monitor")
    print(f"Monitor run: {summary}")

    if summary["negative"] > 0:
        notify_new_negative_reviews()


if __name__ == "__main__":
    main()
