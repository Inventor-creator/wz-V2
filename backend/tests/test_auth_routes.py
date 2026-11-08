"""Offline route regression tests; no Google or Supabase credentials required."""

import importlib.util
from pathlib import Path
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch
from uuid import uuid4
from threading import Barrier, Lock
from concurrent.futures import ThreadPoolExecutor

from fastapi import Depends, FastAPI, HTTPException
from fastapi.testclient import TestClient
from postgrest.exceptions import APIError
from starlette.middleware.sessions import SessionMiddleware


class Query:
    def __init__(self, db, table):
        self.db, self.table = db, table
        self.filters, self.values, self.new_row = [], None, None

    def select(self, columns):
        allowed = {
            "users": {"id", "email", "google_subject", "active", "display_name"},
            "role_assignments": {"role", "trainer_id"},
        }
        assert set(columns.split(",")) <= allowed[self.table], columns
        return self

    def eq(self, key, value):
        self.filters.append((key, value))
        return self

    def is_(self, key, value):
        assert value == "null"
        return self.eq(key, None)

    def ilike(self, key, value):
        self.filters.append(('lower:' + key, value.replace('\\_', '_').replace('\\%', '%').lower()))
        return self

    def insert(self, values):
        self.new_row = values
        return self

    def limit(self, count):
        return self

    def update(self, values):
        # New auth must not write nonexistent full_name/picture/google_id columns.
        assert set(values) <= {"google_subject", "active", "display_name"}
        self.values = values
        return self

    def execute(self):
        if self.db.fail:
            raise APIError({"message": "Database unavailable", "code": "42703", "hint": None, "details": None})
        if self.new_row is not None and self.db.before_insert:
            self.db.before_insert.wait(timeout=5)
        with self.db.lock:
            if self.new_row is not None:
                if any(r['email'].lower() == self.new_row['email'].lower() or r.get('google_subject') == self.new_row['google_subject'] for r in self.db.rows[self.table]):
                    raise APIError({'message':'duplicate identity','code':'23505','hint':None,'details':None})
                row = {'id':str(uuid4()), **self.new_row}
                self.db.rows[self.table].append(row)
                return SimpleNamespace(data=[dict(row)])
            def matches(row):
                return all((str(row.get(k[6:], '')).lower() if k.startswith('lower:') else row.get(k)) == v for k, v in self.filters)
            rows = [row for row in self.db.rows[self.table] if matches(row)]
            if self.values:
                for row in rows:
                    row.update(self.values)
            return SimpleNamespace(data=[dict(row) for row in rows])


class Database:
    def __init__(self):
        self.user_id = str(uuid4())
        self.rows = {
            "users": [{"id": self.user_id, "email": "owner@example.com", "google_subject": "google-123", "active": True}],
            "role_assignments": [{"user_id": self.user_id, "role": "owner", "trainer_id": None, "revoked_at": None}],
        }
        self.fail = False
        self.lock = Lock()
        self.before_insert = None

    def table(self, name):
        return Query(self, name)


