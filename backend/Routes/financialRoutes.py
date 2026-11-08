"""Cookie-authenticated financial API; all writes are atomic checked SQL RPCs."""
import logging
from datetime import date, datetime
from uuid import UUID
from zoneinfo import ZoneInfo

from fastapi import APIRouter, Depends, HTTPException, Query, Request, Response
from httpx import RequestError
from postgrest.exceptions import APIError
from starlette.concurrency import run_in_threadpool

from config import supabase
from Routes.authRoutes import require_roles
from Routes.accessRoutes import require_write_origin
from schemas.financial import (
    Command, PaymentCreate, RefundCreate, AdjustmentCreate, ExpenseCreate, ExpenseEdit,
    ExpensePost, ExpenseReverse, PurchaseCreate, SubscriptionCancel, ReasonCommand, MutationResult,
    FeesResponse, InvoiceResponse, FinanceResponse,
)
import financial_service as service

router = APIRouter(tags=['Fees and finances'])
staff = require_roles('GYM_OWNER', 'GYM_RECEPTIONIST')
owner = require_roles('GYM_OWNER')
logger = logging.getLogger(__name__)


async def rpc(name, params):
    try:
        return (await run_in_threadpool(supabase.rpc(name, params).execute)).data
    except APIError as error:
        status, detail = {
            '42501': (403, 'Financial access denied'),
            'P0002': (404, 'Financial record not found'),
            '22023': (422, 'Invalid financial values'),
            '23505': (409, 'Duplicate request, reference or purchase; retry using the original request key'),
            '23514': (409, 'Financial conflict: refresh balances/version; legacy allocations or trainer settlement may require review'),
            '23503': (409, 'Financial references must be preserved'),
            '40001': (409, 'Concurrent change; retry with the original request key'),
            '40P01': (409, 'Concurrent change; retry with the original request key'),
        }.get(error.code, (503, 'Financial service unavailable; verify manually applied migration 009'))
        logger.warning('Financial RPC %s failed: code=%s', name, error.code)
        raise HTTPException(status_code=status, detail=detail) from error
    except (RequestError, ConnectionError, TimeoutError) as error:
        raise HTTPException(status_code=503, detail='Financial service unreachable; retry with the original request key') from error


def today():
    return datetime.now(ZoneInfo('Asia/Kolkata')).date().isoformat()


async def read(actor, full=False):
    return await rpc('financial_read', {'p_actor_id': actor['id'], 'p_owner': full})


async def mutate(actor, action, target, body: Command):
    fields = body.model_dump(mode='json', exclude={'requestKey'})
    return await rpc('financial_mutate', {'p_actor_id': actor['id'], 'p_request_key': str(body.requestKey),
                                         'p_action': action, 'p_id': str(target) if target else None, 'p_fields': fields})


def filters(request: Request, financial=False):
    allowed = {'search', 'status', 'sort', 'direction', 'page', 'pageSize'}
    if financial:
        allowed |= {'start', 'end', 'type', 'method'}
    else:
        allowed.add('memberId')
    if set(request.query_params)-allowed:
        raise HTTPException(422, 'Unsupported filter')
    values = dict(request.query_params)
    try:
        for key, default in [('page', 1), ('pageSize', 20)]:
            values[key] = int(values.get(key, default))
        if values['page'] < 1 or not 1 <= values['pageSize'] <= 100:
            raise ValueError()
        if values.get('direction', 'desc') not in ('asc', 'desc') or len(values.get('search', '')) > 200:
            raise ValueError()
        if values.get('memberId'):
            values['memberId'] = str(UUID(values['memberId']))
        if financial:
            values.setdefault('start', today()[:7] + '-01')
            values.setdefault('end', today())
            start, end = date.fromisoformat(values['start']), date.fromisoformat(values['end'])
            if start.isoformat() != values['start'] or end.isoformat() != values['end'] or end < start or (end-start).days > 3660:
                raise ValueError()
    except (ValueError, TypeError):
        raise HTTPException(422, 'Invalid filters or date range (maximum ten years)') from None
    return values


@router.get('/fees-due', response_model=FeesResponse)
async def list_fees(request: Request, actor=Depends(staff)):
    values = filters(request)
    try:
        data = await read(actor)
        return service.fees(data, values, data.get('asOfDate', today()))
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


@router.get('/financial-requests/{request_key}')
async def request_status(request_key: UUID, actor=Depends(staff)):
    return await rpc('financial_request_status', {'p_actor_id': actor['id'], 'p_request_key': str(request_key)})


