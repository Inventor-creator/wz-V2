import importlib.util
from pathlib import Path
from types import ModuleType,SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4
from postgrest.exceptions import APIError
import test_auth_routes

class TrainerRoutesTests(unittest.TestCase):
    def setUp(self):
        self.auth=test_auth_routes.AuthRoutesTests();self.auth.setUp()
        self.calls=[];self.failure=None
        self.trainer_id=str(uuid4())
        self.profile={'id':self.trainer_id,'name':'Coach','email':'coach@example.com','phone':'','isActive':True}
        self.data={'trainer':self.profile,'summary':{'totalAssignedMembers':0,'activeTrainingMembers':0,'planValue':0,'estimatedPayout':None,'payoutStatus':'NOT_CONFIGURED','payoutNote':'No rule','periodStart':'2026-11-01','periodEnd':'2026-11-02'},'rows':[],'plans':[],'total':0,'page':1,'pageSize':8}
        def rpc(name,params):
            def execute():
                self.calls.append((name,params))
                if self.failure:raise self.failure
                return SimpleNamespace(data=[self.profile] if name=='workout_zone_trainer_options' else self.data)
            return SimpleNamespace(execute=execute)
        config=ModuleType('config');config.supabase=SimpleNamespace(rpc=rpc)
        spec=importlib.util.spec_from_file_location('trainer_routes_under_test',Path(__file__).parents[1]/'Routes'/'trainerRoutes.py')
        module=importlib.util.module_from_spec(spec)
        with patch.dict('sys.modules',{'config':config,'Routes.authRoutes':self.auth.routes}):spec.loader.exec_module(module)
        self.auth.app.include_router(module.router);self.client=self.auth.client;self.auth.callback()

    def test_owner_can_select_trainer_and_use_validated_filters(self):
        response=self.client.get('/trainer/dashboard',params={'trainerId':self.trainer_id,'search':'Member','status':'Expired','page':2})
        self.assertEqual(response.status_code,200,response.text)
        _,args=self.calls[-1];self.assertEqual(args['p_actor_id'],self.auth.db.user_id);self.assertEqual(args['p_trainer_id'],self.trainer_id);self.assertEqual(args['p_page'],2)

    def test_trainer_scope_is_derived_from_session_user_not_a_client_actor(self):
        self.auth.db.rows['role_assignments'][0].update(role='trainer',trainer_id=self.trainer_id)
        self.assertEqual(self.client.get('/trainer/dashboard').status_code,200)
        self.assertEqual(self.calls[-1][1]['p_actor_id'],self.auth.db.user_id)
        self.assertIsNone(self.calls[-1][1]['p_trainer_id'])
        self.assertEqual(self.client.get('/trainer/options').json()[0]['id'],self.trainer_id)

    def test_receptionist_revoked_and_unauthenticated_accounts_are_denied(self):
        self.auth.db.rows['role_assignments'][0]['role']='admin'
        self.assertEqual(self.client.get('/trainer/dashboard').status_code,403)
        self.client.cookies.clear();self.assertEqual(self.client.get('/trainer/options').status_code,401)
        self.assertEqual(self.calls,[])

    def test_bad_filters_are_rejected_before_querying(self):
        for params in ({'trainerId':'invalid'},{'page':0},{'pageSize':101},{'status':'unknown'},{'search':'x'*121}):
            self.assertEqual(self.client.get('/trainer/dashboard',params=params).status_code,422)
        self.assertEqual(self.calls,[])

    def test_scope_errors_never_fall_back_to_unscoped_data(self):
        for code,status in [('42501',403),('P0002',404),('PGRST202',503)]:
            self.failure=APIError({'code':code,'message':'private SQL info','hint':None,'details':None})
            response=self.client.get('/trainer/dashboard');self.assertEqual(response.status_code,status);self.assertNotIn('private SQL',response.text)
