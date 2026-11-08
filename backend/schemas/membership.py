from decimal import Decimal
from typing import Literal
from uuid import UUID
from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


class MembershipPlanInput(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=2, max_length=120)
    price: Decimal = Field(ge=0, max_digits=12, decimal_places=2)
    duration: int = Field(strict=True, ge=1, le=36500)
    durationUnit: Literal["DAY"] = "DAY"
    description: str = Field(default="", max_length=2000)
    isActive: bool = Field(default=True, strict=True)

    @field_validator("name", "description")
    @classmethod
    def trim_text(cls, value):
        return value.strip()

    @model_validator(mode="after")
    def nonblank_name(self):
        if len(self.name)<2:
            raise ValueError("Enter a plan name with at least two characters")
        return self


class MembershipPlanPatch(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str | None = Field(default=None,min_length=2,max_length=120)
    price: Decimal | None = Field(default=None,ge=0,max_digits=12,decimal_places=2)
    duration: int | None = Field(default=None,strict=True,ge=1,le=36500)
    durationUnit: Literal["DAY"] | None = None
    description: str | None = Field(default=None,max_length=2000)
    isActive: bool | None = Field(default=None,strict=True)

    @field_validator("name", "description")
    @classmethod
    def trim_text(cls,value):
        return value.strip() if value is not None else None

    @model_validator(mode="after")
    def valid_patch(self):
        if not self.model_fields_set or any(getattr(self,key) is None for key in self.model_fields_set):
            raise ValueError("Provide non-null plan fields to update")
        if self.name is not None and len(self.name)<2:
            raise ValueError("Enter a nonblank plan name")
        return self


class MembershipPlan(BaseModel):
    id: UUID
    name: str
    price: float
    duration: int
    durationUnit: Literal["DAY"]
    description: str
    isActive: bool
    activeMembersCount: int
    hasHistory: bool


class PlanDeletion(BaseModel):
    id: UUID
    mode: Literal["DELETED", "REMOVED_FROM_CATALOG"]
