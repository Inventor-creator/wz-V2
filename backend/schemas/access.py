"""Request/response contracts for access management; no writable identity claims."""
from typing import Literal
from uuid import UUID
import re

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator

AssignableRole = Literal["GYM_OWNER", "GYM_RECEPTIONIST", "GYM_TRAINER"]


class NewTrainer(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(min_length=2, max_length=160)
    phone: str | None = Field(default=None, max_length=32)

    @field_validator("name")
    @classmethod
    def valid_name(cls, value):
        value = value.strip()
        if len(value) < 2:
            raise ValueError("Enter the trainer's full name")
        return value

    @field_validator("phone")
    @classmethod
    def valid_phone(cls, value):
        if not value or not value.strip():
            return None
        value = re.sub(r"[ -]", "", value)
        if not re.fullmatch(r"\+?[1-9]\d{7,14}", value):
            raise ValueError("Enter a valid phone number")
        return "+91" + value if len(value) == 10 and not value.startswith("+") else value


class AccessCreate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    email: EmailStr
    role: AssignableRole
    trainerId: UUID | None = None
    displayName: str | None = Field(default=None, min_length=1, max_length=160)
    newTrainer: NewTrainer | None = None

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value):
        return value.strip().lower() if isinstance(value, str) else value

    @field_validator("trainerId", mode="before")
    @classmethod
    def empty_trainer(cls, value):
        return None if value == "" else value

    @field_validator("displayName")
    @classmethod
    def trim_name(cls, value):
        if value is not None and not value.strip():
            raise ValueError("Display name cannot be blank")
        return value.strip() if value else None

    @model_validator(mode="after")
    def trainer_matches_role(self):
        count = int(self.trainerId is not None) + int(self.newTrainer is not None)
        if (self.role == "GYM_TRAINER" and count != 1) or (self.role != "GYM_TRAINER" and count != 0):
            raise ValueError("Trainer access requires one existing OR new trainer profile")
        return self


class AccessUpdate(BaseModel):
    model_config = ConfigDict(extra="forbid")
    # Email is accepted for the existing UI but cannot change an identity.
    email: EmailStr | None = None
    role: AssignableRole | None = None
    trainerId: UUID | None = None
    status: Literal["ACTIVE", "REVOKED"] | None = None
    newTrainer: NewTrainer | None = None

    @field_validator("email", mode="before")
    @classmethod
    def normalize_email(cls, value):
        return value.strip().lower() if isinstance(value, str) else value

    @field_validator("trainerId", mode="before")
    @classmethod
    def empty_trainer(cls, value):
        return None if value == "" else value

    @model_validator(mode="after")
    def validate_patch(self):
        if not self.model_fields_set.intersection({"role", "trainerId", "status", "newTrainer"}):
            raise ValueError("Provide a role, trainer link, or status change")
        if any(getattr(self, key) is None for key in self.model_fields_set.intersection({"role", "status", "email"})):
            raise ValueError("Role, status and email cannot be null")
        if self.role and self.role != "GYM_TRAINER" and self.trainerId is not None:
            raise ValueError("Non-trainer roles cannot link a trainer")
        if self.newTrainer and (self.trainerId or self.role not in (None, "GYM_TRAINER") or self.status == "REVOKED"):
            raise ValueError("A new trainer profile can only be used for active trainer access")
        return self


class AccessAssignment(BaseModel):
    id: UUID
    userId: UUID
    email: str
    name: str | None
    role: Literal["SUPER_ADMIN", "GYM_OWNER", "GYM_RECEPTIONIST", "GYM_TRAINER"]
    status: Literal["ACTIVE", "REVOKED"]
    grantedBy: str
    grantedAt: str
    trainerId: UUID | None = None
    isPermanent: bool = False
    accountActive: bool = True
