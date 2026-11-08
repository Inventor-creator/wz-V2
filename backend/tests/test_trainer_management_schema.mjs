import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
const {PGlite} = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE).href : '@electric-sql/pglite');
const read = p => readFile(new URL(p,import.meta.url),'utf8');
let db, root, admin, owner, trainerActor, trainer, member, plan, original;
const q = async (sql,values=[]) => (await db.query(sql,values)).rows;
const data = async (sql,values=[]) => (await q(sql,values))[0].data;
const mutate = (action,fields={},id=null,actor=root) => data('SELECT workout_zone_mutate_trainer($1,$2,$3,$4::jsonb) AS data',[actor,action,id,JSON.stringify(fields)]);
const list = (actor=root) => data('SELECT workout_zone_list_trainers($1) AS data',[actor]);
const detail = (actor=root,id=trainer) => data('SELECT workout_zone_get_trainer($1,$2) AS data',[actor,id]);
const schedule = (rate=50,start=1,end=null,actor=root) => data("SELECT workout_zone_schedule_trainer_commission($1,$2,$3,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date+$4::integer,CASE WHEN $5::integer IS NULL THEN NULL ELSE (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date+$5::integer END) AS data",[actor,trainer,rate,start,end]);
const financialSnapshot = () => Promise.all(['member_trainer_plan','invoices','invoice_items','payments','payment_allocations','trainer_payouts','trainer_payout_items'].map(table=>q(`SELECT * FROM ${table} ORDER BY id`)));
beforeEach(async () => {
  db = new PGlite();
  await db.exec((await read('../docs/gym_schema.sql')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
  for(const file of ['001_google_identity_bootstrap_admin.sql','002_access_management.sql','003_delete_access_assignments.sql','004_trainer_dashboard_and_onboarding.sql','005_membership_plan_crud.sql','006_trainer_plan_crud.sql']) await db.exec(await read('../migrations/'+file));
  const user = async email => (await q('INSERT INTO users(email,display_name) VALUES($1,$1) RETURNING id',[email]))[0].id;
  root = await user('aryapat1234@gmail.com'); owner = await user('owner@example.com'); admin = await user('admin@example.com'); trainerActor = await user('coach@example.com');
  trainer = (await q("INSERT INTO trainers(full_name,email,phone) VALUES('Existing Coach','contact@example.com','+919876543210') RETURNING id"))[0].id;
  await q("INSERT INTO role_assignments(user_id,role,trainer_id) VALUES($1,'owner',NULL),($2,'admin',NULL),($3,'trainer',$4)",[owner,admin,trainerActor,trainer]);
  member = (await q("INSERT INTO members(member_number,full_name) VALUES('M001','Member') RETURNING id"))[0].id;
  plan = (await q("INSERT INTO trainer_plans(name,duration_days,list_price) VALUES('Shared PT',30,1000) RETURNING id"))[0].id;
  const sub = (await q("INSERT INTO member_trainer_plan(member_id,trainer_id,trainer_plan_id,starts_on,ends_on,price_snapshot) VALUES($1,$2,$3,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date-10,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date,1000) RETURNING id",[member,trainer,plan]))[0].id;
  const inv = (await q("INSERT INTO invoices(member_id,invoice_number,due_date,status) VALUES($1,'INV001',current_date,'issued') RETURNING id",[member]))[0].id;
  const item = (await q("INSERT INTO invoice_items(invoice_id,member_id,member_trainer_plan_id,item_type,description,amount,billing_key) VALUES($1,$2,$3,'personal_training','Original PT',1000,'PT001') RETURNING id",[inv,member,sub]))[0].id;
  const payment = (await q("INSERT INTO payments(invoice_id,amount,method,status,idempotency_key,received_at) VALUES($1,1000,'cash','completed','PAY001',now()) RETURNING id",[inv]))[0].id;
  const allocation = (await q('INSERT INTO payment_allocations(payment_id,invoice_item_id,invoice_id,amount) VALUES($1,$2,$3,1000) RETURNING id',[payment,item,inv]))[0].id;
  const payout = (await q("INSERT INTO trainer_payouts(trainer_id,period_start,period_end,status,paid_at,payment_reference) VALUES($1,current_date,current_date,'paid',now(),'BANK001') RETURNING id",[trainer]))[0].id;
  const rule = (await q("INSERT INTO trainer_payout_rules(trainer_id,kind,value,effective_from) VALUES($1,'percent',40,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date-30) RETURNING id",[trainer]))[0].id;
  await q("INSERT INTO trainer_payout_items(payout_id,trainer_id,allocation_id,rule_id,rule_kind,rule_value,amount) VALUES($1,$2,$3,$4,'percent',40,400)",[payout,trainer,allocation,rule]);
  original = await financialSnapshot();
  await db.exec(await read('../migrations/007_trainer_management.sql'));
});
afterEach(async () => {await db.close();});

test('007 preserves existing financial history and profile IDs; counts distinct members inclusively',async () => {
  assert.deepEqual(await financialSnapshot(),original);
  let row = (await list())[0];
  assert.equal(row.id,trainer); assert.equal(row.assignedMembersCount,1); assert.equal(row.activeMembersCount,1); assert.equal(row.hasLoginAccess,true);
  await q("INSERT INTO member_trainer_plan(member_id,trainer_id,trainer_plan_id,starts_on,ends_on,price_snapshot) SELECT member_id,trainer_id,trainer_plan_id,starts_on,ends_on,price_snapshot FROM member_trainer_plan LIMIT 1");
  row=(await list())[0]; assert.equal(row.assignedMembersCount,1); assert.equal(row.activeMembersCount,1);
  await q("UPDATE member_trainer_plan SET starts_on=ends_on+1,ends_on=ends_on+1");
  assert.equal((await list())[0].activeMembersCount,0);
  await q("UPDATE member_trainer_plan SET status='cancelled'");
  assert.equal((await detail()).assignments[0].status,'Cancelled');
  assert.equal((await detail()).assignments.length,2);
});

test('create/edit profiles with optional contacts and no fabricated accounts or grants',async () => {
  const users = await q('SELECT * FROM users ORDER BY id'); const grants = await q('SELECT * FROM role_assignments ORDER BY id');
  const created = await mutate('create',{name:'New Coach'});
  assert.equal(created.email,''); assert.equal(created.phone,''); assert.equal(created.hasLoginAccess,false); assert.equal(created.isActive,true);
  const updated = await mutate('update',{name:'Updated Coach',email:'new-contact@example.com',phone:'+919999999999'},trainer,admin);
  assert.equal(updated.email,'new-contact@example.com'); assert.equal(updated.hasLoginAccess,true);
  assert.deepEqual(await q('SELECT * FROM users ORDER BY id'),users);
  assert.deepEqual(await q('SELECT * FROM role_assignments ORDER BY id'),grants);
  assert.deepEqual(await financialSnapshot(),original);
  assert.equal((await q('SELECT count(*)::integer AS n FROM trainer_management_events'))[0].n,2);
});

test('deactivation preserves login grants/dashboard/history, blocks new purchases, and can be reversed',async () => {
  await mutate('update',{isActive:false},trainer);
  assert.equal((await list())[0].hasLoginAccess,true);
  assert.equal((await detail()).trainer.isActive,false);
  const dashboard = await data('SELECT workout_zone_trainer_dashboard($1,$2) AS data',[trainerActor,trainer]);
  assert.equal(dashboard.rows.length,1); assert.equal(dashboard.trainer.isActive,false);
  await assert.rejects(q("INSERT INTO member_trainer_plan(member_id,trainer_id,trainer_plan_id,starts_on,ends_on,price_snapshot) VALUES($1,$2,$3,current_date,current_date+30,1000)",[member,trainer,plan]),e=>e.code==='23514');
  assert.deepEqual(await financialSnapshot(),original);
  await mutate('update',{isActive:true},trainer);
  assert.equal((await detail()).trainer.isActive,true);
});

test('live roles restrict management; receptionist responses never contain payout rules',async () => {
  assert.equal((await list(owner)).length,1); assert.equal((await list(admin)).length,1);
  assert.equal((await detail(admin)).payoutRules,null);
  assert.equal((await detail(owner)).payoutRules[0].value,40);
  await assert.rejects(list(trainerActor),e=>e.code==='42501');
  await assert.rejects(mutate('create',{name:'Forbidden'},null,trainerActor),e=>e.code==='42501');
  await assert.rejects(schedule(50,1,null,admin),e=>e.code==='42501');
  await q('UPDATE users SET active=false WHERE id=$1',[owner]);
  await assert.rejects(list(owner),e=>e.code==='42501');
  await q('UPDATE role_assignments SET revoked_at=now() WHERE user_id=$1',[admin]);
  await assert.rejects(list(admin),e=>e.code==='42501');
  await q('UPDATE users SET active=false WHERE id=$1',[trainerActor]);
  assert.equal((await list())[0].hasLoginAccess,false);
});

test('profile RPC rejects unknown/read-only/null/invalid values and missing IDs',async () => {
  for(const fields of [{name:' '},{name:1},{email:'bad'},{phone:'123'},{phone:null},{isActive:'false'},{userId:root},{hasLoginAccess:true},{assignedMembersCount:9},{}])
    await assert.rejects(mutate('update',fields,trainer),e=>e.code==='22023');
  await assert.rejects(mutate('create',{}),e=>e.code==='22023');
  await assert.rejects(mutate('delete',{},trainer),e=>e.code==='22023');
  await assert.rejects(detail(root,'00000000-0000-0000-0000-000000000000'),e=>e.code==='P0002');
});

test('future commission scheduling closes the preceding rule without rewriting historical payout amounts',async () => {
  const oldRule = (await detail()).payoutRules[0];
  const created = await schedule(55.25,1,null,owner);
  assert.equal(created.kind,'percent'); assert.equal(created.value,55.25);
  const rules = (await detail()).payoutRules;
  const closed = rules.find(r=>r.id===oldRule.id);
  assert.equal(closed.value,40);
  assert.equal(closed.effectiveUntil,(await q("SELECT ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date)::text AS today"))[0].today);
  assert.deepEqual(await financialSnapshot(),original);
  const event = (await q("SELECT * FROM trainer_management_events WHERE action='schedule_commission'"))[0];
  assert.equal(event.actor_user_id,owner); assert.equal(event.old_state.length,1); assert.equal(event.new_state.length,2);
});

test('invalid/retroactive periods and conflicting future schedules roll back without changing rules/audits',async () => {
  for(const [rate,start,end] of [[-1,1,null],[101,1,null],[40.001,1,null],[40,0,null],[40,-1,null],[40,5,4]])
    await assert.rejects(schedule(rate,start,end),e=>e.code==='22023');
  await schedule(50,10);
  const before = (await detail()).payoutRules;
  await assert.rejects(schedule(60,20),e=>e.code==='23P01');
  await assert.rejects(schedule(60,5),e=>e.code==='23P01');
  assert.deepEqual((await detail()).payoutRules,before);
  assert.equal((await q("SELECT count(*)::integer AS n FROM trainer_management_events WHERE action='schedule_commission'"))[0].n,1);
});

test('ambiguous legacy overlaps require review instead of guessing a fixed payout unit',async () => {
  await q("INSERT INTO trainer_payout_rules(trainer_id,kind,value,effective_from) VALUES($1,'fixed',500,current_date-10)",[trainer]);
  const before = (await detail()).payoutRules;
  await assert.rejects(schedule(),e=>e.code==='23P01');
  assert.deepEqual((await detail()).payoutRules,before);
});

test('checked 004 onboarding still works after 007 and browser/raw service-role writes remain closed',async () => {
  for(const role of ['anon','authenticated']) {
    await db.exec('SET ROLE '+role);
    await assert.rejects(list(),e=>e.code==='42501');
    await assert.rejects(q('SELECT * FROM workout_zone_trainer_directory'),e=>e.code==='42501');
    await assert.rejects(q('SELECT * FROM trainer_management_events'),e=>e.code==='42501');
    await db.exec('RESET ROLE');
  }
  await db.exec('SET ROLE service_role');
  await mutate('create',{name:'Service profile'});
  const grant = await data("SELECT workout_zone_grant_new_trainer($1,'create','Onboarded',NULL,NULL,'onboarded@example.com') AS data",[root]);
  assert.ok(grant.trainerId);
  await assert.rejects(q("UPDATE trainers SET full_name='Bypass' WHERE id=$1",[trainer]),e=>e.code==='42501');
  await assert.rejects(q('UPDATE trainer_payout_rules SET value=99'),e=>e.code==='42501');
  await db.exec('RESET ROLE');
  assert.equal((await list()).length,3);
});
