"""HTTP/auth/RPC adapter tests with mocked Supabase; never execute SQL."""
import importlib.util
from pathlib import Path
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4
from postgrest.exceptions import APIError
import test_auth_routes
from test_financial_service import fixture


class FinancialRoutesTests(unittest.TestCase):
    def setUp(self):
        self.auth = test_auth_routes.AuthRoutesTests()
        self.auth.setUp()
        self.calls, self.failure = [], None
        self.target = str(uuid4())
        self.fields = {'requestKey': str(uuid4()), 'amount': '10.10', 'date': '2024-02-29', 'method': 'cash'}
        self.data = fixture()

        def rpc(name, params):
            def execute():
                self.calls.append((name, params))
                if self.failure:
                    raise self.failure
                result = self.data if name == 'financial_read' else {'id': self.target, 'action': params.get('p_action', 'payment')}
                return SimpleNamespace(data=result)
            return SimpleNamespace(execute=execute)

        config = ModuleType('config')
        config.supabase = SimpleNamespace(rpc=rpc)
        spec = importlib.util.spec_from_file_location('financial_routes_under_test', Path(__file__).parents[1]/'Routes'/'financialRoutes.py')
        module = importlib.util.module_from_spec(spec)
        with patch.dict('sys.modules', {'config': config, 'Routes.authRoutes': self.auth.routes}):
            spec.loader.exec_module(module)
        self.auth.app.include_router(module.router)
        self.client = self.auth.client
        self.client.headers['Origin'] = self.auth.routes.frontend_url
        self.auth.callback()

    def test_collection_uses_live_session_actor_and_decimal_string_rpc_contract(self):
        response = self.client.post(f'/fees-due/{self.target}/payments', json=self.fields)
        self.assertEqual(response.status_code, 201, response.text)
        name, params = self.calls[-1]
        self.assertEqual(name, 'financial_mutate')
        self.assertEqual(params['p_actor_id'], self.auth.db.user_id)
        self.assertEqual(params['p_request_key'], self.fields['requestKey'])
        self.assertEqual(params['p_fields']['amount'], '10.10')
        self.assertNotIn('requestKey', params['p_fields'])

    def test_reads_are_dedicated_and_fee_payload_excludes_expenses_and_audit(self):
        result = self.client.get('/fees-due').json()
        self.assertIn('summary', result)
        self.assertNotIn('expenses', result)
        self.assertEqual(self.calls[-1][1]['p_owner'], False)
        result = self.client.get('/finances?start=2024-02-01&end=2024-03-31').json()
        self.assertEqual(result['summary']['collections'], '60.00')
        self.assertEqual(self.calls[-1][1]['p_owner'], True)
        self.assertEqual(self.client.get('/fees-due/' + self.target).status_code, 404)

    def test_refund_and_expense_transitions_have_checked_actions_and_versions(self):
        key = str(uuid4())
        cases = [
            ('post', f'/financial-payments/{self.target}/refunds', {'amount': '1.00', 'date': '2024-02-29', 'reason': 'Error correction', 'reversal': False}, 'refund', 201),
            ('post', '/financial-expenses', {'amount': '10.00', 'incurredOn': '2024-02-29', 'category': 'Rent', 'description': 'Room rent'}, 'expense_create', 201),
            ('patch', f'/financial-expenses/{self.target}', {'amount': '11.00', 'incurredOn': '2024-02-29', 'category': 'Rent', 'description': 'Room rent', 'version': 1}, 'expense_edit', 200),
            ('post', f'/financial-expenses/{self.target}/post', {'date': '2024-02-29', 'method': 'bank', 'version': 2}, 'expense_post', 200),
            ('post', f'/financial-expenses/{self.target}/reverse', {'reason': 'Returned by vendor', 'version': 3}, 'expense_reverse', 200),
            ('post', f'/fees-due/{self.target}/adjustments', {'amount': '1.00', 'reason': 'Approved discount'}, 'adjust', 201),
        ]
        for method, url, fields, action, status in cases:
            with self.subTest(action=action):
                response = getattr(self.client, method)(url, json={'requestKey': key, **fields})
                self.assertEqual(response.status_code, status, response.text)
                self.assertEqual(self.calls[-1][1]['p_action'], action)

    def test_purchase_cancellation_and_restore_keep_independent_command_contracts(self):
        fields = {'requestKey': str(uuid4()), 'memberId': str(uuid4()), 'kind': 'GYM', 'planId': str(uuid4()), 'startDate': '2024-02-29'}
        self.assertEqual(self.client.post('/financial-subscriptions', json=fields).status_code, 201)
        self.assertEqual(self.calls[-1][1]['p_action'], 'purchase')
        self.assertEqual(self.client.post(f'/financial-subscriptions/{self.target}/cancel', json={'requestKey': str(uuid4()), 'kind': 'GYM', 'reason': 'Member request'}).status_code, 200)
        self.assertEqual(self.client.post(f'/financial-members/{self.target}/restore', json={'requestKey': str(uuid4()), 'reason': 'Member returned'}).status_code, 200)

    def test_receptionists_can_collect_but_cannot_read_reports_or_mutate_expenses(self):
        self.auth.db.rows['role_assignments'][0]['role'] = 'admin'
        self.assertEqual(self.client.get('/fees-due').status_code, 200)
        self.assertEqual(self.client.post(f'/fees-due/{self.target}/payments', json=self.fields).status_code, 201)
        self.calls.clear()
        for url in ['/finances', '/finances/export']:
            self.assertEqual(self.client.get(url).status_code, 403)
        self.assertEqual(self.client.post('/financial-expenses', json={**self.fields}).status_code, 403)
        self.assertEqual(self.calls, [])

    def test_trainers_and_logged_out_sessions_cannot_access_financial_data(self):
        self.auth.db.rows['role_assignments'][0].update(role='trainer', trainer_id=str(uuid4()))
        self.assertEqual(self.client.get('/fees-due').status_code, 403)
        self.assertEqual(self.client.get('/finances').status_code, 403)
        self.assertEqual(self.client.post(f'/fees-due/{self.target}/payments', json=self.fields).status_code, 403)
        self.client.cookies.clear()
        self.assertEqual(self.client.get('/fees-due').status_code, 401)
        self.assertEqual(self.calls, [])

    def test_cross_origin_and_spoofed_actor_are_rejected_before_database(self):
        url = f'/fees-due/{self.target}/payments'
        self.assertEqual(self.client.post(url, json=self.fields, headers={'Origin': 'https://evil.example'}).status_code, 403)
        self.assertEqual(self.client.post(url, json={**self.fields, 'actorId': str(uuid4())}).status_code, 422)
        self.assertEqual(self.client.post(url, json={**self.fields, 'amount': 10.10}).status_code, 422)
        self.assertEqual(self.calls, [])

    def test_filters_dates_limits_and_uuid_validation(self):
        for query in ['page=0', 'pageSize=101', 'direction=bad', 'memberId=bad', 'unknown=x']:
            self.assertEqual(self.client.get('/fees-due?' + query).status_code, 422)
        for query in ['start=2023-02-29', 'start=2025-01-01&end=2024-01-01', 'start=1900-01-01&end=2026-01-01']:
            self.assertEqual(self.client.get('/finances?' + query).status_code, 422)
        self.assertEqual(self.calls, [])
        self.assertEqual(self.client.get('/fees-due?sort=unknown').status_code, 422)

    def test_errors_expose_no_sql_and_preserve_retryable_conflicts(self):
        for code, status in [('42501', 403), ('P0002', 404), ('22023', 422), ('23505', 409), ('23514', 409), ('40001', 409), ('40P01', 409), ('PGRST202', 503)]:
            self.failure = APIError({'code': code, 'message': 'secret SQL internals', 'hint': None, 'details': None})
            response = self.client.post(f'/fees-due/{self.target}/payments', json=self.fields)
            self.assertEqual(response.status_code, status)
            self.assertNotIn('secret SQL', response.text)
        self.failure = TimeoutError('network timeout after commit')
        response = self.client.post(f'/fees-due/{self.target}/payments', json=self.fields)
        self.assertEqual(response.status_code, 503)
        self.assertIn('original request key', response.text)

    def test_csv_uses_all_filtered_rows_and_not_only_current_page(self):
        response = self.client.get('/finances/export?start=2024-02-01&end=2024-03-31&pageSize=1&type=payment')
        self.assertEqual(response.status_code, 200)
        self.assertIn('text/csv', response.headers['content-type'])
        self.assertIn("'=formula", response.text)
        self.assertNotIn('Room rent', response.text)

    def test_retries_pass_same_key_and_payload_without_in_process_ledger(self):
        url = f'/fees-due/{self.target}/payments'
        self.client.post(url, json=self.fields)
        self.client.post(url, json=self.fields)
        self.assertEqual(self.calls[0], self.calls[1])
        # Exactly-once behavior is the SQL RPC's responsibility, not proven by this mock.

    def test_pending_request_lookup_is_scoped_to_live_actor(self):
        response = self.client.get('/financial-requests/' + self.fields['requestKey'])
        self.assertEqual(response.status_code, 200)
        self.assertEqual(self.calls[-1], ('financial_request_status', {'p_actor_id': self.auth.db.user_id, 'p_request_key': self.fields['requestKey']}))

    def test_historical_charge_approval_is_owner_only_and_reasoned(self):
        path = f'/financial-subscriptions/{self.target}/bill'
        fields = {'requestKey': str(uuid4()), 'kind': 'GYM', 'reason': 'Verified unbilled historical purchase'}
        self.assertEqual(self.client.post(path, json=fields).status_code, 201)
        self.assertEqual(self.calls[-1][1]['p_action'], 'legacy_bill')
        self.auth.db.rows['role_assignments'][0]['role'] = 'admin'
        self.assertEqual(self.client.post(path, json=fields).status_code, 403)

    def test_openapi_documents_real_financial_responses_and_closed_decimal_commands(self):
        schema = self.client.get('/openapi.json').json()
        self.assertIn('/fees-due/{invoice_id}/payments', schema['paths'])
        self.assertIn('FinanceResponse', schema['components']['schemas'])
        command = schema['components']['schemas']['PaymentCreate']
        self.assertFalse(command['additionalProperties'])
        self.assertEqual(command['properties']['amount']['type'], 'string')
