import importlib.util
from pathlib import Path
from types import ModuleType,SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4
from postgrest.exceptions import APIError
import test_auth_routes

class MembershipRoutesTests(unittest.TestCase):
    def setUp(self):
        self.auth=test_auth_routes.AuthRoutesTests();self.auth.setUp();self.calls=[];self.failure=None
        self.record={'id':str(uuid4()),'name':'30-day Essential','price':1000,'duration':30,'durationUnit':'DAY','description':'','isActive':True,'activeMembersCount':1,'hasHistory':True}
        def rpc(name,params):
            def execute():
                self.calls.append((name,params))
                if self.failure:raise self.failure
                if params.get('p_action')=='delete':return SimpleNamespace(data={'id':self.record['id'],'mode':'REMOVED_FROM_CATALOG'})
                return SimpleNamespace(data=[self.record] if name=='workout_zone_list_membership_plans' else self.record)
            return SimpleNamespace(execute=execute)
        config=ModuleType('config');config.supabase=SimpleNamespace(rpc=rpc)
        spec=importlib.util.spec_from_file_location('membership_routes_under_test',Path(__file__).parents[1]/'Routes'/'membershipRoutes.py')
        module=importlib.util.module_from_spec(spec)
        with patch.dict('sys.modules',{'config':config,'Routes.authRoutes':self.auth.routes}):spec.loader.exec_module(module)
        self.auth.app.include_router(module.router);self.client=self.auth.client;self.client.headers['Origin']=self.auth.routes.frontend_url;self.auth.callback()

    def test_list_and_get_use_live_session_actor(self):
        self.assertEqual(self.client.get('/membership-plans').status_code,200)
        self.assertEqual(self.client.get('/membership-plans/'+self.record['id']).status_code,200)
        self.assertEqual(self.calls[-1][1]['p_actor_id'],self.auth.db.user_id)

    def test_create_supports_free_plans_fixed_days_and_trimmed_names(self):
        response=self.client.post('/membership-plans',json={'name':' Trial ','price':0,'duration':7})
        self.assertEqual(response.status_code,201,response.text)
        fields=self.calls[-1][1]['p_fields'];self.assertEqual(fields['name'],'Trial');self.assertEqual(fields['durationUnit'],'DAY');self.assertEqual(float(fields['price']),0)

    def test_patch_is_partial_and_delete_reports_history_preservation(self):
        path='/membership-plans/'+self.record['id']
        self.assertEqual(self.client.patch(path,json={'isActive':False}).status_code,200)
        self.assertEqual(self.calls[-1][1]['p_fields'],{'isActive':False})
        response=self.client.delete(path);self.assertEqual(response.status_code,200);self.assertEqual(response.json()['mode'],'REMOVED_FROM_CATALOG')

    def test_invalid_values_and_readonly_fields_are_rejected(self):
        for fields in ({'name':' '},{'price':-1},{'price':'1.001'},{'duration':0},{'duration':1.5},{'durationUnit':'MONTH'},{'isActive':'false'},{'activeMembersCount':10},{'createdBy':str(uuid4())}):
            response=self.client.post('/membership-plans',json={'name':'Plan','price':100,'duration':30,**fields});self.assertEqual(response.status_code,422,response.text)
        self.assertEqual(self.client.patch('/membership-plans/'+self.record['id'],json={}).status_code,422)
        self.assertEqual(self.client.get('/membership-plans/invalid-id').status_code,422)
        self.assertEqual(self.calls,[])

    def test_receptionist_allowed_trainer_and_logged_out_denied(self):
        self.auth.db.rows['role_assignments'][0]['role']='admin';self.assertEqual(self.client.get('/membership-plans').status_code,200)
        self.calls.clear();self.auth.db.rows['role_assignments'][0].update(role='trainer',trainer_id=str(uuid4()))
        self.assertEqual(self.client.get('/membership-plans').status_code,403);self.assertEqual(self.client.delete('/membership-plans/'+self.record['id']).status_code,403)
        self.client.cookies.clear();self.assertEqual(self.client.get('/membership-plans').status_code,401);self.assertEqual(self.calls,[])

    def test_bad_origin_is_denied_before_writes(self):
        self.assertEqual(self.client.delete('/membership-plans/'+self.record['id'],headers={'Origin':'https://evil.example'}).status_code,403);self.assertEqual(self.calls,[])

    def test_database_errors_are_safe_and_actionable(self):
        for code,status in [('23505',409),('P0002',404),('42501',403),('22023',422),('PGRST202',503)]:
            self.failure=APIError({'code':code,'message':'private database details','hint':None,'details':None})
            response=self.client.get('/membership-plans');self.assertEqual(response.status_code,status);self.assertNotIn('private database',response.text)
