"""Pure exact cash-flow reporting. No database/network access in this module."""
import csv
import io
from collections import defaultdict
from datetime import date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

ZERO = Decimal('0')


def decimal(value):
    return Decimal(str(value))


def total(rows, key='amount'):
    return sum((decimal(row[key]) for row in rows), ZERO)


def money(value):
    return format(value, '.2f')


def page_rows(rows, filters, sortable):
    search = filters.get('search', '').casefold()
    selected = [r for r in rows if (not search or search in ' '.join(str(v) for v in r.values()).casefold())
                and (not filters.get('status') or r.get('status') == filters['status'])
                and (not filters.get('type') or r.get('type') == filters['type'])
                and (not filters.get('method') or r.get('method') == filters['method'])]
    sort = filters.get('sort', sortable[0])
    if sort not in sortable:
        raise ValueError('Unsupported sort field')
    numeric = {'amount', 'balance', 'total', 'paid'}
    selected.sort(key=lambda r: (decimal(r.get(sort) or '0') if sort in numeric else str(r.get(sort) or ''), r['id']),
                  reverse=filters.get('direction', 'desc') == 'desc')
    page, size = filters.get('page', 1), filters.get('pageSize', 20)
    return {'rows': selected[(page-1)*size:page*size], 'total': len(selected), 'page': page, 'pageSize': size}


def fees(data, filters, today):
    obligations = []
    for original in data['obligations']:
        if original['status'] != 'issued':
            continue
        row = dict(original)
        balance, paid = decimal(row['balance']), decimal(row['paid'])
        row['paymentStatus'] = 'PAID' if balance == 0 else 'PARTIAL' if paid > 0 else 'UNPAID'
        row['status'] = row['paymentStatus']
        row['overdue'] = balance > 0 and row['dueDate'] < today
        row['upcoming'] = balance > 0 and row['dueDate'] > today
        obligations.append(row)
    outstanding = [r for r in obligations if decimal(r['balance']) > 0]
    month = today[:7]
    collected = total([p for p in data['payments'] if p['status'] == 'completed' and (p['date'] or '').startswith(month)])
    refunded = total([r for r in data['refunds'] if r['date'].startswith(month)])
    summary = {'outstanding': money(total(outstanding, 'balance')),
               'overdue': money(total([r for r in outstanding if r['overdue']], 'balance')),
               'members': len({r['memberId'] for r in outstanding}), 'collectedThisMonth': money(collected-refunded),
               'upcoming': sum(r['upcoming'] for r in obligations),
               'partial': sum(r['paymentStatus'] == 'PARTIAL' for r in obligations),
               'paid': sum(r['paymentStatus'] == 'PAID' for r in obligations)}
    status = filters.get('status')
    rows = obligations
    if status in ('OVERDUE', 'UPCOMING'):
        rows = [r for r in rows if r[status.lower()]]
        filters = {**filters, 'status': ''}
    if filters.get('memberId'):
        rows = [r for r in rows if r['memberId'] == filters['memberId']]
    return {**page_rows(rows, filters, ['dueDate', 'memberName', 'total', 'paid', 'balance', 'lastPaymentDate']),
            'summary': summary, 'archivedMembers': data.get('archivedMembers', []), 'unbilled': data.get('unbilled', [])}


def invoice_details(data, invoice_id):
    bill = next((r for r in data['obligations'] if r['id'] == invoice_id), None)
    if bill is None:
        return None
    payments = []
    for p in data['payments']:
        if p['invoiceId'] == invoice_id:
            refunds = [r for r in data['refunds'] if r['paymentId'] == p['id']]
            payments.append({**p, 'refunds': refunds, 'refundable': money(decimal(p['amount'])-total(refunds))})
    return {'invoice': bill, 'payments': sorted(payments, key=lambda p: (p['date'] or '', p['id']), reverse=True)}


def transactions(data):
    bills = {b['id']: b for b in data['obligations']}
    payments = {p['id']: p for p in data['payments']}
    rows = []
    for p in payments.values():
        bill = bills[p['invoiceId']]
        refunded = total([r for r in data['refunds'] if r['paymentId'] == p['id']])
        rows.append({**p, 'type': 'payment', 'entity': bill['memberName'], 'memberId': bill['memberId'],
                     'status': 'reversed' if refunded == decimal(p['amount']) else 'partially_refunded' if refunded else p['status']})
    for r in data['refunds']:
        p = payments[r['paymentId']]
        rows.append({**r, 'invoiceId': p['invoiceId'], 'type': r['kind'], 'entity': bills[p['invoiceId']]['memberName'], 'method': p['method'],
                     'status': 'completed', 'reference': p['id'], 'notes': r['reason']})
    for e in data.get('expenses', []):
        rows.append({**e, 'type': 'expense', 'date': e['date'] or e['incurredOn'], 'entity': e['category'], 'notes': e['description']})
        if e.get('reversedDate') and e['date']:
            rows.append({**e, 'id': e['id'] + '-reversal', 'type': 'expense_reversal', 'date': e['reversedDate'],
                         'entity': e['category'], 'status': 'completed', 'reference': e['id'], 'notes': e['description']})
    for p in data.get('payouts', []):
        rows.append({**p, 'type': 'trainer_payout', 'entity': p['name'], 'status': 'paid', 'method': 'other', 'notes': '', 'createdBy': None})
    for e in data.get('events', []):
        if e['action'] == 'adjust':
            adjustment_date = datetime.fromisoformat(e['created_at']).astimezone(ZoneInfo('Asia/Kolkata')).date().isoformat()
            rows.append({'id': e['id'], 'date': adjustment_date, 'type': 'adjustment', 'amount': e['after_state']['amount'],
                         'entity': bills.get(e['after_state'].get('invoiceId'), {}).get('memberName', 'Invoice adjustment'),
                         'method': None, 'status': 'completed', 'reference': e['target_id'], 'notes': e['after_state']['reason'], 'createdBy': e['actor_id']})
    return rows


