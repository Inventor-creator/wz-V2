from typing import Literal
from uuid import UUID
from pydantic import BaseModel


class TrainerProfile(BaseModel):
    id: UUID
    name: str
    email: str
    phone: str
    isActive: bool


class TrainingRow(BaseModel):
    id: UUID
    memberId: UUID
    fullName: str
    email: str
    phone: str
    planId: UUID
    planName: str
    startDate: str
    endDate: str
    daysRemaining: int
    priceAtPurchase: float
    status: Literal["Active", "Expired", "Expiring Soon", "Upcoming"]


class TrainerSummary(BaseModel):
    totalAssignedMembers: int
    activeTrainingMembers: int
    planValue: float
    estimatedPayout: float | None
    payoutStatus: Literal["CONFIGURED", "NOT_CONFIGURED", "REVIEW_REQUIRED"]
    payoutNote: str
    periodStart: str
    periodEnd: str


class PlanOption(BaseModel):
    id: UUID
    name: str


class TrainerDashboard(BaseModel):
    trainer: TrainerProfile | None
    summary: TrainerSummary
    rows: list[TrainingRow]
    plans: list[PlanOption]
    total: int
    page: int
    pageSize: int


class MemberContact(BaseModel):
    id: UUID
    fullName: str
    email: str
    phone: str
    joiningDate: str


class TrainerMember(BaseModel):
    member: MemberContact
    trainingHistory: list[TrainingRow]
