import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {test,beforeEach,afterEach} from 'node:test';
import assert from 'node:assert/strict';
const {PGlite}=await import(process.env.PGLITE_MODULE?pathToFileURL(process.env.PGLITE_MODULE).href:'@electric-sql/pglite');
const read=p=>readFile(new URL(p,import.meta.url),'utf8');
let db,root,admin,owner,trainerActor,trainer,gym,pt,member,today,original;
const q=async(sql,values=[])=>(await db.query(sql,values)).rows;
const data=async(sql,values=[])=>(await q(sql,values))[0].data;
const list=(actor=root)=>data('SELECT workout_zone_list_members($1) AS data',[actor]);
const detail=(id=member,actor=root)=>data('SELECT workout_zone_get_member($1,$2) AS data',[actor,id]);
const mutate=(action,fields={},id=member,actor=root)=>data('SELECT workout_zone_mutate_member($1,$2,$3,$4::jsonb) AS data',[actor,id,action,JSON.stringify(fields)]);
const create=(fields={},key=randomUUID(),actor=root)=>data('SELECT workout_zone_create_member($1,$2,$3::jsonb) AS data',[actor,key,JSON.stringify({fullName:'New Member',joiningDate:today,planId:gym,startDate:today,...fields})]);
const snapshots=()=>Promise.all(['member_plans','member_trainer_plan','invoices','invoice_items','payments','payment_allocations','trainer_payouts','trainer_payout_items','users','role_assignments'].map(table=>q(`SELECT * FROM ${table} ORDER BY id`)));
beforeEach(async()=>{
  db=new PGlite();await db.exec((await read('../docs/gym_schema.sql')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
  for(const f of ['001_google_identity_bootstrap_admin.sql','002_access_management.sql','003_delete_access_assignments.sql','004_trainer_dashboard_and_onboarding.sql','005_membership_plan_crud.sql','006_trainer_plan_crud.sql','007_trainer_management.sql'])await db.exec(await read('../migrations/'+f));
  const user=async email=>(await q('INSERT INTO users(email,display_name) VALUES($1,$1) RETURNING id',[email]))[0].id;
  root=await user('aryapat1234@gmail.com');owner=await user('owner@example.com');admin=await user('admin@example.com');trainerActor=await user('coach@example.com');
  trainer=(await q("INSERT INTO trainers(full_name) VALUES('Coach') RETURNING id"))[0].id;
  await q("INSERT INTO role_assignments(user_id,role,trainer_id) VALUES($1,'owner',NULL),($2,'admin',NULL),($3,'trainer',$4)",[owner,admin,trainerActor,trainer]);
  gym=(await q("INSERT INTO gym_plans(name,duration_days,list_price) VALUES('Gym 30',30,2500) RETURNING id"))[0].id;
  pt=(await q("INSERT INTO trainer_plans(name,duration_days,list_price) VALUES('PT 7',7,6000) RETURNING id"))[0].id;
  today=(await q("SELECT ((CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date)::text AS date"))[0].date;
  member=(await q("INSERT INTO members(member_number,full_name,joined_on) VALUES('LEGACY001','Existing Member',current_date-30) RETURNING id"))[0].id;
  await q("INSERT INTO member_plans(member_id,gym_plan_id,starts_on,ends_on,price_snapshot) VALUES($1,$2,current_date-10,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date,1200)",[member,gym]);
  const sub=(await q("INSERT INTO member_trainer_plan(member_id,trainer_id,trainer_plan_id,starts_on,ends_on,price_snapshot) VALUES($1,$2,$3,current_date-10,current_date+20,4000) RETURNING id",[member,trainer,pt]))[0].id;
  const invoice=(await q("INSERT INTO invoices(member_id,invoice_number,due_date,status) VALUES($1,'INV001',current_date,'issued') RETURNING id",[member]))[0].id;
  const item=(await q("INSERT INTO invoice_items(invoice_id,member_id,member_trainer_plan_id,item_type,description,amount,billing_key) VALUES($1,$2,$3,'personal_training','Original PT charge',1000,'PT001') RETURNING id",[invoice,member,sub]))[0].id;
  const payment=(await q("INSERT INTO payments(invoice_id,amount,method,status,idempotency_key,received_at) VALUES($1,500,'cash','completed','PAY001',now()) RETURNING id",[invoice]))[0].id;
  const allocation=(await q('INSERT INTO payment_allocations(payment_id,invoice_item_id,invoice_id,amount) VALUES($1,$2,$3,500) RETURNING id',[payment,item,invoice]))[0].id;
  const payout=(await q("INSERT INTO trainer_payouts(trainer_id,period_start,period_end,status,paid_at,payment_reference) VALUES($1,current_date,current_date,'paid',now(),'BANK001') RETURNING id",[trainer]))[0].id;
  await q("INSERT INTO trainer_payout_items(payout_id,trainer_id,allocation_id,rule_kind,rule_value,amount) VALUES($1,$2,$3,'percent',40,200)",[payout,trainer,allocation]);
  original=await snapshots();await db.exec(await read('../migrations/008_member_crud.sql'));
});
afterEach(async()=>{await db.close();});

test('008 preserves legacy IDs/history and derives inclusive expiry and actual allocated balances',async()=>{
  assert.deepEqual(await snapshots(),original);
  const directory=await list();assert.equal(directory.members[0].id,member);assert.equal(directory.members[0].memberNumber,'LEGACY001');
  assert.equal(directory.members[0].gym.daysRemaining,0);assert.equal(directory.members[0].membershipStatus,'Expiring Soon');assert.equal(directory.summary.outstandingAmount,500);
  const d=await detail();assert.equal(d.subscriptions.length,2);assert.equal(d.invoices[0].paymentStatus,'PARTIAL');assert.equal(d.invoices[0].allocatedAmount,500);assert.equal(d.payments[0].status,'completed');
});
test('atomic onboarding snapshots locked gym/PT prices and fixed inclusive dates without generating money',async()=>{
  const created=await create({trainerId:trainer,ptPlanId:pt,ptStartDate:today,email:'contact@example.com'});
  assert.ok(created.memberNumber.startsWith('WZ-'));assert.equal(created.status,'ACTIVE');
  const d=await detail(created.id);assert.equal(d.subscriptions.length,2);
  const gymSub=d.subscriptions.find(s=>s.type==='GYM'),ptSub=d.subscriptions.find(s=>s.type==='PT');
  assert.equal(gymSub.priceAtPurchase,2500);assert.equal(gymSub.daysRemaining,29);assert.equal(ptSub.priceAtPurchase,6000);assert.equal(ptSub.daysRemaining,6);
  assert.equal(d.invoices.length,0);assert.equal(d.payments.length,0);
  await q('UPDATE gym_plans SET list_price=9999,duration_days=90 WHERE id=$1',[gym]);
  assert.equal((await detail(created.id)).subscriptions.find(s=>s.type==='GYM').priceAtPurchase,2500);
  assert.equal((await q('SELECT count(*)::int AS n FROM member_events'))[0].n,1);
  await q('UPDATE gym_plans SET list_price=0,duration_days=1 WHERE id=$1',[gym]);
  const free=await create({fullName:'Free trial'});const freeDetails=await detail(free.id);
  assert.equal(freeDetails.subscriptions[0].priceAtPurchase,0);assert.equal(freeDetails.subscriptions[0].daysRemaining,0);assert.equal(freeDetails.invoices.length,0);
});
test('idempotent retries do not duplicate members/subscriptions, even after catalogue removal',async()=>{
  const key=randomUUID();const first=await create({},key);const second=await create({},key);
  assert.deepEqual(second,first);assert.equal((await list()).members.length,2);
  await q('UPDATE gym_plans SET active=false WHERE id=$1',[gym]);assert.deepEqual(await create({},key),first);
  await assert.rejects(create({fullName:'Different'},key),e=>e.code==='23505');
  await assert.rejects(create({},key,admin),e=>e.code==='23505');
});
test('invalid/deactivated plans and trainers fail atomically without partial members or audit rows',async()=>{
  const count=async()=>(await q('SELECT count(*)::int AS n FROM members'))[0].n;
  await q("UPDATE trainers SET status='inactive' WHERE id=$1",[trainer]);
  await assert.rejects(create({trainerId:trainer,ptPlanId:pt,ptStartDate:today}),e=>e.code==='23514');
  await assert.rejects(create({trainerId:trainer}),e=>e.code==='22023');
  await q('UPDATE gym_plans SET active=false WHERE id=$1',[gym]);await assert.rejects(create(),e=>e.code==='23514');
  assert.equal(await count(),1);assert.equal((await q('SELECT count(*)::int AS n FROM member_events'))[0].n,0);
  assert.equal((await q('SELECT count(*)::int AS n FROM member_onboarding_requests'))[0].n,0);
});
test('contact edits work independently of inactive plans/trainers and never rewrite history',async()=>{
  await q('UPDATE gym_plans SET active=false WHERE id=$1',[gym]);await q("UPDATE trainers SET status='inactive' WHERE id=$1",[trainer]);
  const result=await mutate('update',{fullName:'Corrected Name',email:'new@example.com',notes:'Updated profile'});
  assert.equal(result.fullName,'Corrected Name');assert.equal(result.notes,'Updated profile');assert.deepEqual(await snapshots(),original);
  await assert.rejects(mutate('update',{joiningDate:today}),e=>e.code==='22023');
  for(const fields of [{planId:gym},{priceAtPurchase:1},{endDate:today},{status:'active'},{userId:root},{fullName:' '},{phone:null},{}])await assert.rejects(mutate('update',fields),e=>e.code==='22023');
});
test('delete removes referenced members from directory while retaining debts, all provenance and audit state',async()=>{
  assert.equal((await mutate('delete')).mode,'REMOVED_FROM_DIRECTORY');assert.equal((await list()).members.length,0);assert.equal((await list()).summary.outstandingAmount,500);
  assert.deepEqual(await snapshots(),original);assert.equal((await q('SELECT status FROM members WHERE id=$1',[member]))[0].status,'inactive');
  await assert.rejects(detail(),e=>e.code==='P0002');await assert.rejects(mutate('update',{notes:'Restore'}),e=>e.code==='P0002');
  await assert.rejects(q("INSERT INTO member_plans(member_id,gym_plan_id,starts_on,ends_on,price_snapshot) VALUES($1,$2,current_date,current_date+30,1)",[member,gym]),e=>e.code==='23514');
  await q("UPDATE member_plans SET status='expired' WHERE member_id=$1",[member]);
});
test('unreferenced legacy profiles are physically deleted and audit snapshots remain',async()=>{
  const unused=(await q("INSERT INTO members(member_number,full_name) VALUES('UNUSED','Unused') RETURNING id"))[0].id;
  assert.equal((await mutate('delete',{},unused)).mode,'DELETED');assert.equal((await q('SELECT id FROM members WHERE id=$1',[unused])).length,0);
  const event=(await q("SELECT * FROM member_events WHERE action='delete'"))[0];assert.equal(event.member_id,null);assert.equal(event.old_state.id,unused);
});
test('current subscription selection is deterministic instead of selecting the last inserted renewal',async()=>{
  await q("INSERT INTO member_plans(member_id,gym_plan_id,starts_on,ends_on,price_snapshot) VALUES($1,$2,current_date+10,current_date+40,3000)",[member,gym]);
  assert.equal((await list()).members[0].gym.daysRemaining,0);
  await q("UPDATE member_plans SET status='cancelled' WHERE member_id=$1 AND ends_on=$2::date",[member,today]);
  assert.equal((await list()).members[0].membershipStatus,'Upcoming');
});
test('staff permissions and browser/raw service restrictions survive the full migration chain',async()=>{
  assert.equal((await list(owner)).members.length,1);assert.equal((await list(admin)).members.length,1);
  await assert.rejects(list(trainerActor),e=>e.code==='42501');await assert.rejects(create({},randomUUID(),trainerActor),e=>e.code==='42501');
  await q('UPDATE role_assignments SET revoked_at=now() WHERE user_id=$1',[admin]);await assert.rejects(list(admin),e=>e.code==='42501');
  for(const role of ['anon','authenticated']){await db.exec('SET ROLE '+role);await assert.rejects(list(),e=>e.code==='42501');await assert.rejects(q('SELECT * FROM workout_zone_member_projection'),e=>e.code==='42501');await db.exec('RESET ROLE');}
  await db.exec('SET ROLE service_role');await create();await assert.rejects(q("UPDATE members SET full_name='Bypass'"),e=>e.code==='42501');await db.exec('RESET ROLE');
});
