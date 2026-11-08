"""Opt-in real HTTP checks AFTER developer-applied migration, never a migrator.

Default: BLOCKED — PENDING MANUAL MIGRATION (no database/network access).
Only enable against an explicitly authorized disposable test installation. Fixtures
are retained as financial history; do not point this suite at the live gym.
"""
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta
from decimal import Decimal
import os
import unittest
from uuid import uuid4
from zoneinfo import ZoneInfo
import httpx

ENABLED = os.getenv('WZ_FINANCIAL_E2E') == 'DISPOSABLE_MANUALLY_MIGRATED'


@unittest.skipUnless(ENABLED, 'BLOCKED — PENDING MANUAL MIGRATION and explicitly authorized disposable HTTP test installation')
class FinancialEndToEndTests(unittest.TestCase):
    def setUp(self):
        required = ['WZ_TEST_API_URL', 'WZ_TEST_OWNER_COOKIE', 'WZ_TEST_TRAINER_COOKIE', 'WZ_TEST_PLAN_ID', 'WZ_TEST_ORIGIN']
        missing = [key for key in required if not os.getenv(key)]
        if missing:
            self.skipTest('Missing explicit test configuration: ' + ', '.join(missing))
        self.client = httpx.Client(base_url=os.environ['WZ_TEST_API_URL'], headers={
            'Cookie': os.environ['WZ_TEST_OWNER_COOKIE'], 'Origin': os.environ['WZ_TEST_ORIGIN']}, timeout=30)
        self.today = datetime.now(ZoneInfo('Asia/Kolkata')).date().isoformat()
        self.plan = os.environ['WZ_TEST_PLAN_ID']

    def tearDown(self):
        if hasattr(self, 'client'):
            self.client.close()

    def post(self, path, fields, expected=201):
        response = self.client.post(path, json={'requestKey': str(uuid4()), **fields})
        self.assertEqual(response.status_code, expected, response.text)
        return response.json()

    def member(self):
        member = self.post('/members', {'fullName': 'Financial E2E ' + str(uuid4()), 'joiningDate': self.today,
                                       'planId': self.plan, 'startDate': self.today, 'email': '', 'phone': ''})
        response = self.client.get('/fees-due', params={'memberId': member['id']})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()['rows']), 1, 'Use a positive-price gym plan for these tests')
        return member, response.json()['rows'][0]

    def invoice(self, bill):
        result = self.client.get('/fees-due/' + bill['id'])
        self.assertEqual(result.status_code, 200, result.text)
        return result.json()

    def payment(self, bill, amount, key=None, expected=201):
        return self.post('/fees-due/' + bill['id'] + '/payments', {'requestKey': key or str(uuid4()), 'amount': amount,
                         'date': self.today, 'method': 'cash', 'notes': 'Disposable E2E'}, expected)

    def test_01_full_payment_creates_real_invoice_and_zero_balance(self):
        _, bill = self.member()
        self.payment(bill, bill['balance'])
        self.assertEqual(Decimal(self.invoice(bill)['invoice']['balance']), 0)

    def test_02_multiple_partial_payments_and_overpayment_rejection(self):
        _, bill = self.member()
        if Decimal(bill['balance']) < Decimal('0.03'):
            self.skipTest('Plan must cost at least INR 0.03')
        self.payment(bill, '0.01')
        self.payment(bill, '0.01')
        self.assertEqual(Decimal(self.invoice(bill)['invoice']['balance']), Decimal(bill['balance'])-Decimal('0.02'))
        self.payment(bill, bill['balance'], expected=409)

    def test_03_deleting_pending_member_archives_and_preserves_debt(self):
        member, bill = self.member()
        response = self.client.delete('/members/' + member['id'])
        self.assertEqual(response.status_code, 200, response.text)
        details = self.invoice(bill)
        self.assertTrue(details['invoice']['archived'])
        self.assertEqual(details['invoice']['balance'], bill['balance'])
        self.assertEqual(self.client.delete('/members/' + member['id']).status_code, 404)

    def test_04_reversal_retains_receipt_and_reopens_balance(self):
        _, bill = self.member()
        payment = self.payment(bill, bill['balance'])
        self.post('/financial-payments/' + payment['id'] + '/refunds', {'amount': bill['balance'], 'date': self.today,
                  'reason': 'Disposable reversal verification', 'reversal': True})
        details = self.invoice(bill)
        self.assertEqual(details['invoice']['balance'], bill['balance'])
        self.assertEqual(len(details['payments']), 1)
        self.assertEqual(len(details['payments'][0]['refunds']), 1)
        self.post('/financial-payments/' + payment['id'] + '/refunds', {'amount': '0.01', 'date': self.today,
                  'reason': 'Duplicate reversal', 'reversal': True}, 409)

    def test_05_expense_create_edit_post_and_reverse_preserves_history(self):
        expense = self.post('/financial-expenses', {'amount': '0.01', 'incurredOn': self.today,
                            'category': 'Miscellaneous', 'description': 'Disposable E2E expense'})
        self.post('/financial-expenses/' + expense['id'] + '/post', {'version': 1, 'date': self.today, 'method': 'cash'}, 200)
        self.post('/financial-expenses/' + expense['id'] + '/reverse', {'version': 2, 'reason': 'Returned test expense'}, 200)
        report = self.client.get('/finances', params={'start': self.today, 'end': self.today}).json()
        row = next(e for e in report['expenses'] if e['id'] == expense['id'])
        self.assertEqual(row['status'], 'void')
        self.assertEqual(row['version'], 3)

    def test_06_renewal_keeps_previous_debt_and_duplicate_renewal_is_rejected(self):
        member, bill = self.member()
        start = (datetime.fromisoformat(self.today).date()+timedelta(days=365)).isoformat()
        fields = {'memberId': member['id'], 'kind': 'GYM', 'planId': self.plan, 'startDate': start}
        purchase = self.post('/financial-subscriptions', fields)
        self.post('/financial-subscriptions', fields, 409)
        self.assertEqual(self.invoice(bill)['invoice']['balance'], bill['balance'])
        rows = self.client.get('/fees-due', params={'memberId': member['id']}).json()['rows']
        self.assertEqual(len(rows), 2)
        self.post('/financial-subscriptions/' + purchase['id'] + '/cancel', {'kind': 'GYM', 'reason': 'Cancel future renewal'}, 200)
        self.assertEqual(len(self.client.get('/fees-due', params={'memberId': member['id']}).json()['rows']), 2)

    def test_07_concurrent_full_payments_cannot_overcollect(self):
        _, bill = self.member()
        def submit(_):
            return self.client.post('/fees-due/' + bill['id'] + '/payments', json={'requestKey': str(uuid4()),
                'amount': bill['balance'], 'date': self.today, 'method': 'cash'}).status_code
        with ThreadPoolExecutor(max_workers=2) as executor:
            statuses = sorted(executor.map(submit, range(2)))
        self.assertEqual(statuses, [201, 409])
        self.assertEqual(len(self.invoice(bill)['payments']), 1)

    def test_08_trainer_cannot_access_financial_records(self):
        with httpx.Client(base_url=os.environ['WZ_TEST_API_URL'], headers={
            'Cookie': os.environ['WZ_TEST_TRAINER_COOKIE'], 'Origin': os.environ['WZ_TEST_ORIGIN']}) as trainer:
            for path in ['/fees-due', '/finances', '/finances/export']:
                self.assertEqual(trainer.get(path).status_code, 403)

    def test_09_lost_response_retry_reuses_original_receipt(self):
        _, bill = self.member()
        key = str(uuid4())
        committed = self.payment(bill, bill['balance'], key)
        # Simulate a client discarding the successful HTTP response, then retrying.
        retried = self.payment(bill, bill['balance'], key)
        self.assertEqual(committed['id'], retried['id'])
        self.assertEqual(len(self.invoice(bill)['payments']), 1)
        self.assertEqual(self.client.get('/financial-requests/' + key).json()['id'], committed['id'])

    def test_10_existing_module_read_regression(self):
        for path in ['/members', '/membership-plans', '/personal-training-plans', '/trainers', '/trainer/options', '/access-assignments']:
            response = self.client.get(path)
            self.assertEqual(response.status_code, 200, f'{path}: {response.text}')
