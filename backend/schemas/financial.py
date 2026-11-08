"""Financial commands: decimal strings, closed fields, server-owned actor/state."""
from datetime import date, datetime
from decimal import Decimal
from typing import Annotated, Literal
from uuid import UUID
from zoneinfo import ZoneInfo
from typing import Any

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

Method = Literal['cash', 'upi', 'card', 'bank', 'other']
Category = Literal['Rent', 'Electricity', 'Equipment', 'Maintenance', 'Salaries', 'Cleaning', 'Marketing', 'Miscellaneous']
Money = Annotated[str, Field(pattern=r'^[0-9]{1,10}(\.[0-9]{1,2})?$', max_length=13)]


class Command(BaseModel):
    model_config = ConfigDict(extra='forbid', str_strip_whitespace=True)
    requestKey: UUID

    @field_validator('requestKey', mode='before')
    @classmethod
    def uuid_string(cls, value):
        if not isinstance(value, str):
            raise ValueError('Request key must be a UUID string')
        return value


class AmountCommand(Command):
    amount: Money

    @field_validator('amount')
    @classmethod
    def positive_amount(cls, value):
        if not Decimal('0') < Decimal(value) <= Decimal('9999999999.99'):
            raise ValueError('Amount must be positive and within supported limits')
        return value


class PaymentCreate(AmountCommand):
    date: date
    method: Method
    reference: str = Field(default='', max_length=200)
    notes: str = Field(default='', max_length=2000)

    @field_validator('date', mode='before')
    @classmethod
    def posting_date(cls, value):
        return validate_date(value, future=False)


class RefundCreate(AmountCommand):
    date: date
    reason: str = Field(min_length=3, max_length=2000)
    reversal: bool = Field(default=False, strict=True)
    _posting_date = field_validator('date', mode='before')(lambda v: validate_date(v, future=False))


class AdjustmentCreate(AmountCommand):
    reason: str = Field(min_length=3, max_length=2000)


class ExpenseCreate(AmountCommand):
    incurredOn: date
    category: Category
    description: str = Field(min_length=3, max_length=2000)
    reference: str = Field(default='', max_length=200)
    _incurred_date = field_validator('incurredOn', mode='before')(lambda v: validate_date(v, future=True))


class ExpenseEdit(ExpenseCreate):
    version: int = Field(ge=1, strict=True)


class ExpensePost(Command):
    version: int = Field(ge=1, strict=True)
    date: date
    method: Method
    _posting_date = field_validator('date', mode='before')(lambda v: validate_date(v, future=False))


class ReasonCommand(Command):
    reason: str = Field(min_length=3, max_length=2000)


class ExpenseReverse(ReasonCommand):
    version: int = Field(ge=1, strict=True)


class PurchaseCreate(Command):
    memberId: UUID
    kind: Literal['GYM', 'PT']
    planId: UUID
    trainerId: UUID | None = None
    startDate: date
    _start_date = field_validator('startDate', mode='before')(lambda v: validate_date(v, future=True))

    @model_validator(mode='after')
    def trainer_required(self):
        if (self.kind == 'PT') != (self.trainerId is not None):
            raise ValueError('Only PT purchases require a trainer')
        return self


class SubscriptionCancel(ReasonCommand):
    kind: Literal['GYM', 'PT']


class MutationResult(BaseModel):
    id: UUID
    action: str


class FinancialLine(BaseModel):
    id: str
    description: str
    amount: str
    originalAmount: str | None = None
    subscriptionId: str | None = None
    kind: str | None = None
    startDate: str | None = None
    endDate: str | None = None
    membershipStatus: str | None = None


class Obligation(BaseModel):
    id: str
    memberId: str
    memberName: str
    memberNumber: str
    archived: bool
    reconciliationRequired: bool = False
    invoiceNumber: str
    invoiceDate: str
    dueDate: str
    status: str
    total: str
    paid: str
    balance: str
    lastPaymentDate: str | None
    lines: list[FinancialLine]
    adjustments: list[dict[str, Any]] = Field(default_factory=list)
    paymentStatus: str | None = None
    overdue: bool = False
    upcoming: bool = False


class FeesResponse(BaseModel):
    rows: list[Obligation]
    total: int
    page: int
    pageSize: int
    summary: dict[str, str | int]
    archivedMembers: list[dict[str, Any]]
    unbilled: list[dict[str, Any]]


class InvoiceResponse(BaseModel):
    invoice: Obligation
    payments: list[dict[str, Any]]


class FinanceResponse(BaseModel):
    rows: list[dict[str, Any]]
    total: int
    page: int
    pageSize: int
    summary: dict[str, str]
    trends: list[dict[str, str]]
    methods: dict[str, str]
    categories: dict[str, str]
    plans: dict[str, str]
    warnings: list[str]
    expenses: list[dict[str, Any]]
    events: list[dict[str, Any]]


def validate_date(value, *, future):
    if not isinstance(value, str):
        raise ValueError('Use an ISO calendar date')
    parsed = date.fromisoformat(value)
    if parsed.isoformat() != value or parsed < date(1900, 1, 1):
        raise ValueError('Unsupported date')
    if not future and parsed > datetime.now(ZoneInfo('Asia/Kolkata')).date():
        raise ValueError('Posting dates cannot be in the future')
    return parsed