class AuthRoutesTests(unittest.TestCase):
    def setUp(self):
        self.db = Database()
        self.google = SimpleNamespace(authorize_access_token=AsyncMock(return_value={"userinfo": {
            "sub": "google-123", "email": "owner@example.com", "email_verified": True,
            "name": "Test Owner", "picture": "https://example.com/avatar.png",
        }}))
        self.claims = dict(self.google.authorize_access_token.return_value['userinfo'])
        self.google.authorize_access_token.return_value['id_token'] = 'signed-token-placeholder'
        config = ModuleType("config")
        config.supabase = self.db
        config.SUPER_ADMIN_EMAIL = 'aryapat1234@gmail.com'
        service = ModuleType("authService")
        service.oauth = SimpleNamespace(google=self.google)
        service.verify_google_id_token = lambda raw: self.claims
        spec = importlib.util.spec_from_file_location("auth_routes_under_test", Path(__file__).parents[1] / "Routes" / "authRoutes.py")
        self.routes = importlib.util.module_from_spec(spec)
        with patch.dict("sys.modules", {"config": config, "authService": service}):
            spec.loader.exec_module(self.routes)
        app = FastAPI()
        app.add_middleware(SessionMiddleware, secret_key="offline-test-secret")
        app.include_router(self.routes.router)
        @app.get('/test-owner-only')
        async def protected(user: dict = Depends(self.routes.require_roles('GYM_OWNER'))):
            return {'role':user['role']}
        self.app = app
        self.client = TestClient(app)

    def callback(self):
        return self.client.get("/auth/callback", follow_redirects=False)

    def test_existing_subject_signs_in_and_me_returns_frontend_role(self):
        self.assertEqual(self.callback().headers["location"], self.routes.frontend_url + "/finances")
        response = self.client.get("/auth/me")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["role"], "GYM_OWNER")
        self.assertEqual(response.json()["status"], "ACTIVE")
        self.assertEqual(response.json()["name"], "Test Owner")

    def test_pending_authorized_email_binds_subject(self):
        self.db.rows["users"][0]["google_subject"] = None
        self.callback()
        self.assertEqual(self.db.rows["users"][0]["google_subject"], "google-123")
        self.assertEqual(self.client.get("/auth/me").status_code, 200)

    def test_invited_name_placeholder_is_filled_from_verified_google_profile(self):
        self.db.rows['users'][0]['display_name']='owner@example.com'
        self.callback()
        self.assertEqual(self.db.rows['users'][0]['display_name'],'Test Owner')

    def test_does_not_replace_another_google_subject(self):
        self.db.rows["users"][0]["google_subject"] = "different-subject"
        self.assertIn("error=userNotFound", self.callback().headers["location"])
        self.assertEqual(self.db.rows["users"][0]["google_subject"], "different-subject")
        self.assertEqual(self.client.get("/auth/me").status_code, 401)

    def test_inactive_or_ungranted_accounts_are_denied(self):
        for inactive in (True, False):
            with self.subTest(inactive=inactive):
                self.db.rows["users"][0]["active"] = not inactive
                self.db.rows["role_assignments"][0]["revoked_at"] = None if inactive else "2026-11-01"
                self.assertIn("error=userNotFound", self.callback().headers["location"])

    def test_requires_verified_email(self):
        self.claims["email_verified"] = False
        self.assertIn("error=auth_failed", self.callback().headers["location"])

    def test_trainer_link_comes_from_grant(self):
        grant = self.db.rows["role_assignments"][0]
        grant.update(role="trainer", trainer_id=str(uuid4()))
        self.callback()
        self.assertEqual(self.client.get("/auth/me").json()["trainerId"], grant["trainer_id"])
        grant["trainer_id"] = None
        self.assertEqual(self.client.get("/auth/me").status_code, 403)

    def test_revocation_is_checked_after_login(self):
        self.callback()
        self.db.rows["role_assignments"][0]["revoked_at"] = "2026-11-01"
        self.assertEqual(self.client.get("/auth/me").status_code, 403)
        self.assertEqual(self.client.get("/auth/me").status_code, 401)

    def test_role_changes_are_not_cached_in_session(self):
        self.callback()
        self.db.rows["role_assignments"][0]["role"] = "admin"
        self.assertEqual(self.client.get("/auth/me").json()["role"], "GYM_RECEPTIONIST")

    def test_database_errors_redirect_without_exposing_details(self):
        self.db.fail = True
        response = self.callback()
        self.assertEqual(response.status_code, 307)
        self.assertIn("error=service_unavailable", response.headers["location"])
        self.assertNotIn("42703", response.text)

    def test_invalid_oauth_response_is_handled(self):
        self.google.authorize_access_token.side_effect = ValueError("Invalid OAuth state")
        self.assertIn("error=auth_failed", self.callback().headers["location"])

    def test_logout_clears_session(self):
        self.callback()
        self.client.get("/auth/logout", follow_redirects=False)
        self.assertEqual(self.client.get("/auth/me").status_code, 401)

    def bootstrap(self, existing=True):
        self.claims['email'] = 'aryapat1234@gmail.com'
        self.claims['sub'] = 'verified-bootstrap-subject-fixture'
        if existing:
            self.db.rows['users'][0].update(email=self.claims['email'], google_subject=None)
        self.db.rows['role_assignments'] = []

    def test_first_bootstrap_login_persists_subject_without_grants(self):
        self.bootstrap()
        before_id = self.db.rows['users'][0]['id']
        self.assertEqual(self.callback().headers['location'], self.routes.frontend_url+'/finances')
        self.assertEqual(self.db.rows['users'][0]['id'], before_id)
        self.assertEqual(self.db.rows['users'][0]['google_subject'], self.claims['sub'])
        self.assertEqual(self.client.get('/auth/me').json()['role'], 'SUPER_ADMIN')

    def test_bootstrap_session_does_not_query_a_missing_role_assignments_table(self):
        self.bootstrap()
        del self.db.rows['role_assignments']
        self.assertEqual(self.callback().headers['location'], self.routes.frontend_url+'/finances')
        first = self.client.get('/auth/me')
        second = self.client.get('/auth/me')
        self.assertEqual(first.status_code,200)
        self.assertEqual(second.status_code,200)
        self.assertEqual(second.json()['role'],'SUPER_ADMIN')

    def test_subsequent_bootstrap_login_and_ordinary_roles_cannot_override(self):
        self.bootstrap()
        self.callback()
        self.db.rows['role_assignments'] = [{'user_id':self.db.user_id,'role':'admin','trainer_id':None,'revoked_at':None}]
        self.callback()
        self.assertEqual(self.client.get('/auth/me').json()['role'], 'SUPER_ADMIN')
        self.assertEqual(self.client.get('/test-owner-only').status_code, 200)

    def test_bootstrap_is_reactivated_on_verified_login(self):
        self.bootstrap()
        self.db.rows['users'][0]['active'] = False
        self.callback()
        self.assertTrue(self.db.rows['users'][0]['active'])

    def test_missing_bootstrap_user_is_created_but_unknown_user_is_not(self):
        self.bootstrap(existing=False)
        self.callback()
        self.assertEqual(len(self.db.rows['users']),2)
        self.claims['email'] = 'unknown@example.com'
        self.assertIn('userNotFound', self.callback().headers['location'])
        self.assertEqual(len(self.db.rows['users']),2)

    def test_bootstrap_subject_mismatch_is_denied(self):
        self.bootstrap()
        self.db.rows['users'][0]['google_subject'] = 'another-subject'
        self.assertIn('userNotFound', self.callback().headers['location'])
        self.assertEqual(self.db.rows['users'][0]['google_subject'], 'another-subject')

    def test_bootstrap_access_mutation_guard_rejects_demote_and_deactivate(self):
        self.bootstrap()
        for action in ('demote','deactivate','revoke'):
            with self.subTest(action=action), self.assertRaises(HTTPException) as error:
                self.routes.reject_bootstrap_access_change(self.db.rows['users'][0])
            self.assertEqual(error.exception.status_code,403)

    def test_unverified_userinfo_is_ignored(self):
        self.google.authorize_access_token.return_value['userinfo']['email'] = 'aryapat1234@gmail.com'
        self.callback()
        self.assertEqual(self.client.get('/auth/me').json()['role'],'GYM_OWNER')

    def test_invalid_id_token_is_rejected_without_database_write(self):
        self.routes.verify_google_id_token = lambda raw: (_ for _ in ()).throw(ValueError('invalid signature'))
        self.db.rows['users'][0]['google_subject'] = None
        self.assertIn('auth_failed',self.callback().headers['location'])
        self.assertIsNone(self.db.rows['users'][0]['google_subject'])

    def test_missing_id_token_is_rejected(self):
        del self.google.authorize_access_token.return_value['id_token']
        self.assertIn('auth_failed', self.callback().headers['location'])

    def test_role_dependency_blocks_normal_admin(self):
        self.callback()
        self.db.rows['role_assignments'][0]['role'] = 'admin'
        self.assertEqual(self.client.get('/test-owner-only').status_code,403)

    def test_concurrent_bootstrap_creation_reuses_one_user(self):
        self.bootstrap(existing=False)
        self.db.before_insert = Barrier(2)
        def signin(_):
            with TestClient(self.app) as client:
                return client.get('/auth/callback',follow_redirects=False).headers['location']
        with ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(signin,range(2)))
        self.assertEqual(results,[self.routes.frontend_url+'/finances']*2)
        users = [u for u in self.db.rows['users'] if u['email'] == self.claims['email']]
        self.assertEqual(len(users),1)
        self.assertEqual(users[0]['google_subject'],self.claims['sub'])


if __name__ == "__main__":
    unittest.main()
