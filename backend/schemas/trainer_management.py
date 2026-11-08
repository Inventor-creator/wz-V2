"""Trainer profile writes are deliberately separate from login grants."""
from datetime import date
from decimal import Decimal
from typing import Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator
from schemas.access import NewTrainer
from schemas.trainer import TrainerProfile


class TrainerFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @field_validator("name", check_fields=False)
    @classmethod
    def valid_name(cls, value):
        if value is not None:
            value = value.strip()
            if len(value) < 2:
                raise ValueError("Enter the trainer's full name")
        return value

    @field_validator("email", mode="before", check_fields=False)
    @classmethod
    def normalize_email(cls, value):
        return value.strip().lower() if isinstance(value, str) else value

    @field_validator("phone", check_fields=False)
    @classmethod
    def valid_phone(cls, value):
        if value is None:
            return None
        return NewTrainer.valid_phone(value) or ""


class TrainerCreate(TrainerFields):
    name: str = Field(min_length=2, max_length=160)
    email: EmailStr | Literal[""] = Field(default="", max_length=254)
    phone: str = Field(default="", max_length=32)
    isActive: bool = Field(default=True, strict=True)


class TrainerPatch(TrainerFields):
    name: str | None = Field(default=None, min_length=2, max_length=160)
    email: EmailStr | Literal[""] | None = Field(default=None, max_length=254)
    phone: str | None = Field(default=None, max_length=32)
    isActive: bool | None = Field(default=None, strict=True)

    @model_validator(mode="after")
    def valid_patch(self):
        if not self.model_fields_set or any(getattr(self, key) is None for key in self.model_fields_set):
            raise ValueError("Provide non-null profile fields; use empty strings to clear contacts")
        return self


class TrainerDirectoryEntry(TrainerProfile):
    assignedMembersCount: int
    activeMembersCount: int
    hasLoginAccess: bool


class TrainerAssignment(BaseModel):
    id: UUID
    memberId: UUID
    memberName: str
    memberEmail: str
    memberPhone: str
    planId: UUID
    planName: str
    startDate: str
    endDate: str
    priceAtPurchase: float
    status: Literal["Active", "Expired", "Upcoming", "Cancelled"]


class CommissionRule(BaseModel):
    id: UUID
    kind: Literal["percent", "fixed"]
    value: float
    effectiveFrom: str
    effectiveUntil: str | None


class TrainerDetails(BaseModel):
    trainer: TrainerDirectoryEntry
    assignments: list[TrainerAssignment]
    payoutRules: list[CommissionRule] | None


class CommissionSchedule(BaseModel):
    model_config = ConfigDict(extra="forbid")
    commissionRate: Decimal = Field(ge=0, le=100, max_digits=5, decimal_places=2)
    effectiveFrom: date
    effectiveUntil: date | None = None

    @model_validator(mode="after")
    def valid_period(self):
        if self.effectiveUntil is not None and self.effectiveUntil < self.effectiveFrom:
            raise ValueError("End date cannot be before start date")
        return self
