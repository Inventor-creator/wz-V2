"""Read-only trainer dashboard. SQL derives trainer scope from the live actor."""
import logging
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException, Query
from httpx import RequestError
from postgrest.exceptions import APIError
from starlette.concurrency import run_in_threadpool
from config import supabase
from Routes.authRoutes import require_roles
from schemas.trainer import TrainerDashboard, TrainerMember, TrainerProfile

router = APIRouter(prefix="/trainer", tags=["Trainer dashboard"])
actor_dependency = require_roles("GYM_OWNER", "GYM_TRAINER")
logger = logging.getLogger(__name__)


async def trainer_rpc(name: str, params: dict):
    try:
        return (await run_in_threadpool(supabase.rpc(name, params).execute)).data
    except APIError as error:
        status, detail = {
            "42501": (403, "Trainer data is not available to this account"),
            "P0002": (404, "Trainer or assigned member not found"),
            "22023": (422, "Invalid dashboard filters"),
        }.get(error.code, (503, "Trainer dashboard unavailable; verify database migrations"))
        logger.warning("Trainer query rejected (code=%s)", error.code)
        raise HTTPException(status_code=status, detail=detail) from None
    except RequestError:
        raise HTTPException(status_code=503, detail="Trainer database unavailable") from None


@router.get("/options", response_model=list[TrainerProfile])
async def options(actor: dict = Depends(actor_dependency)):
    return await trainer_rpc("workout_zone_trainer_options", {"p_actor_id": actor["id"]})


@router.get("/dashboard", response_model=TrainerDashboard)
async def dashboard(
    trainerId: UUID | None = None, search: str = Query("", max_length=120),
    planId: UUID | None = None, status: str = Query("", pattern="^(Active|Expired|Expiring Soon|Upcoming)?$"),
    page: int = Query(1, ge=1), pageSize: int = Query(8, ge=1, le=100),
    actor: dict = Depends(actor_dependency),
):
    return await trainer_rpc("workout_zone_trainer_dashboard", {
        "p_actor_id": actor["id"], "p_trainer_id": str(trainerId) if trainerId else None,
        "p_search": search, "p_plan_id": str(planId) if planId else None,
        "p_status": status, "p_page": page, "p_page_size": pageSize,
    })


@router.get("/members/{member_id}", response_model=TrainerMember)
async def member(member_id: UUID, trainerId: UUID | None = None, actor: dict = Depends(actor_dependency)):
    return await trainer_rpc("workout_zone_trainer_member", {
        "p_actor_id": actor["id"], "p_member_id": str(member_id),
        "p_trainer_id": str(trainerId) if trainerId else None,
    })
