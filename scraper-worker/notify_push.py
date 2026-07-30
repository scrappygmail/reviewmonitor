"""
Sends Web Push notifications (free, VAPID-based, no third-party service)
for two situations:
  - notify_new_negative_reviews() — a scan found new 1-3* reviews
  - notify_scan_failed()          — a scan run crashed/errored

Negative-review alerts respect the `push_enabled` toggle in app_settings
(the dashboard's on/off switch). Failure alerts always send regardless of
that toggle — a broken scraper is an operational problem you want to know
about even if you've muted routine review alerts.
"""
import os
import json
from pywebpush import webpush, WebPushException
from db import get_client

VAPID_PRIVATE_KEY = os.environ["VAPID_PRIVATE_KEY"]
VAPID_CLAIMS = {"sub": f"mailto:{os.environ.get('VAPID_CONTACT_EMAIL', 'admin@example.com')}"}


def _send_to_all(client, payload: dict):
    subs = client.table("push_subscriptions").select("*").execute().data
    if not subs:
        print("No push subscriptions registered yet.")
        return

    data = json.dumps(payload)
    for sub in subs:
        try:
            webpush(
                subscription_info={
                    "endpoint": sub["endpoint"],
                    "keys": {"p256dh": sub["p256dh"], "auth": sub["auth"]},
                },
                data=data,
                vapid_private_key=VAPID_PRIVATE_KEY,
                vapid_claims=VAPID_CLAIMS.copy(),
            )
        except WebPushException as e:
            print(f"Push failed for {sub['endpoint'][:40]}...: {e}")
            # 410/404 means the subscription is dead - clean it up
            if "410" in str(e) or "404" in str(e):
                client.table("push_subscriptions").delete().eq("id", sub["id"]).execute()


def notify_new_negative_reviews():
    client = get_client()
    settings = client.table("app_settings").select("push_enabled").eq("id", 1).single().execute().data
    if not settings.get("push_enabled", True):
        return

    _send_to_all(client, {
        "title": "New negative review found",
        "body": "Open the dashboard to see details.",
        "url": "/",
    })


def notify_scan_failed(run_type: str, error_message: str):
    client = get_client()
    short_error = (error_message or "")[:120]

    _send_to_all(client, {
        "title": f"Scraper run failed ({run_type})",
        "body": short_error or "Check the dashboard / GitHub Actions log for details.",
        "url": "/",
    })
