import importlib.util
from pathlib import Path
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4
from postgrest.exceptions import APIError
import test_auth_routes
from schemas.trainer_management import TrainerCreate, TrainerPatch


class TrainerManagementRoutesTests(unittest.TestCase):
    def setUp(self):
        self.auth = test_auth_routes.AuthRoutesTests()
        self.auth.setUp()
        self.calls = []
        self.failure = None
        self.profile = {"id":str(uuid4()),"name":"Coach","email":"contact@example.com","phone":"",
                        "isActive":True,"assignedMembersCount":2,"activeMembersCount":1,"hasLoginAccess":False}
        self.rule = {"id":str(uuid4()),"kind":"percent","value":40,"effectiveFrom":"2099-01-01","effectiveUntil":None}

        def rpc(name, params):
            def execute():
                self.calls.append((name,params))
                if self.failure:
                    raise self.failure
                if name == "workout_zone_list_trainers":
                    result = [self.profile]
                elif name == "workout_zone_get_trainer":
                    result = {"trainer":self.profile,"assignments":[],"payoutRules":None}
                elif name == "workout_zone_schedule_trainer_commission":
                    result = self.rule
                else:
                    result = self.profile
                return SimpleNamespace(data=result)
            return SimpleNamespace(execute=execute)

        config = ModuleType("config")
        config.supabase = SimpleNamespace(rpc=rpc)
        spec = importlib.util.spec_from_file_location("trainer_management_routes_under_test",Path(__file__).parents[1]/"Routes"/"trainerManagementRoutes.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict("sys.modules",{"config":config,"Routes.authRoutes":self.auth.routes}):
            spec.loader.exec_module(module)
        self.auth.app.include_router(module.router)
        self.client = self.auth.client
        self.client.headers["Origin"] = self.auth.routes.frontend_url
        self.auth.callback()
        self.item = "/trainers/" + self.profile["id"]

    def test_staff_crud_uses_verified_actor_and_partial_writes(self):
        self.assertEqual(self.client.get("/trainers").status_code,200)
        response = self.client.get(self.item)
        self.assertEqual(response.status_code,200)
        self.assertIsNone(response.json()["payoutRules"])
        response = self.client.post("/trainers",json={"name":" New Coach ","phone":"98765 43210"})
        self.assertEqual(response.status_code,201,response.text)
        self.assertEqual(self.calls[-1][1]["p_actor_id"],self.auth.db.user_id)
        self.assertEqual(self.calls[-1][1]["p_fields"],{"name":"New Coach","email":"","phone":"+919876543210","isActive":True})
        self.assertEqual(self.client.patch(self.item,json={"isActive":False}).status_code,200)
        self.assertEqual(self.calls[-1][1]["p_fields"],{"isActive":False})
        self.assertEqual(self.client.delete(self.item).status_code,405)

    def test_profile_validation_normalizes_contacts_and_rejects_identity_and_readonly_fields(self):
        for fields in [{"name":" "},{"email":"bad"},{"phone":"12"},{"isActive":"true"},{"userId":str(uuid4())},
                       {"google_subject":"spoof"},{"role":"owner"},{"activeMembersCount":99},{"hasLoginAccess":True}]:
            response = self.client.post("/trainers",json={"name":"Coach",**fields})
            self.assertEqual(response.status_code,422,response.text)
        for fields in [{},{"name":None},{"email":None}]:
            self.assertEqual(self.client.patch(self.item,json=fields).status_code,422)
        self.assertEqual(self.client.get("/trainers/bad-id").status_code,422)
        self.assertEqual(self.calls,[])
        self.assertEqual(str(TrainerCreate(name="Coach",email=" Contact@EXAMPLE.com ").email),"contact@example.com")
        self.assertEqual(TrainerPatch(email="",phone="").model_dump(exclude_unset=True),{"email":"","phone":""})

    def test_receptionist_can_manage_profiles_but_not_financial_rules(self):
        self.auth.db.rows["role_assignments"][0]["role"] = "admin"
        self.assertEqual(self.client.get("/trainers").status_code,200)
        self.assertEqual(self.client.post("/trainers",json={"name":"Coach"}).status_code,201)
        self.calls.clear()
        response = self.client.post(self.item+"/commission-rules",json={"commissionRate":40,"effectiveFrom":"2099-01-01"})
        self.assertEqual(response.status_code,403)
        self.assertEqual(self.calls,[])

    def test_trainer_and_logged_out_sessions_cannot_open_staff_directory(self):
        self.auth.db.rows["role_assignments"][0].update(role="trainer",trainer_id=str(uuid4()))
        self.assertEqual(self.client.get("/trainers").status_code,403)
        self.assertEqual(self.client.patch(self.item,json={"isActive":False}).status_code,403)
        self.client.cookies.clear()
        self.assertEqual(self.client.get(self.item).status_code,401)
        self.assertEqual(self.calls,[])

    def test_commission_contract_uses_decimal_rate_and_explicit_effective_dates(self):
        response = self.client.post(self.item+"/commission-rules",json={"commissionRate":55.25,"effectiveFrom":"2099-01-01"})
        self.assertEqual(response.status_code,201,response.text)
        self.assertEqual(self.calls[-1][1]["p_rate"],"55.25")
        self.assertEqual(self.calls[-1][1]["p_start"],"2099-01-01")
        self.assertIsNone(self.calls[-1][1]["p_end"])
        for fields in [{"commissionRate":101},{"commissionRate":40.001},{"effectiveFrom":"bad"},
                       {"effectiveUntil":"2098-01-01"},{"kind":"fixed"},{"actorId":str(uuid4())}]:
            response = self.client.post(self.item+"/commission-rules",json={"commissionRate":40,"effectiveFrom":"2099-01-01",**fields})
            self.assertEqual(response.status_code,422,response.text)

    def test_foreign_origins_are_rejected_before_profile_and_commission_writes(self):
        for path,body in [("/trainers",{"name":"Coach"}),(self.item+"/commission-rules",{"commissionRate":40,"effectiveFrom":"2099-01-01"})]:
            self.assertEqual(self.client.post(path,json=body,headers={"Origin":"https://evil.example"}).status_code,403)
        self.assertEqual(self.client.patch(self.item,json={"isActive":False},headers={"Origin":"https://evil.example"}).status_code,403)
        self.assertEqual(self.calls,[])

    def test_database_errors_are_safe_and_explicit(self):
        for code,status in [("42501",403),("P0002",404),("22023",422),("23P01",409),("PGRST202",503)]:
            self.failure = APIError({"code":code,"message":"private SQL details","hint":None,"details":None})
            response = self.client.get("/trainers")
            self.assertEqual(response.status_code,status)
            self.assertNotIn("private SQL",response.text)
