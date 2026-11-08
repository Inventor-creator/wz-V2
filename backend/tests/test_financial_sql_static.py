"""Static checks only. Never connect to PostgreSQL or execute a migration."""
from pathlib import Path
import unittest


class FinancialSQLStaticTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.sql = (Path(__file__).parents[1]/'migrations'/'009_fees_and_finances.sql').read_text()

    def test_migration_is_transactional_additive_and_preserves_posted_history(self):
        self.assertIn('BEGIN;', self.sql)
        self.assertTrue(self.sql.rstrip().endswith('COMMIT;'))
        for forbidden in ['DROP TABLE', 'TRUNCATE ', 'DELETE FROM public.payments', 'DELETE FROM public.invoices']:
            self.assertNotIn(forbidden, self.sql)
        self.assertIn('financial_immutable', self.sql)
        self.assertIn('CREATE TABLE public.refund_allocations', self.sql)

    def test_idempotency_authorization_locks_and_provenance_are_present(self):
        for required in ['request_key uuid PRIMARY KEY', 'prior.fields<>p_fields', 'prior.actor_id<>p_actor_id',
                         'workout-zone-members', 'workout-zone-financials', 'FOR UPDATE',
                         'financial_require_actor', 'REVOKE ALL ON FUNCTION', 'SECURITY DEFINER SET search_path=pg_catalog,public',
                         'financial_refund_total_integrity', 'financial_adjustment_integrity',
                         'Trainer settlement review required', 'expense.version', 'Duplicate purchase']:
            self.assertIn(required, self.sql)

    def test_optional_postgresql_parser_only_never_executes_sql(self):
        try:
            from pglast import parse_sql
            from pglast.parser import parse_plpgsql_json
        except ImportError:
            self.skipTest('Optional static pglast parser not on PYTHONPATH')
        self.assertGreater(len(parse_sql(self.sql)), 30)
        self.assertIn('PLpgSQL_function', parse_plpgsql_json(self.sql))
