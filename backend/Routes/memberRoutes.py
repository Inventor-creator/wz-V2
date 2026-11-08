"""Atomic member onboarding and history-preserving contact CRUD."""
import logging
from uuid import UUID
from fastapi import APIRouter, Depends, HTTPException
from httpx import RequestError
from postgrest.exceptions import APIError
from starlette.concurrency import run_in_threadpool
from config import supabase
from Routes.authRoutes import require_roles
from Routes.accessRoutes import require_write_origin
from schemas.member import (
    MemberCreate, MemberPatch, MemberProfile, MemberDirectory, MemberOptions,
    MemberDetails, MemberDeletion,
)

router = APIRouter(prefix="/members", tags=["Members"])
staff = require_roles("GYM_OWNER", "GYM_RECEPTIONIST")
logger = logging.getLogger(__name__)


async def member_rpc(name: str, params: dict):
    try:
        return (await run_in_threadpool(supabase.rpc(name, params).execute)).data
    except APIError as error:
        status, detail = {
            "42501": (403, "Member management is not available to this account"),
            "P0002": (404, "Member not found"),
            "22023": (422, "Invalid member details, dates or plan selection"),
            "23514": (409, "The selected member, plan or trainer is no longer available; refresh and try again"),
            "23505": (409, "This request key was already used for different member details"),
            "23503": (409, "Member history changed; refresh and try again"),
        }.get(error.code, (503, "Member management unavailable; verify database migration 008"))
        logger.warning("Member operation rejected (code=%s)", error.code)
        raise HTTPException(status_code=status, detail=detail) from None
    except RequestError:
        raise HTTPException(status_code=503, detail="Member database unavailable") from None


@router.get("", response_model=MemberDirectory)
async def list_members(actor: dict = Depends(staff)):
    return await member_rpc("workout_zone_list_members", {"p_actor_id": actor["id"]})


@router.get("/options", response_model=MemberOptions)
async def member_options(actor: dict = Depends(staff)):
    return await member_rpc("workout_zone_member_options", {"p_actor_id": actor["id"]})


@router.get("/{member_id}", response_model=MemberDetails)
async def get_member(member_id: UUID, actor: dict = Depends(staff)):
    return await member_rpc("workout_zone_get_member", {"p_actor_id": actor["id"], "p_member_id": str(member_id)})


@router.post("", response_model=MemberProfile, status_code=201, dependencies=[Depends(require_write_origin)])
async def create_member(body: MemberCreate, actor: dict = Depends(staff)):
    return await member_rpc("workout_zone_create_member", {
        "p_actor_id": actor["id"], "p_request_key": str(body.requestKey),
        "p_fields": body.model_dump(mode="json", exclude={"requestKey"}),
    })


@router.patch("/{member_id}", response_model=MemberProfile, dependencies=[Depends(require_write_origin)])
async def update_member(member_id: UUID, body: MemberPatch, actor: dict = Depends(staff)):
    return await member_rpc("workout_zone_mutate_member", {
        "p_actor_id": actor["id"], "p_member_id": str(member_id), "p_action": "update",
        "p_fields": body.model_dump(mode="json", exclude_unset=True),
    })


@router.delete("/{member_id}", response_model=MemberDeletion, dependencies=[Depends(require_write_origin)])
async def delete_member(member_id: UUID, actor: dict = Depends(staff)):
    return await member_rpc("workout_zone_mutate_member", {
        "p_actor_id": actor["id"], "p_member_id": str(member_id), "p_action": "delete",
    })
