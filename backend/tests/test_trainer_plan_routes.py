import importlib.util
from pathlib import Path
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4
from postgrest.exceptions import APIError
import test_auth_routes


class TrainerPlanRoutesTests(unittest.TestCase):
    def setUp(self):
        self.auth = test_auth_routes.AuthRoutesTests()
        self.auth.setUp()
        self.calls = []
        self.failure = None
        self.plan = {"id": str(uuid4()), "name": "PT Essential", "price": 1000,
                     "duration": 30, "durationUnit": "DAY", "description": "",
                     "isActive": True, "activeMembersCount": 2, "hasHistory": True}

        def rpc(name, params):
            def execute():
                self.calls.append((name, params))
                if self.failure:
                    raise self.failure
                if params.get("p_action") == "delete":
                    return SimpleNamespace(data={"id": self.plan["id"], "mode": "REMOVED_FROM_CATALOG"})
                return SimpleNamespace(data=[self.plan] if name == "workout_zone_list_trainer_plans" else self.plan)
            return SimpleNamespace(execute=execute)

        config = ModuleType("config")
        config.supabase = SimpleNamespace(rpc=rpc)
        spec = importlib.util.spec_from_file_location("trainer_plan_routes_under_test", Path(__file__).parents[1]/"Routes"/"trainerPlanRoutes.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict("sys.modules", {"config": config, "Routes.authRoutes": self.auth.routes}):
            spec.loader.exec_module(module)
        self.auth.app.include_router(module.router)
        self.client = self.auth.client
        self.client.headers["Origin"] = self.auth.routes.frontend_url
        self.auth.callback()
        self.path = "/personal-training-plans"
        self.item = self.path + "/" + self.plan["id"]

    def test_crud_uses_session_actor_and_partial_fields(self):
        self.assertEqual(self.client.get(self.path).status_code, 200)
        response = self.client.get(self.item)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("trainerId", response.json())
        self.assertEqual(self.client.post(self.path, json={"name": " Free trial ", "price": 0, "duration": 7}).status_code, 201)
        self.assertEqual(self.calls[-1][1]["p_fields"]["name"], "Free trial")
        self.assertEqual(self.calls[-1][1]["p_actor_id"], self.auth.db.user_id)
        self.assertEqual(self.client.patch(self.item, json={"isActive": False}).status_code, 200)
        self.assertEqual(self.calls[-1][1]["p_fields"], {"isActive": False})
        self.assertEqual(self.client.delete(self.item).json()["mode"], "REMOVED_FROM_CATALOG")

    def test_validation_rejects_ownership_readonly_nulls_and_invalid_terms(self):
        for fields in [{"trainerId": str(uuid4())}, {"activeMembersCount": 9}, {"name": " "},
                       {"price": -1}, {"price": "1.001"}, {"duration": 1.5}, {"duration": 0},
                       {"durationUnit": "MONTH"}, {"isActive": "false"}, {"description": None}]:
            response = self.client.post(self.path, json={"name": "PT", "price": 1, "duration": 30, **fields})
            self.assertEqual(response.status_code, 422, response.text)
        for fields in [{}, {"price": None}, {"trainerId": str(uuid4())}]:
            self.assertEqual(self.client.patch(self.item, json=fields).status_code, 422)
        self.assertEqual(self.client.get(self.path+"/bad-id").status_code, 422)
        self.assertEqual(self.calls, [])

    def test_live_roles_and_logout_are_enforced(self):
        self.auth.db.rows["role_assignments"][0]["role"] = "admin"
        self.assertEqual(self.client.get(self.path).status_code, 200)
        self.calls.clear()
        self.auth.db.rows["role_assignments"][0].update(role="trainer", trainer_id=str(uuid4()))
        self.assertEqual(self.client.get(self.path).status_code, 403)
        self.assertEqual(self.client.delete(self.item).status_code, 403)
        self.client.cookies.clear()
        self.assertEqual(self.client.get(self.path).status_code, 401)
        self.assertEqual(self.calls, [])

    def test_mutations_reject_foreign_origins(self):
        for method, path, body in [("post", self.path, {"name":"PT", "price":1, "duration":30}),
                                   ("patch", self.item, {"price":2}), ("delete", self.item, None)]:
            kwargs = {"headers": {"Origin":"https://evil.example"}}
            if body is not None:
                kwargs["json"] = body
            self.assertEqual(getattr(self.client, method)(path, **kwargs).status_code, 403)
        self.assertEqual(self.calls, [])

    def test_safe_database_error_mapping(self):
        for code, status in [("23505",409),("23503",409),("P0002",404),("42501",403),("22023",422),("PGRST202",503)]:
            self.failure = APIError({"code":code,"message":"private SQL details","hint":None,"details":None})
            response = self.client.get(self.path)
            self.assertEqual(response.status_code, status)
            self.assertNotIn("private SQL", response.text)
