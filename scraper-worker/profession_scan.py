"""
On-demand scan: user picks ONE saved keyword+city combo from the Discover
tab and this scans every business under that EXACT combo, no size cap
(assumes user triggers it manually and is fine waiting).

IMPORTANT: filters by keyword AND city together. Filtering by keyword
alone used to silently merge every city ever searched under that keyword
(e.g. "plumber" in Manchester + "plumber" in Texas), which made review
counts and "negative reviews found" numbers make no sense once more than
one city had been searched for the same profession.
"""
import argparse
from db import get_client
from scan_reviews import scan_many
from notify_push import notify_new_negative_reviews


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--keyword", required=True)
    parser.add_argument("--city", required=True)
    args = parser.parse_args()

    client = get_client()
    # ilike (no wildcards) = case-insensitive exact match - some earlier
    # searches saved "Plumber" and others "plumber", which would otherwise
    # be treated as two different keywords.
    result = (
        client.table("businesses")
        .select("*")
        .ilike("keyword", args.keyword)
        .ilike("city", args.city)
        .execute()
    )
    businesses = result.data

    if not businesses:
        print(f"No businesses found for keyword '{args.keyword}' in '{args.city}'.")
        return

    summary = scan_many(businesses, run_type="profession_scan", keyword=args.keyword, city=args.city)
    print(f"Profession scan ({args.keyword} in {args.city}): {summary}")

    if summary["negative"] > 0:
        notify_new_negative_reviews()


if __name__ == "__main__":
    main()