@router.get('/fees-due/{invoice_id}', response_model=InvoiceResponse)
async def get_invoice(invoice_id: UUID, actor=Depends(staff)):
    result = service.invoice_details(await read(actor), str(invoice_id))
    if result is None:
        raise HTTPException(404, 'Invoice not found')
    return result


@router.post('/fees-due/{invoice_id}/payments', response_model=MutationResult, status_code=201, dependencies=[Depends(require_write_origin)])
async def payment(invoice_id: UUID, body: PaymentCreate, actor=Depends(staff)):
    return await mutate(actor, 'payment', invoice_id, body)


@router.post('/financial-payments/{payment_id}/refunds', response_model=MutationResult, status_code=201, dependencies=[Depends(require_write_origin)])
async def refund(payment_id: UUID, body: RefundCreate, actor=Depends(staff)):
    return await mutate(actor, 'refund', payment_id, body)


@router.post('/fees-due/{invoice_id}/adjustments', response_model=MutationResult, status_code=201, dependencies=[Depends(require_write_origin)])
async def adjustment(invoice_id: UUID, body: AdjustmentCreate, actor=Depends(owner)):
    return await mutate(actor, 'adjust', invoice_id, body)


@router.get('/finances', response_model=FinanceResponse)
async def get_finances(request: Request, actor=Depends(owner)):
    values = filters(request, True)
    try:
        data = await read(actor, True)
        return service.finances(data, values, data.get('asOfDate', today()))
    except ValueError as error:
        raise HTTPException(422, str(error)) from error


@router.get('/finances/export')
async def export(request: Request, actor=Depends(owner)):
    values = filters(request, True)
    data = await read(actor, True)
    # CSV includes all matching rows, not merely the displayed page.
    values.update(page=1, pageSize=max(1, len(service.transactions(data))))
    try:
        report = service.finances(data, values, data.get('asOfDate', today()))
    except ValueError as error:
        raise HTTPException(422, str(error)) from error
    return Response(service.export_csv(report['rows']), media_type='text/csv',
                    headers={'Content-Disposition': 'attachment; filename="financial-transactions.csv"'})


@router.post('/financial-expenses', response_model=MutationResult, status_code=201, dependencies=[Depends(require_write_origin)])
async def create_expense(body: ExpenseCreate, actor=Depends(owner)):
    return await mutate(actor, 'expense_create', None, body)


@router.patch('/financial-expenses/{expense_id}', response_model=MutationResult, dependencies=[Depends(require_write_origin)])
async def edit_expense(expense_id: UUID, body: ExpenseEdit, actor=Depends(owner)):
    return await mutate(actor, 'expense_edit', expense_id, body)


@router.post('/financial-expenses/{expense_id}/post', response_model=MutationResult, dependencies=[Depends(require_write_origin)])
async def post_expense(expense_id: UUID, body: ExpensePost, actor=Depends(owner)):
    return await mutate(actor, 'expense_post', expense_id, body)


@router.post('/financial-expenses/{expense_id}/reverse', response_model=MutationResult, dependencies=[Depends(require_write_origin)])
async def reverse_expense(expense_id: UUID, body: ExpenseReverse, actor=Depends(owner)):
    return await mutate(actor, 'expense_reverse', expense_id, body)


@router.post('/financial-subscriptions', response_model=MutationResult, status_code=201, dependencies=[Depends(require_write_origin)])
async def purchase(body: PurchaseCreate, actor=Depends(staff)):
    return await mutate(actor, 'purchase', None, body)


@router.post('/financial-subscriptions/{subscription_id}/cancel', response_model=MutationResult, dependencies=[Depends(require_write_origin)])
async def cancel(subscription_id: UUID, body: SubscriptionCancel, actor=Depends(staff)):
    return await mutate(actor, 'cancel', subscription_id, body)


@router.post('/financial-subscriptions/{subscription_id}/bill', response_model=MutationResult, status_code=201, dependencies=[Depends(require_write_origin)])
async def bill_legacy(subscription_id: UUID, body: SubscriptionCancel, actor=Depends(owner)):
    return await mutate(actor, 'legacy_bill', subscription_id, body)


@router.post('/financial-members/{member_id}/restore', response_model=MutationResult, dependencies=[Depends(require_write_origin)])
async def restore(member_id: UUID, body: ReasonCommand, actor=Depends(staff)):
    return await mutate(actor, 'restore', member_id, body)
