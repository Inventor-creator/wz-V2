"""Access HTTP contracts using real auth guards and isolated database doubles."""
import importlib.util
from pathlib import Path
from types import ModuleType, SimpleNamespace
import unittest
from unittest.mock import patch
from uuid import uuid4

from postgrest.exceptions import APIError
import test_auth_routes


class AccessRoutesTests(unittest.TestCase):
    def setUp(self):
        self.auth = test_auth_routes.AuthRoutesTests()
        self.auth.setUp()
        self.calls = []
        self.failure = None
        self.record = {
            'id':str(uuid4()),'userId':str(uuid4()),'email':'staff@example.com','name':None,
            'role':'GYM_RECEPTIONIST','status':'ACTIVE','grantedBy':'Test Owner',
            'grantedAt':'2026-11-01T10:00:00+00:00','trainerId':None,'isPermanent':False,'accountActive':True,
        }
        def rpc(name, params):
            def execute():
                self.calls.append((name,params))
                if self.failure: raise self.failure
                return SimpleNamespace(data=[self.record] if name=='workout_zone_list_access' else self.record)
            return SimpleNamespace(execute=execute)
        config=ModuleType('config')
        config.supabase=SimpleNamespace(rpc=rpc)
        spec=importlib.util.spec_from_file_location('access_routes_under_test',Path(__file__).parents[1]/'Routes'/'accessRoutes.py')
        module=importlib.util.module_from_spec(spec)
        with patch.dict('sys.modules',{'config':config,'Routes.authRoutes':self.auth.routes}):
            spec.loader.exec_module(module)
        self.auth.app.include_router(module.router)
        self.client=self.auth.client
        self.client.headers['Origin']=self.auth.routes.frontend_url
        self.auth.callback()

    def test_owner_can_list_assignments(self):
        response=self.client.get('/access-assignments')
        self.assertEqual(response.status_code,200)
        self.assertEqual(response.json()[0]['role'],'GYM_RECEPTIONIST')

    def test_logged_out_receptionist_and_trainer_are_rejected(self):
        for role in ('admin','trainer'):
            with self.subTest(role=role):
                self.auth.db.rows['role_assignments'][0].update(role=role,trainer_id=str(uuid4()) if role=='trainer' else None)
                self.assertEqual(self.client.get('/access-assignments').status_code,403)
        self.client.cookies.clear()
        self.assertEqual(self.client.get('/access-assignments').status_code,401)
        self.assertEqual(self.calls,[])

    def test_permanent_admin_can_list_without_normal_role_table(self):
        self.auth.bootstrap()
        del self.auth.db.rows['role_assignments']
        self.auth.callback()
        self.assertEqual(self.client.get('/access-assignments').status_code,200)

    def test_create_normalizes_email_and_supplies_only_session_actor(self):
        response=self.client.post('/access-assignments',json={'email':' STAFF@EXAMPLE.COM ','role':'GYM_RECEPTIONIST','trainerId':''})
        self.assertEqual(response.status_code,201,response.text)
        _,params=self.calls[-1]
        self.assertEqual(params['p_actor_id'],self.auth.db.user_id)
        self.assertEqual(params['p_email'],'staff@example.com')
        self.assertEqual(params['p_role'],'admin')

    def test_can_create_and_link_a_trainer_in_one_access_request(self):
        response=self.client.post('/access-assignments',json={'email':'newcoach@example.com','role':'GYM_TRAINER','newTrainer':{'name':'New Coach','phone':'9876543210'}})
        self.assertEqual(response.status_code,201,response.text)
        name,params=self.calls[-1]
        self.assertEqual(name,'workout_zone_grant_new_trainer')
        self.assertEqual(params['p_name'],'New Coach')
        self.assertEqual(params['p_phone'],'+919876543210')
        self.assertEqual(params['p_actor_id'],self.auth.db.user_id)

    def test_rejects_both_existing_and_new_trainer_or_nontrainer_creation(self):
        for extra in ({'trainerId':str(uuid4())},{'role':'GYM_OWNER'}):
            response=self.client.post('/access-assignments',json={'email':'newcoach@example.com','role':'GYM_TRAINER','newTrainer':{'name':'New Coach'},**extra})
            self.assertEqual(response.status_code,422)
        self.assertEqual(self.calls,[])

    def test_rejects_forged_grant_metadata_and_assignable_super_admin(self):
        for extra in ({'grantedBy':str(uuid4())},{'user_id':str(uuid4())},{'role':'SUPER_ADMIN'}):
            response=self.client.post('/access-assignments',json={'email':'staff@example.com','role':'GYM_RECEPTIONIST',**extra})
            self.assertEqual(response.status_code,422,response.text)
        self.assertEqual(self.calls,[])

    def test_requires_trainer_dependency_and_valid_uuid(self):
        for body in ({'email':'staff@example.com','role':'GYM_TRAINER'}, {'email':'staff@example.com','role':'GYM_OWNER','trainerId':str(uuid4())}):
            self.assertEqual(self.client.post('/access-assignments',json=body).status_code,422)
        self.assertEqual(self.client.patch('/access-assignments/not-a-uuid',json={'status':'REVOKED'}).status_code,422)

    def test_patch_and_revoke_reactivate_contracts(self):
        url='/access-assignments/'+self.record['id']
        self.assertEqual(self.client.patch(url,json={'status':'REVOKED'}).status_code,200)
        self.assertEqual(self.calls[-1][1]['p_status'],'REVOKED')
        self.assertEqual(self.client.post(url+'/revoke').status_code,200)
        self.assertEqual(self.calls[-1][1]['p_action'],'revoke')
        self.assertEqual(self.client.post(url+'/reactivate').status_code,201)
        self.assertEqual(self.calls[-1][1]['p_action'],'reactivate')

    def test_delete_assignment_returns_no_content_with_session_actor(self):
        response=self.client.delete('/access-assignments/'+self.record['id'])
        self.assertEqual(response.status_code,204)
        self.assertEqual(response.content,b'')
        self.assertEqual(self.calls[-1],('workout_zone_delete_access',{'p_actor_id':self.auth.db.user_id,'p_assignment_id':self.record['id']}))

    def test_delete_rejects_bad_origin_and_unprivileged_actor(self):
        url='/access-assignments/'+self.record['id']
        self.assertEqual(self.client.delete(url,headers={'Origin':'https://evil.example'}).status_code,403)
        self.auth.db.rows['role_assignments'][0]['role']='admin'
        self.assertEqual(self.client.delete(url).status_code,403)
        self.assertEqual(self.calls,[])

    def test_untrusted_or_missing_write_origin_is_rejected(self):
        for origin in ('https://evil.example','null',''):
            response=self.client.post('/access-assignments',headers={'Origin':origin},json={'email':'staff@example.com','role':'GYM_OWNER'})
            self.assertEqual(response.status_code,403)
        self.assertEqual(self.calls,[])

    def test_database_errors_are_mapped_without_leaking_details(self):
        for code,status in [('23505',409),('42501',403),('P0002',404),('22023',422),('PGRST202',503)]:
            with self.subTest(code=code):
                self.failure=APIError({'message':'private SQL details','code':code,'hint':None,'details':None})
                response=self.client.post('/access-assignments',json={'email':'staff@example.com','role':'GYM_OWNER'})
                self.assertEqual(response.status_code,status)
                self.assertNotIn('private SQL',response.text)

    def test_revoked_owner_is_denied_before_rpc(self):
        self.auth.db.rows['role_assignments'][0]['revoked_at']='2026-11-01'
        self.assertEqual(self.client.get('/access-assignments').status_code,403)
        self.assertEqual(self.calls,[])
