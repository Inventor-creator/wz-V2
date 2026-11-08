"""Pure calculation/contract tests. These DO NOT prove PostgreSQL concurrency."""
from copy import deepcopy
from decimal import Decimal
import random
import unittest
from uuid import uuid4
from pydantic import ValidationError
import financial_service as service
from schemas.financial import PaymentCreate, RefundCreate, ExpenseCreate, PurchaseCreate


def fixture():
    return {
        'obligations': [{'id': 'i1', 'memberId': 'm1', 'memberName': 'Archived Member', 'memberNumber': 'WZ001',
                         'archived': True, 'invoiceNumber': 'INV1', 'invoiceDate': '2024-02-01', 'dueDate': '2024-02-29',
                         'status': 'issued', 'total': '100.00', 'paid': '60.00', 'balance': '40.00', 'lastPaymentDate': '2024-02-29',
                         'lines': [{'id': 'l1', 'description': 'Historical gym', 'amount': '100.00'}]}],
        'payments': [{'id': 'p1', 'invoiceId': 'i1', 'amount': '80.00', 'date': '2024-02-29', 'method': 'cash',
                      'status': 'completed', 'reference': '', 'notes': '=formula', 'createdBy': 'Owner',
                      'allocations': [{'id': 'a1', 'lineId': 'l1', 'amount': '80.00'}]}],
        'refunds': [{'id': 'r1', 'paymentId': 'p1', 'amount': '20.00', 'date': '2024-03-01', 'kind': 'refund',
                     'reason': 'Correction', 'createdBy': 'Owner', 'allocations': [{'allocationId': 'a1', 'amount': '20.00'}]}],
        'expenses': [{'id': 'e1', 'incurredOn': '2024-02-28', 'date': '2024-02-29', 'category': 'Rent', 'description': 'Room rent',
                      'amount': '10.00', 'method': 'bank', 'status': 'void', 'reference': 'rent', 'createdBy': 'Owner',
                      'version': 3, 'reversedDate': '2024-03-01'}],
        'payouts': [{'id': 't1', 'date': '2024-02-29', 'amount': '5.00', 'name': 'Coach', 'reference': 'paid'}],
        'events': [],
    }


