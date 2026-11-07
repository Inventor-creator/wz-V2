"""Application lifecycle and middleware configuration."""

import os
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from dotenv import load_dotenv
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from starlette.middleware.sessions import SessionMiddleware
from supabase import create_client , Client

load_dotenv()

# Permanent server-side bootstrap identity. Never derive this from client input.
SUPER_ADMIN_EMAIL = "aryapat1234@gmail.com"

SUPABASE_URL = os.getenv("SUPABASE_URL")
SUPABASE_KEY = os.getenv("SUPABASE_SERVICE_ROLE_KEY")

# Single client instance for the app
supabase: Client = create_client(SUPABASE_URL or "", SUPABASE_KEY or "")


def configure_middleware(app: FastAPI) -> None:
    """Apply session and CORS settings to the application."""
    secret = os.getenv("SECRET_KEY")
    if not secret:
        raise RuntimeError("SECRET_KEY is required for application sessions")
    secure_cookie = os.getenv("SESSION_COOKIE_SECURE", "true" if os.getenv("FRONTEND_URL", "").startswith("https://") else "false").lower() == "true"
    app.add_middleware(
        SessionMiddleware,
        secret_key=secret,
        session_cookie="secure_session",
        max_age=3600,
        same_site="lax",
        https_only=secure_cookie,
        domain=None,
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=[os.getenv("FRONTEND_URL", "http://localhost:5173")],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )
