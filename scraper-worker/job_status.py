"""
Shared helper for updating the single `job_status` row that the dashboard
polls to show a live progress bar, elapsed time, and a Stop button.

GITHUB_RUN_ID is set by each workflow YAML (env: GITHUB_RUN_ID:
${{ github.run_id }}) so the Stop button knows exactly which GitHub
Actions run to cancel.
"""
import os
from datetime import datetime, timezone
from db import get_client


def start_job(job_type: str, total_count: int = 0):
    client = get_client()
    client.table("job_status").update({
        "job_type": job_type,
        "status": "running",
        "current_index": 0,
        "total_count": total_count,
        "current_label": None,
        "run_id": os.environ.get("GITHUB_RUN_ID"),
        "started_at": datetime.now(timezone.utc).isoformat(),
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", 1).execute()


def update_progress(current_index: int, current_label: str = None, total_count: int = None):
    client = get_client()
    payload = {
        "current_index": current_index,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }
    if current_label is not None:
        payload["current_label"] = current_label
    if total_count is not None:
        payload["total_count"] = total_count
    client.table("job_status").update(payload).eq("id", 1).execute()


def finish_job(status: str):
    """status should be 'done', 'failed', or 'cancelled'."""
    client = get_client()
    client.table("job_status").update({
        "status": status,
        "updated_at": datetime.now(timezone.utc).isoformat(),
    }).eq("id", 1).execute()
