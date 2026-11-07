"""Google OAuth routes for the schema in docs/implementation_Details.md."""

import logging
import os
from uuid import UUID

from dotenv import load_dotenv
from fastapi import APIRouter, Depends, HTTPException, Request
from httpx import RequestError
from postgrest.exceptions import APIError
from starlette.concurrency import run_in_threadpool
from starlette.responses import RedirectResponse

from authService import oauth, verify_google_id_token
from config import SUPER_ADMIN_EMAIL, supabase

load_dotenv()
logger = logging.getLogger(__name__)
router = APIRouter(prefix="/auth", tags=["auth"])
frontend_url = os.getenv("FRONTEND_URL", "http://localhost:5173").rstrip("/")

# Database grants use lowercase codes; the existing frontend uses these DTO codes.
# "admin" is the operational/reception role, NOT an implicit Super Admin.
ROLE_MAP = {
    "owner": "GYM_OWNER",
    "admin": "GYM_RECEPTIONIST",
    "trainer": "GYM_TRAINER",
}
ROLE_PRIORITY = {role: index for index, role in enumerate(ROLE_MAP)}
USER_COLUMNS = "id,email,google_subject,active,display_name"


def is_bootstrap_admin(email: str) -> bool:
    return email.strip().lower() == SUPER_ADMIN_EMAIL


async def _find_user_by_email(email: str) -> dict | None:
    # Escape LIKE wildcards; email may legally contain an underscore or percent.
    escaped = email.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")
    result = await run_in_threadpool(
        supabase.table("users").select(USER_COLUMNS).ilike("email", escaped).limit(2).execute
    )
    if len(result.data or []) > 1:
        raise HTTPException(status_code=403, detail="Ambiguous account identity")
    return result.data[0] if result.data else None


async def _bind_identity(email: str, subject: str, name: str | None) -> dict:
    """Conditionally bind a verified identity; never overwrite a bound subject."""
    user = await _find_user_by_email(email)
    if user is None:
        if not is_bootstrap_admin(email):
            raise HTTPException(status_code=403, detail="Account is not authorized")
        try:
            await run_in_threadpool(
                supabase.table("users").insert({
                    "email": SUPER_ADMIN_EMAIL, "google_subject": subject,
                    "display_name": name or SUPER_ADMIN_EMAIL, "active": True,
                }).execute
            )
        except APIError as error:
            # Concurrent bootstrap: a unique email/subject index decides the winner.
            # Re-read it, then compare subjects; never upsert over an existing binding.
            if error.code != "23505":
                raise
        user = await _find_user_by_email(email)
        if user is None:
            raise HTTPException(status_code=403, detail="Identity cannot be bound")

    bound = user.get("google_subject")
    if bound is not None and bound != subject:
        raise HTTPException(status_code=403, detail="Google identity does not match")
    if not is_bootstrap_admin(email):
        await _authorized_user(user)
    if bound is None:
        try:
            await run_in_threadpool(
                supabase.table("users").update({"google_subject": subject})
                .eq("id", user["id"]).is_("google_subject", "null").execute
            )
        except APIError as error:
            if error.code != "23505":
                raise
            raise HTTPException(status_code=403, detail="Identity is already bound") from None
    # Read back the committed value even when the conditional update lost a race.
    # A concurrent login with the SAME subject is valid; a different subject is not.
    user = await _find_user_by_email(email)
    if not user or user.get("google_subject") != subject:
        raise HTTPException(status_code=403, detail="Google identity does not match")
    if is_bootstrap_admin(email) and user.get("active") is not True:
        await run_in_threadpool(
            supabase.table("users").update({"active": True})
            .eq("id", user["id"]).eq("google_subject", subject).execute
        )
        user = await _find_user_by_email(email)
        if not user or not user.get("active") or user.get("google_subject") != subject:
            raise HTTPException(status_code=403, detail="Account could not be activated")
    # Access invitations use email as a nonempty placeholder display name.
    # Fill that placeholder from verified Google claims, preserving custom names.
    if name and name.strip() and user.get("display_name") == user["email"]:
        await run_in_threadpool(
            supabase.table("users").update({"display_name": name.strip()})
            .eq("id", user["id"]).eq("google_subject", subject)
            .eq("display_name", user["email"]).execute
        )
        user = await _find_user_by_email(email)
        if not user or user.get("google_subject") != subject:
            raise HTTPException(status_code=403, detail="Google identity does not match")
    return user


def _login_error(request: Request, code: str) -> RedirectResponse:
    request.session.clear()
    return RedirectResponse(url=f"{frontend_url}/login/error?error={code}")


