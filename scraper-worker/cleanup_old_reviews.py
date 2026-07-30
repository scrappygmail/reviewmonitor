"""Deletes reviews older than 90 days. Runs once a day via cron."""
from db import get_client


def main():
    client = get_client()
    client.rpc("delete_old_reviews").execute()
    print("Old reviews (90+ days) cleaned up.")


if __name__ == "__main__":
    main()
