"""Shared Supabase client for the scraper worker scripts."""
import os
from supabase import create_client, Client

SUPABASE_URL = os.environ["SUPABASE_URL"]
SUPABASE_KEY = os.environ["SUPABASE_SERVICE_ROLE_KEY"]  # server-side key, kept in GitHub Secrets

def get_client() -> Client:
    return create_client(SUPABASE_URL, SUPABASE_KEY)
