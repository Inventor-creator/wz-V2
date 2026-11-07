"""Cookie-authenticated access routes backed by atomic PostgreSQL RPCs."""
import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from httpx import RequestError
from postgrest.exceptions import APIError
from starlette.concurrency import run_in_threadpool

from config import supabase
from Routes.authRoutes import frontend_url, require_roles
from schemas.access import AccessAssignment, AccessCreate, AccessUpdate

logger = logging.getLogger(__name__)
router = APIRouter(prefix="/access-assignments", tags=["Access management"])
authorized_actor = require_roles("GYM_OWNER")  # Permanent Super Admin is always allowed.
DB_ROLES = {"GYM_OWNER": "owner", "GYM_RECEPTIONIST": "admin", "GYM_TRAINER": "trainer"}


def require_write_origin(request: Request) -> None:
    # Cookie-authenticated privilege changes must originate from our UI.
    # API clients must supply the same Origin header; CORS alone is not CSRF protection.
    if request.headers.get("origin", "").rstrip("/") != frontend_url:
        raise HTTPException(status_code=403, detail="Untrusted request origin")


async def rpc(name: str, params: dict):
    try:
        result = await run_in_threadpool(supabase.rpc(name, params).execute)
        return result.data
    except APIError as error:
        messages = {
            "42501": (403, "Access change is not permitted"),
            "P0002": (404, "Access assignment or trainer not found"),
            "22023": (422, "Invalid role, trainer link, or access change"),
            "23505": (409, "This user role or trainer already has an active assignment"),
            "23503": (409, "The referenced account or trainer is no longer available"),
            "23514": (409, "The requested change violates an access protection"),
            "55000": (409, "The account is disabled; account activation is required separately"),
        }
        status, message = messages.get(error.code, (503, "Access management unavailable; verify database migrations"))
        logger.warning("Access database operation rejected (code=%s)", error.code)
        raise HTTPException(status_code=status, detail=message) from None
    except RequestError:
        raise HTTPException(status_code=503, detail="Access management database unavailable") from None


@router.get("", response_model=list[AccessAssignment])
async def list_assignments(actor: dict = Depends(authorized_actor)):
    return await rpc("workout_zone_list_access", {"p_actor_id": actor["id"]})


@router.get("/trainers")
async def trainer_options(actor: dict = Depends(authorized_actor)):
    try:
        result = await run_in_threadpool(
            supabase.table("trainers").select("id,full_name,email,phone,status")
            .eq("status", "active").order("full_name").execute
        )
        return [{"id": row["id"], "name": row["full_name"], "email": row.get("email") or "",
                 "phone": row.get("phone") or "", "isActive": True} for row in result.data]
    except (APIError, RequestError):
        raise HTTPException(status_code=503, detail="Trainer options unavailable") from None


@router.post("", response_model=AccessAssignment, status_code=201, dependencies=[Depends(require_write_origin)])
async def create_assignment(body: AccessCreate, actor: dict = Depends(authorized_actor)):
    return await rpc("workout_zone_mutate_access", {
        "p_actor_id": actor["id"], "p_action": "create", "p_email": str(body.email),
        "p_role": DB_ROLES[body.role], "p_trainer_id": str(body.trainerId) if body.trainerId else None,
        "p_set_trainer": True, "p_display_name": body.displayName,
    })


@router.patch("/{assignment_id}", response_model=AccessAssignment, dependencies=[Depends(require_write_origin)])
async def update_assignment(assignment_id: UUID, body: AccessUpdate, actor: dict = Depends(authorized_actor)):
    return await rpc("workout_zone_mutate_access", {
        "p_actor_id": actor["id"], "p_action": "update", "p_assignment_id": str(assignment_id),
        "p_email": str(body.email) if body.email else None,
        "p_role": DB_ROLES[body.role] if body.role else None,
        "p_trainer_id": str(body.trainerId) if body.trainerId else None,
        "p_set_trainer": "trainerId" in body.model_fields_set, "p_status": body.status,
    })


@router.post("/{assignment_id}/revoke", response_model=AccessAssignment, dependencies=[Depends(require_write_origin)])
async def revoke_assignment(assignment_id: UUID, actor: dict = Depends(authorized_actor)):
    return await rpc("workout_zone_mutate_access", {
        "p_actor_id": actor["id"], "p_action": "revoke", "p_assignment_id": str(assignment_id),
    })


@router.post("/{assignment_id}/reactivate", response_model=AccessAssignment, status_code=201, dependencies=[Depends(require_write_origin)])
async def reactivate_assignment(assignment_id: UUID, actor: dict = Depends(authorized_actor)):
    return await rpc("workout_zone_mutate_access", {
        "p_actor_id": actor["id"], "p_action": "reactivate", "p_assignment_id": str(assignment_id),
    })


@router.delete("/{assignment_id}", status_code=204, dependencies=[Depends(require_write_origin)])
async def delete_assignment(assignment_id: UUID, actor: dict = Depends(authorized_actor)):
    await rpc("workout_zone_delete_access", {
        "p_actor_id": actor["id"], "p_assignment_id": str(assignment_id),
    })
    return Response(status_code=204)
