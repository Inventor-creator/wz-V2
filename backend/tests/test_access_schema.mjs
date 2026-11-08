// Execute the supplied schema and access RPC migration in a disposable PostgreSQL-compatible DB.
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import assert from 'node:assert/strict';
const {PGlite}=await import(process.env.PGLITE_MODULE?pathToFileURL(process.env.PGLITE_MODULE).href:'@electric-sql/pglite');
const read=(path)=>readFile(new URL(path,import.meta.url),'utf8');

test('access management transactions against the supplied gym schema',async(t)=>{
  const db=new PGlite();
  try{
    // gen_random_uuid is built into current PostgreSQL; PGlite need not install pgcrypto.
    await db.exec((await read('../docs/gym_schema.sql')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
    await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
    await db.exec(await read('../migrations/001_google_identity_bootstrap_admin.sql'));
    await db.exec(await read('../migrations/002_access_management.sql'));
    await db.exec(await read('../migrations/003_delete_access_assignments.sql'));
    const addUser=async(email)=> (await db.query('INSERT INTO users(email,display_name) VALUES ($1,$1) RETURNING id',[email])).rows[0].id;
    const bootstrap=await addUser('aryapat1234@gmail.com');
    const owner=await addUser('owner@example.com');
    const admin=await addUser('admin@example.com');
    await db.query("INSERT INTO role_assignments(user_id,role) VALUES ($1,'owner'),($2,'admin')",[owner,admin]);
    const mutate=async(params)=>{
      const args={actor:bootstrap,action:'create',id:null,email:null,role:null,trainer:null,setTrainer:false,status:null,name:null,...params};
      return (await db.query('SELECT workout_zone_mutate_access($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',Object.values(args))).rows[0].result;
    };
    const list=async(actor=bootstrap)=>(await db.query('SELECT workout_zone_list_access($1) AS result',[actor])).rows[0].result;
    let grant;

    await t.test('lists protected bootstrap identity without an ordinary grant or subject leak',async()=>{
      const rows=await list();
      assert.equal(rows.find(r=>r.email==='aryapat1234@gmail.com').isPermanent,true);
      assert.equal(JSON.stringify(rows).includes('google_subject'),false);
      assert.equal((await list(owner)).length,rows.length);
    });
    await t.test('creates a pending authorized user and an audited grant atomically',async()=>{
      grant=await mutate({email:'new@example.com',role:'admin'});
      assert.equal(grant.role,'GYM_RECEPTIONIST');
      assert.equal(grant.name,null);
      const u=(await db.query('SELECT * FROM users WHERE id=$1',[grant.userId])).rows[0];
      assert.equal(u.google_subject,null);
      assert.ok(u.display_name);
      assert.equal((await db.query('SELECT granted_by FROM role_assignments WHERE id=$1',[grant.id])).rows[0].granted_by,bootstrap);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM access_audit_events')).rows[0].n,1);
    });
    await t.test('duplicate grants conflict without duplicating users or audit events',async()=>{
      await assert.rejects(mutate({email:'new@example.com',role:'admin'}),e=>e.code==='23505');
      assert.equal((await db.query("SELECT count(*)::int AS n FROM users WHERE email='new@example.com'")).rows[0].n,1);
    });
    await t.test('role changes append a grant and preserve old grant history',async()=>{
      const old=grant;
      grant=await mutate({action:'update',id:old.id,role:'owner'});
      assert.notEqual(grant.id,old.id);
      assert.equal(grant.role,'GYM_OWNER');
      assert.ok((await db.query('SELECT revoked_at FROM role_assignments WHERE id=$1',[old.id])).rows[0].revoked_at);
    });
    await t.test('revoke and reactivate preserve history and reject duplicate reactivation',async()=>{
      const revoked=await mutate({action:'revoke',id:grant.id});
      assert.equal(revoked.status,'REVOKED');
      const restored=await mutate({action:'reactivate',id:grant.id});
      assert.notEqual(restored.id,grant.id);
      await assert.rejects(mutate({action:'reactivate',id:grant.id}),e=>e.code==='23505');
      grant=restored;
    });
    await t.test('trainer conflicts roll back the old grant revocation',async()=>{
      const trainer=(await db.query("INSERT INTO trainers(full_name) VALUES ('Trainer') RETURNING id")).rows[0].id;
      const assigned=await mutate({email:'coach@example.com',role:'trainer',trainer,setTrainer:true});
      await assert.rejects(mutate({action:'update',id:grant.id,role:'trainer',trainer,setTrainer:true}),e=>e.code==='23505');
      assert.equal((await list()).find(r=>r.id===grant.id).status,'ACTIVE');
      assert.equal(assigned.trainerId,trainer);
      const inactive=(await db.query("INSERT INTO trainers(full_name,status) VALUES ('Inactive','inactive') RETURNING id")).rows[0].id;
      await assert.rejects(mutate({email:'bad@example.com',role:'trainer',trainer:inactive,setTrainer:true}),e=>e.code==='P0002');
      assert.equal((await db.query("SELECT count(*)::int AS n FROM users WHERE email='bad@example.com'")).rows[0].n,0);
    });
    await t.test('ordinary admins, inactive owners and revoked owners are rejected',async()=>{
      await assert.rejects(list(admin),e=>e.code==='42501');
      await db.query('UPDATE users SET active=false WHERE id=$1',[owner]);
      await assert.rejects(list(owner),e=>e.code==='42501');
      await db.query('UPDATE users SET active=true WHERE id=$1',[owner]);
      await db.query('UPDATE role_assignments SET revoked_at=now() WHERE user_id=$1',[owner]);
      await assert.rejects(mutate({actor:owner,email:'forbidden@example.com',role:'admin'}),e=>e.code==='42501');
    });
    await t.test('bootstrap modifications, SUPER_ADMIN grants and identity email changes are rejected',async()=>{
      await assert.rejects(mutate({action:'revoke',id:bootstrap}),e=>e.code==='42501');
      await assert.rejects(mutate({email:'aryapat1234@gmail.com',role:'owner'}),e=>e.code==='42501');
      await assert.rejects(mutate({email:'other@example.com',role:'super_admin'}),e=>e.code==='22023');
      await assert.rejects(mutate({action:'update',id:grant.id,email:'renamed@example.com'}),e=>e.code==='22023');
    });
    await t.test('disabled accounts are not silently reactivated by granting a role',async()=>{
      await db.query('UPDATE users SET active=false WHERE id=$1',[grant.userId]);
      await assert.rejects(mutate({email:'new@example.com',role:'admin'}),e=>e.code==='55000');
      await db.query('UPDATE users SET active=true WHERE id=$1',[grant.userId]);
    });
    await t.test('deletes only the grant while preserving account and audit snapshots',async()=>{
      const auditCount=(await db.query('SELECT count(*)::int AS n FROM access_audit_events')).rows[0].n;
      const result=await db.query('SELECT workout_zone_delete_access($1,$2) AS deleted',[bootstrap,grant.id]);
      assert.equal(result.rows[0].deleted,true);
      assert.equal((await list()).some(r=>r.id===grant.id),false);
      assert.equal((await db.query('SELECT id FROM users WHERE id=$1',[grant.userId])).rows.length,1);
      assert.equal((await db.query('SELECT count(*)::int AS n FROM access_audit_events')).rows[0].n,auditCount+1);
      const audit=(await db.query("SELECT * FROM access_audit_events WHERE event_type='delete'")).rows[0];
      assert.equal(audit.assignment_id,null);
      assert.equal(audit.old_state.id,grant.id);
      assert.equal(audit.new_state.assignmentId,grant.id);
      await assert.rejects(db.query('SELECT workout_zone_delete_access($1,$2)',[bootstrap,grant.id]),e=>e.code==='P0002');
    });
    await t.test('delete protects bootstrap and rejects unauthorized actors',async()=>{
      await assert.rejects(db.query('SELECT workout_zone_delete_access($1,$2)',[bootstrap,bootstrap]),e=>e.code==='42501');
      await assert.rejects(db.query('SELECT workout_zone_delete_access($1,$2)',[admin,grant.id]),e=>e.code==='42501');
    });
    await t.test('browser database roles cannot invoke privilege RPCs; backend role can',async()=>{
      await db.exec('SET ROLE authenticated');
      await assert.rejects(list(),e=>e.code==='42501');
      await assert.rejects(db.query('SELECT workout_zone_delete_access($1,$2)',[bootstrap,grant.id]),e=>e.code==='42501');
      await assert.rejects(db.query('SELECT email FROM users'),e=>e.code==='42501');
      await db.exec('RESET ROLE; SET ROLE anon');
      await assert.rejects(list(),e=>e.code==='42501');
      await db.exec('RESET ROLE; SET ROLE service_role');
      assert.ok((await list()).length>0);
      assert.ok((await db.query('SELECT id FROM users')).rows.length>0);
      await assert.rejects(db.query("UPDATE role_assignments SET role='owner'"),e=>e.code==='42501');
      await assert.rejects(db.query('DELETE FROM access_audit_events'),e=>e.code==='42501');
      await db.exec('RESET ROLE');
    });
  }finally{await db.close();}
});