class FinancialCalculationTests(unittest.TestCase):
    def report(self, data=None, start='2024-02-01', end='2024-03-31', **filters):
        return service.finances(data or fixture(), {'start': start, 'end': end, **filters}, '2024-03-01')

    def test_cashflow_not_receivables_or_guessed_payout(self):
        result = self.report()
        self.assertEqual(result['summary']['collections'], '60.00')
        self.assertEqual(result['summary']['expenses'], '0.00')
        self.assertEqual(result['summary']['trainerPayouts'], '5.00')
        self.assertEqual(result['summary']['netCashFlow'], '55.00')
        self.assertEqual(result['summary']['outstanding'], '40.00')
        self.assertEqual(result['methods'], {'cash': '60.00'})
        self.assertEqual(result['plans'], {'Historical gym': '60.00'})
        self.assertEqual(result['categories'], {'Rent': '0.00'})

    def test_refund_and_expense_reversal_use_their_own_reporting_dates(self):
        february = self.report(end='2024-02-29')
        march = self.report(start='2024-03-01')
        self.assertEqual(february['summary']['netCashFlow'], '65.00')
        self.assertEqual(march['summary']['netCashFlow'], '-10.00')
        self.assertEqual(march['summary']['currentMonthCollections'], '-20.00')
        self.assertEqual(february['trends'][0]['collections'], '80.00')
        self.assertEqual(march['trends'][0]['expenses'], '-10.00')

    def test_fees_preserve_archived_debt_and_overdue_boundary(self):
        on_due = service.fees(fixture(), {}, '2024-02-29')
        after_due = service.fees(fixture(), {'status': 'OVERDUE'}, '2024-03-01')
        self.assertFalse(on_due['rows'][0]['overdue'])
        self.assertTrue(after_due['rows'][0]['archived'])
        self.assertEqual(after_due['summary']['outstanding'], '40.00')
        self.assertEqual(after_due['summary']['overdue'], '40.00')
        self.assertEqual(after_due['summary']['collectedThisMonth'], '-20.00')
        self.assertEqual(after_due['rows'][0]['paymentStatus'], 'PARTIAL')

    def test_paid_unpaid_upcoming_and_draft_invoice_classification(self):
        data = fixture()
        bill = data['obligations'][0]
        data['obligations'] += [{**bill, 'id': 'i2', 'paid': '100.00', 'balance': '0.00'},
                                {**bill, 'id': 'i3', 'paid': '0.00', 'balance': '100.00', 'dueDate': '2024-04-01'},
                                {**bill, 'id': 'i4', 'status': 'draft'}]
        self.assertEqual(service.fees(data, {'status': 'PAID'}, '2024-03-01')['total'], 1)
        self.assertEqual(service.fees(data, {'status': 'UNPAID'}, '2024-03-01')['total'], 1)
        self.assertEqual(service.fees(data, {'status': 'UPCOMING'}, '2024-03-01')['total'], 1)
        self.assertEqual(service.fees(data, {}, '2024-03-01')['total'], 3)
        self.assertEqual(service.fees(data, {}, '2024-03-01')['summary']['members'], 1)

    def test_pending_failed_and_draft_expenses_do_not_count_as_cash(self):
        data = fixture()
        data['payments'] += [{**data['payments'][0], 'id': 'pending', 'status': 'pending'},
                             {**data['payments'][0], 'id': 'failed', 'status': 'failed'}]
        data['expenses'].append({**data['expenses'][0], 'id': 'draft', 'date': None, 'reversedDate': None, 'status': 'recorded'})
        result = self.report(data)
        self.assertEqual(result['summary']['collections'], '60.00')
        self.assertEqual(result['summary']['expenses'], '0.00')
        self.assertEqual(result['trends'][0]['expenses'], '10.00')

    def test_empty_periods_include_zero_months_and_year_boundary(self):
        result = self.report(start='2023-12-31', end='2024-01-01')
        self.assertEqual(result['summary']['collections'], '0.00')
        self.assertEqual([r['month'] for r in result['trends']], ['2023-12', '2024-01'])

    def test_search_sort_filter_and_pagination_are_stable_without_changing_kpis(self):
        result = self.report(type='payment', search='Archived', sort='amount', direction='asc', page=1, pageSize=1)
        self.assertEqual(result['total'], 1)
        self.assertEqual(result['rows'][0]['id'], 'p1')
        self.assertEqual(result['summary']['collections'], '60.00')
        self.assertEqual(self.report(page=10)['rows'], [])
        with self.assertRaises(ValueError):
            self.report(sort='arbitrary SQL')

    def test_receipt_history_refundable_and_refund_reference_survive_archival(self):
        result = service.invoice_details(fixture(), 'i1')
        self.assertEqual(result['payments'][0]['refundable'], '60.00')
        self.assertEqual(result['payments'][0]['refunds'][0]['id'], 'r1')
        self.assertIsNone(service.invoice_details(fixture(), 'missing'))
        refund = next(t for t in service.transactions(fixture()) if t['type'] == 'refund')
        self.assertEqual(refund['invoiceId'], 'i1')

    def test_legacy_missing_facts_produce_explicit_reconciliation_warnings(self):
        data = fixture()
        data['expenses'][0]['date'] = None
        data['payments'][0]['allocations'][0]['amount'] = '79.99'
        self.assertEqual(len(self.report(data)['warnings']), 2)

    def test_csv_quotes_formulas_and_preserves_newlines_and_commas(self):
        csv = service.export_csv([{'id': 'p', 'entity': 'Name, Test', 'notes': '=SUM(A1)\nline', 'reference': '  @cmd'}])
        self.assertIn('"Name, Test"', csv)
        self.assertIn("'=SUM(A1)", csv)
        self.assertIn("'  @cmd", csv)

    def test_exact_monetary_invariants_over_500_generated_receipt_refund_cases(self):
        random.seed(14)
        for _ in range(500):
            paid = random.randint(1, 99999999)
            refund = random.randint(0, paid)
            data = fixture()
            data['expenses'], data['payouts'] = [], []
            data['payments'][0]['amount'] = service.money(Decimal(paid)/100)
            data['payments'][0]['allocations'][0]['amount'] = data['payments'][0]['amount']
            data['refunds'][0]['amount'] = service.money(Decimal(refund)/100)
            data['refunds'][0]['allocations'][0]['amount'] = data['refunds'][0]['amount']
            expected = service.money(Decimal(paid-refund)/100)
            result = self.report(data)
            self.assertEqual(result['summary']['collections'], expected)
            self.assertEqual(result['methods']['cash'], expected)
            self.assertEqual(result['plans']['Historical gym'], expected)
            self.assertEqual(sum(Decimal(t['collections']) for t in result['trends']), Decimal(expected))

    def test_adjustment_is_non_cash_and_uses_india_date_at_utc_month_boundary(self):
        data = fixture()
        data['events'] = [{'id': 'credit', 'action': 'adjust', 'target_id': 'credit-id', 'actor_id': 'owner',
                           'created_at': '2024-02-29T20:00:00+00:00',
                           'after_state': {'amount': '1.00', 'reason': 'Approved waiver', 'invoiceId': 'i1'}}]
        result = self.report(data, start='2024-03-01')
        credit = next(r for r in result['rows'] if r['type'] == 'adjustment')
        self.assertEqual(credit['date'], '2024-03-01')
        self.assertEqual(credit['entity'], 'Archived Member')
        self.assertEqual(result['summary']['collections'], '-20.00')

    def test_reports_do_not_mutate_source_and_support_final_calendar_month(self):
        data = fixture()
        before = deepcopy(data)
        self.report(data)
        service.fees(data, {}, '2024-03-01')
        service.invoice_details(data, 'i1')
        self.assertEqual(data, before)
        self.assertEqual(self.report(start='9999-12-01', end='9999-12-31')['trends'][0]['month'], '9999-12')

    def test_voided_unpaid_draft_is_not_a_legacy_missing_cash_warning(self):
        data = fixture()
        data['expenses'][0]['date'] = None
        data['events'] = [{'action': 'expense_reverse', 'target_id': 'e1', 'before_state': {'status': 'recorded'}}]
        self.assertEqual(self.report(data)['warnings'], [])
        self.assertEqual(self.report(data)['summary']['expenses'], '0.00')


