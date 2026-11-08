import importlib.util
from pathlib import Path
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4
from postgrest.exceptions import APIError
import test_auth_routes


class MemberRoutesTests(unittest.TestCase):
    def setUp(self):
        self.auth = test_auth_routes.AuthRoutesTests()
        self.auth.setUp()
        self.calls = []
        self.failure = None
        self.member = {"id":str(uuid4()),"memberNumber":"WZ001","fullName":"Member","email":"","phone":"",
                       "joiningDate":"2026-01-01","status":"ACTIVE","notes":""}
        self.fields = {"requestKey":str(uuid4()),"fullName":" New Member ","joiningDate":"2026-01-01",
                       "planId":str(uuid4()),"startDate":"2026-01-01","trainerId":"","ptPlanId":"","ptStartDate":"2026-01-01"}

        def rpc(name, params):
            def execute():
                self.calls.append((name,params))
                if self.failure:
                    raise self.failure
                if name == "workout_zone_list_members":
                    result = {"members":[{**self.member,"gym":None,"pt":None,"membershipStatus":"No plan","outstandingAmount":0}],
                              "summary":{"activeMembers":0,"expiringSoon":0,"expiredMemberships":0,"outstandingAmount":0}}
                elif name == "workout_zone_member_options":
                    result = {"membershipPlans":[],"personalTrainingPlans":[],"trainers":[]}
                elif name == "workout_zone_get_member":
                    result = {"member":self.member,"subscriptions":[],"invoices":[],"payments":[]}
                elif params.get("p_action") == "delete":
                    result = {"id":self.member["id"],"mode":"REMOVED_FROM_DIRECTORY"}
                else:
                    result = self.member
                return SimpleNamespace(data=result)
            return SimpleNamespace(execute=execute)

        config = ModuleType("config")
        config.supabase = SimpleNamespace(rpc=rpc)
        spec = importlib.util.spec_from_file_location("member_routes_under_test",Path(__file__).parents[1]/"Routes"/"memberRoutes.py")
        module = importlib.util.module_from_spec(spec)
        with patch.dict("sys.modules",{"config":config,"Routes.authRoutes":self.auth.routes}):
            spec.loader.exec_module(module)
        self.auth.app.include_router(module.router)
        self.client = self.auth.client
        self.client.headers["Origin"] = self.auth.routes.frontend_url
        self.auth.callback()
        self.item = "/members/" + self.member["id"]

    def test_list_options_and_details_have_dedicated_contracts_and_session_actor(self):
        self.assertEqual(self.client.get("/members").status_code,200)
        self.assertEqual(self.client.get("/members/options").status_code,200)
        self.assertEqual(self.calls[-1][0],"workout_zone_member_options")
        self.assertEqual(self.client.get(self.item).status_code,200)
        self.assertEqual(self.calls[-1][1]["p_actor_id"],self.auth.db.user_id)

    def test_create_normalizes_optional_contacts_and_separates_idempotency_key(self):
        response = self.client.post("/members",json={**self.fields,"phone":"98765 43210"})
        self.assertEqual(response.status_code,201,response.text)
        params = self.calls[-1][1]
        self.assertEqual(params["p_request_key"],self.fields["requestKey"])
        self.assertNotIn("requestKey",params["p_fields"])
        self.assertEqual(params["p_fields"]["fullName"],"New Member")
        self.assertEqual(params["p_fields"]["phone"],"+919876543210")
        self.assertIsNone(params["p_fields"]["trainerId"])
        self.assertIsNone(params["p_fields"]["ptStartDate"])

    def test_patch_only_accepts_profile_fields_and_delete_explains_retention(self):
        self.assertEqual(self.client.patch(self.item,json={"notes":" Updated "}).status_code,200)
        self.assertEqual(self.calls[-1][1]["p_fields"],{"notes":"Updated"})
        self.assertEqual(self.client.patch(self.item,json={"email":"","phone":""}).status_code,200)
        self.assertEqual(self.client.delete(self.item).json()["mode"],"REMOVED_FROM_DIRECTORY")
        for fields in [{},{"planId":str(uuid4())},{"joiningDate":None},{"priceAtPurchase":0},{"status":"inactive"}]:
            self.assertEqual(self.client.patch(self.item,json=fields).status_code,422)

    def test_invalid_create_dates_ids_ownership_and_price_overrides_are_rejected(self):
        for fields in [{"fullName":" "},{"email":"bad"},{"phone":"12"},{"requestKey":"bad"},
                       {"trainerId":str(uuid4())},{"ptPlanId":str(uuid4())},{"joiningDate":"2026-01-02"},{"joiningDate":0},
                       {"price":1},{"endDate":"2026-02-01"},{"actorId":str(uuid4())},{"memberNumber":"spoof"}]:
            response = self.client.post("/members",json={**self.fields,**fields})
            self.assertEqual(response.status_code,422,response.text)
        self.assertEqual(self.client.get("/members/bad-id").status_code,422)
        self.assertEqual(self.calls,[])

    def test_receptionist_allowed_but_trainers_and_logged_out_sessions_denied(self):
        self.auth.db.rows["role_assignments"][0]["role"] = "admin"
        self.assertEqual(self.client.get("/members").status_code,200)
        self.calls.clear()
        self.auth.db.rows["role_assignments"][0].update(role="trainer",trainer_id=str(uuid4()))
        self.assertEqual(self.client.get("/members").status_code,403)
        self.assertEqual(self.client.get(self.item).status_code,403)
        self.assertEqual(self.client.delete(self.item).status_code,403)
        self.client.cookies.clear()
        self.assertEqual(self.client.get("/members").status_code,401)
        self.assertEqual(self.calls,[])

    def test_foreign_origins_are_rejected_for_all_writes(self):
        headers = {"Origin":"https://evil.example"}
        self.assertEqual(self.client.post("/members",json=self.fields,headers=headers).status_code,403)
        self.assertEqual(self.client.patch(self.item,json={"notes":"x"},headers=headers).status_code,403)
        self.assertEqual(self.client.delete(self.item,headers=headers).status_code,403)
        self.assertEqual(self.calls,[])

    def test_database_errors_are_safe_and_report_retry_conflicts(self):
        for code,status in [("42501",403),("P0002",404),("22023",422),("23505",409),("23514",409),("23503",409),("PGRST202",503)]:
            self.failure = APIError({"code":code,"message":"private SQL details","hint":None,"details":None})
            response = self.client.get("/members")
            self.assertEqual(response.status_code,status)
            self.assertNotIn("private SQL",response.text)