def finances(data, filters, today):
    start, end = filters['start'], filters['end']
    def within(d):
        return d is not None and start <= d <= end
    ledger = [r for r in transactions(data) if within(r.get('date'))]
    paid = [p for p in data['payments'] if p['status'] == 'completed']
    refunds = data['refunds']
    expenses = [e for e in data['expenses'] if e['date']]
    paid_expense_ids = {e['id'] for e in expenses}
    reversals = [e for e in expenses if e.get('reversedDate')]
    payouts = data['payouts']
    gross = total([p for p in paid if within(p['date'])])
    returned = total([r for r in refunds if within(r['date'])])
    costs = total([e for e in expenses if within(e['date'])])-total([e for e in reversals if within(e['reversedDate'])])
    trainer_costs = total([p for p in payouts if within(p['date'])])
    current_month = today[:7]
    month_collections = total([p for p in paid if p['date'].startswith(current_month)])-total([r for r in refunds if r['date'].startswith(current_month)])
    month_expenses = total([e for e in expenses if e['date'].startswith(current_month)])-total([e for e in reversals if e['reversedDate'].startswith(current_month)])
    methods, categories, plans = defaultdict(lambda: ZERO), defaultdict(lambda: ZERO), defaultdict(lambda: ZERO)
    lines = {l['id']: l for b in data['obligations'] for l in b['lines']}
    allocations = {a['id']: a for p in paid for a in p['allocations']}
    for p in paid:
        if within(p['date']):
            methods[p['method']] += decimal(p['amount'])
            for a in p['allocations']:
                plans[lines[a['lineId']]['description']] += decimal(a['amount'])
    payment_map = {p['id']: p for p in paid}
    for r in refunds:
        if within(r['date']):
            methods[payment_map[r['paymentId']]['method']] -= decimal(r['amount'])
            for a in r['allocations']:
                plans[lines[allocations[a['allocationId']]['lineId']]['description']] -= decimal(a['amount'])
    for e in expenses:
        if within(e['date']):
            categories[e['category']] += decimal(e['amount'])
        if within(e.get('reversedDate')):
            categories[e['category']] -= decimal(e['amount'])
    trends = {}
    month = date.fromisoformat(start).replace(day=1)
    while month.isoformat() <= end:
        trends[month.isoformat()[:7]] = {'collections': ZERO, 'expenses': ZERO, 'trainerPayouts': ZERO}
        if month.year == 9999 and month.month == 12:
            break
        month = date(month.year + (month.month == 12), month.month % 12 + 1, 1)
    for r in ledger:
        key = (r.get('date') or '')[:7]
        if key not in trends:
            continue
        amount = decimal(r['amount'])
        if r['type'] == 'payment' and r['status'] not in ('pending', 'failed'):
            trends[key]['collections'] += amount
        elif r['type'] in ('refund', 'reversal'):
            trends[key]['collections'] -= amount
        elif r['type'] == 'expense' and r['id'] in paid_expense_ids:
            trends[key]['expenses'] += amount
        elif r['type'] == 'expense_reversal':
            trends[key]['expenses'] -= amount
        elif r['type'] == 'trainer_payout':
            trends[key]['trainerPayouts'] += amount
    warnings = []
    voided_drafts = {e['target_id'] for e in data.get('events', [])
                     if e['action'] == 'expense_reverse' and (e.get('before_state') or {}).get('status') == 'recorded'}
    if any(e['status'] in ('paid', 'void') and not e['date'] and e['id'] not in voided_drafts for e in data['expenses']):
        warnings.append('Legacy paid/void expenses without payment dates are excluded from cash reports. Reconcile manually.')
    if any(total(p['allocations']) != decimal(p['amount']) for p in paid):
        warnings.append('Legacy receipt allocations do not match collections; plan breakdown requires reconciliation.')
    return {**page_rows(ledger, filters, ['date', 'amount', 'type', 'entity', 'status']),
            'summary': {'grossCollections': money(gross), 'refunds': money(returned), 'collections': money(gross-returned),
                        'expenses': money(costs), 'trainerPayouts': money(trainer_costs), 'netCashFlow': money(gross-returned-costs-trainer_costs),
                        'outstanding': money(total([b for b in data['obligations'] if b['status'] == 'issued'], 'balance')),
                        'currentMonthCollections': money(month_collections), 'currentMonthExpenses': money(month_expenses)},
            'trends': [{'month': m, **{k: money(v) for k, v in values.items()}} for m, values in trends.items()],
            'methods': {k: money(v) for k, v in sorted(methods.items())},
            'categories': {k: money(v) for k, v in sorted(categories.items())},
            'plans': {k: money(v) for k, v in sorted(plans.items())}, 'warnings': warnings,
            'expenses': data['expenses'], 'events': data.get('events', [])}


def export_csv(rows):
    output = io.StringIO(newline='')
    writer = csv.writer(output)
    fields = ['id', 'date', 'type', 'amount', 'entity', 'method', 'status', 'reference', 'notes', 'createdBy']
    writer.writerow(fields)
    for row in rows:
        values = []
        for field in fields:
            value = str(row.get(field) or '')
            if value.lstrip().startswith(('=', '+', '-', '@', '\t', '\r', '\n')):
                value = "'" + value
            values.append(value)
        writer.writerow(values)
    return output.getvalue()
