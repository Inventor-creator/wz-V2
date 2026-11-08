import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const {PGlite}=await import(process.env.PGLITE_MODULE?pathToFileURL(process.env.PGLITE_MODULE).href:'@electric-sql/pglite');
const read=p=>readFile(new URL(p,import.meta.url),'utf8');
test('membership CRUD and historical preservation through migrations 001–005',async t=>{
 const db=new PGlite();
 try{
  await db.exec((await read('../docs/gym_schema.sql')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
  for(const file of ['001_google_identity_bootstrap_admin.sql','002_access_management.sql','003_delete_access_assignments.sql','004_trainer_dashboard_and_onboarding.sql','005_membership_plan_crud.sql'])await db.exec(await read('../migrations/'+file));
  const user=async email=>(await db.query('INSERT INTO users(email,display_name) VALUES($1,$1) RETURNING id',[email])).rows[0].id;
  const root=await user('aryapat1234@gmail.com'),owner=await user('owner@example.com'),admin=await user('admin@example.com'),trainer=await user('trainer@example.com');
  const trainerId=(await db.query("INSERT INTO trainers(full_name) VALUES('Coach') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO role_assignments(user_id,role,trainer_id) VALUES($1,'owner',NULL),($2,'admin',NULL),($3,'trainer',$4)",[owner,admin,trainer,trainerId]);
  const mutate=async(action,fields={},id=null,actor=root)=>(await db.query('SELECT workout_zone_mutate_membership_plan($1,$2,$3,$4::jsonb) AS data',[actor,action,id,JSON.stringify(fields)])).rows[0].data;
  const list=async(actor=root)=>(await db.query('SELECT workout_zone_list_membership_plans($1) AS data',[actor])).rows[0].data;
  const create=(name,price=1000,actor=root)=>mutate('create',{name,price,duration:30,durationUnit:'DAY',description:'Gym access',isActive:true},null,actor);
  let plan,unused;
  await t.test('creates fixed-day plans including zero prices and returns actual catalog fields',async()=>{
    plan=await create('30-day Essential');unused=await create('Free trial',0,admin);
    assert.equal(unused.price,0);assert.equal(plan.durationUnit,'DAY');assert.equal(plan.duration,30);assert.equal(plan.activeMembersCount,0);assert.equal(plan.hasHistory,false);
  });
  await t.test('owner and receptionist can manage plans; trainers and revoked roles cannot',async()=>{
    assert.equal((await list(owner)).length,2);await assert.rejects(list(trainer),e=>e.code==='42501');
    await db.query("UPDATE role_assignments SET revoked_at=now() WHERE user_id=$1",[admin]);await assert.rejects(list(admin),e=>e.code==='42501');
    await db.query('UPDATE users SET active=false WHERE id=$1',[owner]);await assert.rejects(list(owner),e=>e.code==='42501');await db.query('UPDATE users SET active=true WHERE id=$1',[owner]);
  });
  await t.test('rejects duplicate names, invalid units, blank names, fractional days and extra price precision',async()=>{
    await assert.rejects(create('30-day Essential'),e=>e.code==='23505');
    for(const patch of [{name:' '},{duration:0},{duration:1.5},{durationUnit:'MONTH'},{price:-1},{price:1.001},{isActive:'true'},{description:null}])await assert.rejects(mutate('update',patch,plan.id),e=>e.code==='22023');
  });
  const member=(await db.query("INSERT INTO members(member_number,full_name) VALUES($1,'Member') RETURNING id",[randomUUID()])).rows[0].id;
  const subscribe=async(id,offset=0)=>(await db.query("INSERT INTO member_plans(member_id,gym_plan_id,starts_on,ends_on,price_snapshot) VALUES($1,$2,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date-10,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date+$3::int,1000) RETURNING id,price_snapshot,ends_on",[member,id,offset])).rows[0];
  const subscription=await subscribe(plan.id);await subscribe(plan.id,20);
  const invoice=(await db.query("INSERT INTO invoices(member_id,invoice_number,due_date,status) VALUES($1,$2,current_date,'issued') RETURNING id",[member,randomUUID()])).rows[0].id;
  const line=(await db.query("INSERT INTO invoice_items(invoice_id,member_id,member_plan_id,item_type,description,amount,billing_key) VALUES($1,$2,$3,'gym','Original fee',1000,$4) RETURNING id",[invoice,member,subscription.id,randomUUID()])).rows[0].id;
  await t.test('active member count is distinct and includes the final subscription day',async()=>{
    const current=(await list()).find(p=>p.id===plan.id);assert.equal(current.activeMembersCount,1);assert.equal(current.hasHistory,true);
  });
  await t.test('editing catalog terms never changes historical prices, dates or invoice items',async()=>{
    const updated=await mutate('update',{name:'Updated Essential',price:1500.55,duration:60,description:'New catalog description'},plan.id,owner);
    assert.equal(updated.price,1500.55);assert.equal(updated.duration,60);
    const old=(await db.query('SELECT price_snapshot,ends_on FROM member_plans WHERE id=$1',[subscription.id])).rows[0];
    assert.equal(Number(old.price_snapshot),1000);assert.equal(String(old.ends_on),String(subscription.ends_on));
    const item=(await db.query('SELECT description,amount FROM invoice_items WHERE id=$1',[line])).rows[0];assert.equal(item.description,'Original fee');assert.equal(Number(item.amount),1000);
  });
  await t.test('inactive plans reject new subscriptions and can be reactivated through edit',async()=>{
    await mutate('update',{isActive:false},unused.id);await assert.rejects(subscribe(unused.id),e=>e.code==='23514');
    await mutate('update',{isActive:true},unused.id);assert.equal((await list()).find(p=>p.id===unused.id).isActive,true);
  });
  await t.test('unused plans are physically deleted with an audit snapshot retained',async()=>{
    const result=await mutate('delete',{},unused.id);assert.equal(result.mode,'DELETED');
    assert.equal((await db.query('SELECT id FROM gym_plans WHERE id=$1',[unused.id])).rows.length,0);
    const audit=(await db.query("SELECT * FROM membership_plan_events WHERE action='delete' AND new_state->>'id'=$1",[unused.id])).rows[0];assert.equal(audit.plan_id,null);assert.equal(audit.old_state.id,unused.id);
    await assert.rejects(mutate('delete',{},unused.id),e=>e.code==='P0002');
  });
  await t.test('referenced plans leave the catalog without breaking memberships or financial records',async()=>{
    const result=await mutate('delete',{},plan.id);assert.equal(result.mode,'REMOVED_FROM_CATALOG');assert.equal((await list()).some(p=>p.id===plan.id),false);
    const retained=(await db.query('SELECT active,deleted_at FROM gym_plans WHERE id=$1',[plan.id])).rows[0];assert.equal(retained.active,false);assert.ok(retained.deleted_at);
    assert.equal((await db.query('SELECT id FROM member_plans WHERE id=$1',[subscription.id])).rows.length,1);assert.equal((await db.query('SELECT id FROM invoice_items WHERE id=$1',[line])).rows.length,1);
    await assert.rejects(subscribe(plan.id),e=>e.code==='23514');await assert.rejects(mutate('update',{isActive:true},plan.id),e=>e.code==='P0002');
    await assert.rejects(create('Updated Essential'),e=>e.code==='23505');
  });
  await t.test('direct browser access and raw service-role writes are denied',async()=>{
    await db.exec('SET ROLE authenticated');await assert.rejects(list(),e=>e.code==='42501');await assert.rejects(db.query('SELECT * FROM gym_plans'),e=>e.code==='42501');await db.exec('RESET ROLE; SET ROLE service_role');
    assert.ok(Array.isArray(await list()));await assert.rejects(db.query("INSERT INTO gym_plans(name,duration_days,list_price) VALUES('Bypass',30,1)"),e=>e.code==='42501');await db.exec('RESET ROLE');
  });
 }finally{await db.close();}
});