class FinancialCommandValidationTests(unittest.TestCase):
    def test_money_is_a_positive_exact_string_not_float_bool_exponent_or_rounding(self):
        fields = {'requestKey': str(uuid4()), 'amount': '0.01', 'date': '2024-02-29', 'method': 'cash'}
        self.assertEqual(PaymentCreate(**fields).amount, '0.01')
        for amount in ['0', '-1', '0.001', '1e2', 'NaN', 'Infinity', '10000000000', 1.01, True]:
            with self.subTest(amount=amount), self.assertRaises(ValidationError):
                PaymentCreate(**{**fields, 'amount': amount})

    def test_closed_fields_and_invalid_posting_dates(self):
        fields = {'requestKey': str(uuid4()), 'amount': '20.00', 'date': '2024-02-29', 'method': 'cash'}
        for update in [{'actorId': str(uuid4())}, {'date': '2023-02-29'}, {'date': '9999-01-01'},
                       {'date': 0}, {'method': ''}, {'reference': 'x'*201}, {'notes': 'x'*2001}, {'requestKey': 'bad'}]:
            with self.subTest(update=update), self.assertRaises(ValidationError):
                PaymentCreate(**{**fields, **update})

    def test_refund_reason_expense_category_and_purchase_trainer_ownership(self):
        base = {'requestKey': str(uuid4()), 'amount': '10.00'}
        with self.assertRaises(ValidationError):
            RefundCreate(**base, date='2024-02-29', reason=' ')
        with self.assertRaises(ValidationError):
            ExpenseCreate(**base, incurredOn='2024-02-29', category='deleted-category', description='test')
        purchase = {'requestKey': str(uuid4()), 'memberId': str(uuid4()), 'planId': str(uuid4()), 'startDate': '2024-02-29'}
        with self.assertRaises(ValidationError):
            PurchaseCreate(**purchase, kind='PT')
        with self.assertRaises(ValidationError):
            PurchaseCreate(**purchase, kind='GYM', trainerId=str(uuid4()))
