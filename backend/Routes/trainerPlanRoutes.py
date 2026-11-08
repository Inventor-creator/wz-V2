"""Shared PT catalogue, independent of the trainer chosen on a purchase."""
import logging
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException
from httpx import RequestError
from postgrest.exceptions import APIError
from starlette.concurrency import run_in_threadpool

from config import supabase
from Routes.authRoutes import require_roles
from Routes.accessRoutes import require_write_origin
from schemas.membership import (
    MembershipPlan as TrainerPlan,
    MembershipPlanInput as TrainerPlanInput,
    MembershipPlanPatch as TrainerPlanPatch,
    PlanDeletion,
)

router = APIRouter(prefix="/personal-training-plans", tags=["Trainer plans"])
actor_dependency = require_roles("GYM_OWNER", "GYM_RECEPTIONIST")
logger = logging.getLogger(__name__)


async def plan_rpc(name: str, params: dict):
    try:
        return (await run_in_threadpool(supabase.rpc(name, params).execute)).data
    except APIError as error:
        status, detail = {
            "42501": (403, "Trainer plans are not available to this account"),
            "P0002": (404, "Trainer plan not found"),
            "22023": (422, "Invalid trainer plan fields"),
            "23505": (409, "A plan with this name already exists, including retained historical plans"),
            "23503": (409, "Plan history changed; refresh and try again"),
        }.get(error.code, (503, "Trainer plans unavailable; verify database migration 006"))
        logger.warning("Trainer plan operation rejected (code=%s)", error.code)
        raise HTTPException(status_code=status, detail=detail) from None
    except RequestError:
        raise HTTPException(status_code=503, detail="Trainer plan database unavailable") from None


@router.get("", response_model=list[TrainerPlan])
async def list_plans(actor: dict = Depends(actor_dependency)):
    return await plan_rpc("workout_zone_list_trainer_plans", {"p_actor_id": actor["id"]})


@router.get("/{plan_id}", response_model=TrainerPlan)
async def get_plan(plan_id: UUID, actor: dict = Depends(actor_dependency)):
    return await plan_rpc("workout_zone_get_trainer_plan", {"p_actor_id": actor["id"], "p_plan_id": str(plan_id)})


@router.post("", response_model=TrainerPlan, status_code=201, dependencies=[Depends(require_write_origin)])
async def create_plan(body: TrainerPlanInput, actor: dict = Depends(actor_dependency)):
    return await plan_rpc("workout_zone_mutate_trainer_plan", {
        "p_actor_id": actor["id"], "p_action": "create", "p_fields": body.model_dump(mode="json"),
    })


@router.patch("/{plan_id}", response_model=TrainerPlan, dependencies=[Depends(require_write_origin)])
async def update_plan(plan_id: UUID, body: TrainerPlanPatch, actor: dict = Depends(actor_dependency)):
    return await plan_rpc("workout_zone_mutate_trainer_plan", {
        "p_actor_id": actor["id"], "p_action": "update", "p_plan_id": str(plan_id),
        "p_fields": body.model_dump(mode="json", exclude_unset=True),
    })


@router.delete("/{plan_id}", response_model=PlanDeletion, dependencies=[Depends(require_write_origin)])
async def delete_plan(plan_id: UUID, actor: dict = Depends(actor_dependency)):
    return await plan_rpc("workout_zone_mutate_trainer_plan", {
        "p_actor_id": actor["id"], "p_action": "delete", "p_plan_id": str(plan_id),
    })
