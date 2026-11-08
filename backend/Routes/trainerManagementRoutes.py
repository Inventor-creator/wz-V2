"""Staff trainer directory; no login grants or historical financial rewrites."""
import logging
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException
from httpx import RequestError
from postgrest.exceptions import APIError
from starlette.concurrency import run_in_threadpool

from config import supabase
from Routes.authRoutes import require_roles
from Routes.accessRoutes import require_write_origin
from schemas.trainer_management import (
    TrainerCreate, TrainerPatch, TrainerDirectoryEntry, TrainerDetails,
    CommissionSchedule, CommissionRule,
)

router = APIRouter(prefix="/trainers", tags=["Trainer management"])
staff = require_roles("GYM_OWNER", "GYM_RECEPTIONIST")
owner = require_roles("GYM_OWNER")
logger = logging.getLogger(__name__)


async def trainer_rpc(name: str, params: dict):
    try:
        return (await run_in_threadpool(supabase.rpc(name, params).execute)).data
    except APIError as error:
        status, detail = {
            "42501": (403, "Trainer management is not available to this account"),
            "P0002": (404, "Trainer not found"),
            "22023": (422, "Invalid profile or commission period; commission must start after today"),
            "23P01": (409, "Overlapping or already scheduled rules require review; no changes were saved"),
        }.get(error.code, (503, "Trainer management unavailable; verify database migration 007"))
        logger.warning("Trainer management operation rejected (code=%s)", error.code)
        raise HTTPException(status_code=status, detail=detail) from None
    except RequestError:
        raise HTTPException(status_code=503, detail="Trainer database unavailable") from None


@router.get("", response_model=list[TrainerDirectoryEntry])
async def list_trainers(actor: dict = Depends(staff)):
    return await trainer_rpc("workout_zone_list_trainers", {"p_actor_id": actor["id"]})


@router.get("/{trainer_id}", response_model=TrainerDetails)
async def get_trainer(trainer_id: UUID, actor: dict = Depends(staff)):
    return await trainer_rpc("workout_zone_get_trainer", {"p_actor_id": actor["id"], "p_trainer_id": str(trainer_id)})


@router.post("", response_model=TrainerDirectoryEntry, status_code=201, dependencies=[Depends(require_write_origin)])
async def create_trainer(body: TrainerCreate, actor: dict = Depends(staff)):
    return await trainer_rpc("workout_zone_mutate_trainer", {
        "p_actor_id": actor["id"], "p_action": "create", "p_fields": body.model_dump(mode="json"),
    })


@router.patch("/{trainer_id}", response_model=TrainerDirectoryEntry, dependencies=[Depends(require_write_origin)])
async def update_trainer(trainer_id: UUID, body: TrainerPatch, actor: dict = Depends(staff)):
    return await trainer_rpc("workout_zone_mutate_trainer", {
        "p_actor_id": actor["id"], "p_action": "update", "p_trainer_id": str(trainer_id),
        "p_fields": body.model_dump(mode="json", exclude_unset=True),
    })


@router.post("/{trainer_id}/commission-rules", response_model=CommissionRule, status_code=201, dependencies=[Depends(require_write_origin)])
async def schedule_commission(trainer_id: UUID, body: CommissionSchedule, actor: dict = Depends(owner)):
    return await trainer_rpc("workout_zone_schedule_trainer_commission", {
        "p_actor_id": actor["id"], "p_trainer_id": str(trainer_id),
        "p_rate": str(body.commissionRate), "p_start": body.effectiveFrom.isoformat(),
        "p_end": body.effectiveUntil.isoformat() if body.effectiveUntil else None,
    })
