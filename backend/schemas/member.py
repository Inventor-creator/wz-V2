from datetime import date
from typing import Literal
from uuid import UUID
import re
from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator, model_validator
from schemas.access import NewTrainer
from schemas.membership import MembershipPlan
from schemas.trainer import TrainerProfile


class ProfileFields(BaseModel):
    model_config = ConfigDict(extra="forbid")

    @field_validator("joiningDate", "startDate", "ptStartDate", mode="before", check_fields=False)
    @classmethod
    def calendar_date_only(cls, value):
        if value is not None and (not isinstance(value, str) or not re.fullmatch(r"\d{4}-\d{2}-\d{2}", value)):
            raise ValueError("Use a YYYY-MM-DD calendar date")
        return value

    @field_validator("fullName", check_fields=False)
    @classmethod
    def valid_name(cls, value):
        if value is not None:
            value = value.strip()
            if len(value) < 2:
                raise ValueError("Enter the member's full name")
        return value

    @field_validator("email", mode="before", check_fields=False)
    @classmethod
    def email_normalized(cls, value):
        return value.strip().lower() if isinstance(value, str) else value

    @field_validator("phone", check_fields=False)
    @classmethod
    def phone_normalized(cls, value):
        return (NewTrainer.valid_phone(value) or "") if value is not None else None

    @field_validator("notes", check_fields=False)
    @classmethod
    def notes_trimmed(cls, value):
        return value.strip() if value is not None else None


class MemberCreate(ProfileFields):
    requestKey: UUID
    fullName: str = Field(min_length=2, max_length=160)
    email: EmailStr | Literal[""] = Field(default="", max_length=254)
    phone: str = Field(default="", max_length=32)
    notes: str = Field(default="", max_length=2000)
    joiningDate: date
    planId: UUID
    startDate: date
    trainerId: UUID | None = None
    ptPlanId: UUID | None = None
    ptStartDate: date | None = None

    @field_validator("trainerId", "ptPlanId", "ptStartDate", mode="before")
    @classmethod
    def blank_optional(cls, value):
        return None if value == "" else value

    @model_validator(mode="after")
    def valid_assignment(self):
        if bool(self.trainerId) != bool(self.ptPlanId):
            raise ValueError("Choose both an active trainer and a PT plan")
        if self.trainerId and self.ptStartDate is None:
            raise ValueError("A PT start date is required")
        if self.startDate < self.joiningDate or (self.trainerId and self.ptStartDate < self.joiningDate):
            raise ValueError("Subscriptions cannot start before the joining date")
        # An unused UI default is not part of the purchase or its idempotency payload.
        if not self.trainerId:
            self.ptStartDate = None
        return self


class MemberPatch(ProfileFields):
    fullName: str | None = Field(default=None, min_length=2, max_length=160)
    email: EmailStr | Literal[""] | None = Field(default=None, max_length=254)
    phone: str | None = Field(default=None, max_length=32)
    joiningDate: date | None = None
    notes: str | None = Field(default=None, max_length=2000)

    @model_validator(mode="after")
    def valid_patch(self):
        if not self.model_fields_set or any(getattr(self, key) is None for key in self.model_fields_set):
            raise ValueError("Provide non-null profile fields; clear contacts with empty strings")
        return self


class MemberProfile(BaseModel):
    id: UUID
    memberNumber: str
    fullName: str
    email: str
    phone: str
    joiningDate: str
    status: Literal["ACTIVE", "ARCHIVED"]
    notes: str


class MemberSubscription(BaseModel):
    id: UUID
    type: Literal["GYM", "PT"]
    planId: UUID
    planName: str
    trainerId: UUID | None
    trainerName: str | None
    startDate: str
    endDate: str
    priceAtPurchase: float
    daysRemaining: int
    status: Literal["Active", "Expiring Soon", "Expired", "Upcoming", "Cancelled"]


class MemberDirectoryEntry(MemberProfile):
    gym: MemberSubscription | None
    pt: MemberSubscription | None
    membershipStatus: Literal["Active", "Expiring Soon", "Expired", "Upcoming", "No plan", "Archived"]
    outstandingAmount: float


class MemberSummary(BaseModel):
    activeMembers: int
    expiringSoon: int
    expiredMemberships: int
    outstandingAmount: float


class MemberDirectory(BaseModel):
    members: list[MemberDirectoryEntry]
    summary: MemberSummary


class MemberOptions(BaseModel):
    membershipPlans: list[MembershipPlan]
    personalTrainingPlans: list[MembershipPlan]
    trainers: list[TrainerProfile]


class MemberInvoice(BaseModel):
    id: UUID
    invoiceNumber: str
    invoiceDate: str
    dueDate: str
    status: Literal["draft", "issued", "void"]
    totalAmount: float
    allocatedAmount: float
    outstandingAmount: float
    paymentStatus: Literal["UNPAID", "PARTIAL", "PAID", "NOT_ISSUED"]


class MemberPayment(BaseModel):
    id: UUID
    invoiceId: UUID
    amount: float
    method: str
    status: Literal["pending", "completed", "failed"]
    receivedAt: str | None
    reference: str


class MemberDetails(BaseModel):
    member: MemberProfile
    subscriptions: list[MemberSubscription]
    invoices: list[MemberInvoice]
    payments: list[MemberPayment]


class MemberDeletion(BaseModel):
    id: UUID
    mode: Literal["DELETED", "REMOVED_FROM_DIRECTORY"]
