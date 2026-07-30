"""
On-demand scan: user picks ONE saved keyword from the Discover tab and
this scans every business under that keyword, no size cap (assumes
user triggers it manually and is fine waiting).
"""
import argparse
from db import get_client
from scan_reviews import scan_many
from notify_push import notify_new_negative_reviews


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--keyword", required=True)
    args = parser.parse_args()

    client = get_client()
    result = client.table("businesses").select("*").eq("keyword", args.keyword).execute()
    businesses = result.data

    if not businesses:
        print(f"No businesses found for keyword '{args.keyword}'.")
        return

    summary = scan_many(businesses, run_type="profession_scan", keyword=args.keyword)
    print(f"Profession scan ({args.keyword}): {summary}")

    if summary["negative"] > 0:
        notify_new_negative_reviews()


if __name__ == "__main__":
    main()