async def _authorized_user(user: dict, profile: dict | None = None) -> dict:
    """Read live grants; never authorize using a role cached in a cookie."""
    profile = profile or {}
    response = {
        "id": str(user["id"]), "email": user["email"],
        "name": user.get("display_name") or profile.get("name") or user["email"],
        "picture": profile.get("picture"), "status": "ACTIVE",
    }
    # Authoritative exception evaluated BEFORE ordinary grants/active checks.
    # A signed, subject-bound identity is required by callback/get_me callers.
    if is_bootstrap_admin(user["email"]):
        return {**response, "role": "SUPER_ADMIN"}
    if not user.get("active"):
        raise HTTPException(status_code=403, detail="Account is not authorized")
    result = await run_in_threadpool(
        supabase.table("role_assignments")
        .select("role,trainer_id")
        .eq("user_id", user["id"])
        .is_("revoked_at", "null")
        .execute
    )
    grants = result.data or []
    if not grants or any(grant.get("role") not in ROLE_MAP for grant in grants):
        raise HTTPException(status_code=403, detail="Account has no supported active role")
    grant = min(grants, key=lambda item: ROLE_PRIORITY[item["role"]])
    trainer_id = grant.get("trainer_id")
    if grant["role"] == "trainer" and not trainer_id:
        raise HTTPException(status_code=403, detail="Trainer profile is not linked")
    if grant["role"] != "trainer" and trainer_id is not None:
        raise HTTPException(status_code=403, detail="Invalid role assignment")
    response["role"] = ROLE_MAP[grant["role"]]
    if grant["role"] == "trainer":
        response["trainerId"] = str(trainer_id)
    return response


@router.get("/login")
async def login(request: Request):
    request.session.clear()
    redirect_uri = os.getenv("GOOGLE_REDIRECT_URI")
    if not redirect_uri:
        raise HTTPException(status_code=503, detail="Google sign-in is not configured")
    return await oauth.google.authorize_redirect(request, redirect_uri)


@router.get("/callback")
async def auth_callback(request: Request):
    try:
        # Preserve Authlib's code exchange and OAuth state/nonce validation.
        token = await oauth.google.authorize_access_token(request)
        raw_token = token.get("id_token")
        if not isinstance(raw_token, str) or not raw_token:
            raise ValueError("Missing Google ID token")
        info = await run_in_threadpool(verify_google_id_token, raw_token)
    except Exception:
        logger.warning("Google OAuth callback validation failed")
        return _login_error(request, "auth_failed")

    email, subject = info.get("email"), info.get("sub")
    if not isinstance(email, str) or not isinstance(subject, str) or not subject:
        return _login_error(request, "no_user_info")
    if info.get("email_verified") is not True:
        return _login_error(request, "auth_failed")
    email = email.strip().lower()
    if not email:
        return _login_error(request, "no_user_info")

    try:
        profile = {
            "name": info.get("name") if isinstance(info.get("name"), str) else None,
            "picture": info.get("picture") if isinstance(info.get("picture"), str) else None,
        }
        user = await _bind_identity(email, subject, profile["name"])
        current_user = await _authorized_user(user, profile)
    except HTTPException:
        return _login_error(request, "userNotFound")
    except (APIError, RequestError):
        # Don't leak database details, OAuth tokens, or user identifiers to clients/logs.
        logger.error("Authentication database lookup failed; verify schema and connectivity")
        return _login_error(request, "service_unavailable")

    request.session.clear()
    request.session["user"] = {
        "id": current_user["id"],
        "google_subject": subject,
        **profile,
    }
    target = "/finances" if current_user["role"] in {"SUPER_ADMIN", "GYM_OWNER"} else "/trainer" if current_user["role"] == "GYM_TRAINER" else "/members"
    return RedirectResponse(url=f"{frontend_url}{target}")


@router.get("/logout")
async def logout(request: Request):
    request.session.clear()
    return RedirectResponse(url=f"{frontend_url}/login")


@router.get("/me")
async def get_me(request: Request):
    identity = request.session.get("user")
    if not isinstance(identity, dict) or not identity.get("google_subject"):
        request.session.clear()
        raise HTTPException(status_code=401, detail="Not authenticated")
    try:
        user_id = str(UUID(str(identity.get("id"))))
    except ValueError:
        request.session.clear()
        raise HTTPException(status_code=401, detail="Not authenticated") from None
    try:
        result = await run_in_threadpool(
            supabase.table("users")
            .select(USER_COLUMNS)
            .eq("id", user_id)
            .eq("google_subject", identity["google_subject"])
            .limit(1)
            .execute
        )
        if not result.data:
            raise HTTPException(status_code=401, detail="Session is no longer valid")
        return await _authorized_user(result.data[0], identity)
    except HTTPException:
        request.session.clear()
        raise
    except (APIError, RequestError):
        logger.error("Session authorization database lookup failed")
        raise HTTPException(status_code=503, detail="Authentication service unavailable") from None


def require_roles(*roles: str):
    """Use Depends(require_roles(...)) on every protected business endpoint.

    The permanent Super Admin has all permissions. No cookie/client role is trusted.
    """
    async def dependency(user: dict = Depends(get_me)) -> dict:
        if user["role"] != "SUPER_ADMIN" and user["role"] not in roles:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return user
    return dependency


def reject_bootstrap_access_change(target_user: dict) -> None:
    """Guard user/grant mutations; DB triggers additionally block direct writes."""
    if is_bootstrap_admin(target_user["email"]):
        raise HTTPException(status_code=403, detail="Permanent Super Admin access cannot be changed")
