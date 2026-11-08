import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {test, beforeEach, afterEach} from 'node:test';
import assert from 'node:assert/strict';
const {PGlite} = await import(process.env.PGLITE_MODULE ? pathToFileURL(process.env.PGLITE_MODULE).href : '@electric-sql/pglite');
const read = p => readFile(new URL(p, import.meta.url), 'utf8');
let db, root, trainer, member;
const query = async (sql, values=[]) => (await db.query(sql, values)).rows;
const mutate = async (action, fields={}, id=null, actor=root) => (await query('SELECT workout_zone_mutate_trainer_plan($1,$2,$3,$4::jsonb) AS data', [actor,action,id,JSON.stringify(fields)]))[0].data;
const create = (name='PT Essential', price=1000) => mutate('create',{name, price, duration:30, durationUnit:'DAY'});
const list = async (actor=root) => (await query('SELECT workout_zone_list_trainer_plans($1) AS data',[actor]))[0].data;
const purchase = async (planId, trainerId=trainer) => (await query("INSERT INTO member_trainer_plan(member_id,trainer_id,trainer_plan_id,starts_on,ends_on,price_snapshot) VALUES($1,$2,$3,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date,1000) RETURNING *",[member,trainerId,planId]))[0];
beforeEach(async () => {
  db = new PGlite();
  await db.exec((await read('../docs/gym_schema.sql')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
  for(const file of ['001_google_identity_bootstrap_admin.sql','002_access_management.sql','003_delete_access_assignments.sql','004_trainer_dashboard_and_onboarding.sql','005_membership_plan_crud.sql']) await db.exec(await read('../migrations/'+file));
  // Existing catalogue rows and assignments must survive migration unchanged.
  root = (await query("INSERT INTO users(email,display_name) VALUES('aryapat1234@gmail.com','Root') RETURNING id"))[0].id;
  trainer = (await query("INSERT INTO trainers(full_name) VALUES('Coach') RETURNING id"))[0].id;
  member = (await query("INSERT INTO members(member_number,full_name) VALUES('M001','Member') RETURNING id"))[0].id;
  await db.exec("INSERT INTO trainer_plans(name,duration_days,list_price) VALUES('Existing PT',45,1234.56)");
  await query("INSERT INTO member_trainer_plan(member_id,trainer_id,trainer_plan_id,starts_on,ends_on,price_snapshot) SELECT $1,$2,id,current_date-45,current_date-1,987.65 FROM trainer_plans WHERE name='Existing PT'",[member,trainer]);
  await db.exec(await read('../migrations/006_trainer_plan_crud.sql'));
});
afterEach(async () => { await db.close(); });

test('006 preserves existing catalogue IDs/terms and supports shared CRUD and free plans', async () => {
  const existing = (await list())[0];
  assert.equal(existing.name,'Existing PT'); assert.equal(existing.duration,45); assert.equal(existing.price,1234.56); assert.equal(existing.description,'');
  assert.equal(existing.hasHistory,true);
  const historical = (await query('SELECT * FROM member_trainer_plan'))[0];
  assert.equal(historical.trainer_plan_id,existing.id); assert.equal(Number(historical.price_snapshot),987.65);
  const plan = await create('Free trial',0);
  assert.equal(plan.price,0); assert.equal(plan.durationUnit,'DAY'); assert.equal(plan.hasHistory,false); assert.equal(plan.activeMembersCount,0);
  assert.ok(!('trainerId' in plan));
  const updated = await mutate('update',{description:'Coaching',isActive:false,price:123.45},plan.id);
  assert.equal(updated.price,123.45); assert.equal(updated.isActive,false);
  assert.equal((await query('SELECT workout_zone_get_trainer_plan($1,$2) AS data',[root,plan.id]))[0].data.description,'Coaching');
  assert.equal((await mutate('delete',{},plan.id)).mode,'DELETED');
  assert.equal((await query('SELECT id FROM trainer_plans WHERE id=$1',[plan.id])).length,0);
  const event = (await query("SELECT * FROM trainer_plan_events WHERE action='delete'"))[0];
  assert.equal(event.plan_id,null); assert.equal(event.old_state.id,plan.id);
});

test('SQL rejects invalid fields, duplicate/reserved names and missing plans', async () => {
  const plan = await create();
  for(const fields of [{name:' '},{name:123},{price:-1},{price:1.001},{price:'NaN'},{duration:0},{duration:1.5},{duration:36501},{duration:null},{durationUnit:'MONTH'},{isActive:'true'},{description:null},{trainerId:trainer},{activeMembersCount:1},{}])
    await assert.rejects(mutate('update',fields,plan.id),e=>e.code==='22023');
  await assert.rejects(create(),e=>e.code==='23505');
  await assert.rejects(mutate('create',{name:'Missing fields'}),e=>e.code==='22023');
  await mutate('delete',{},plan.id);
  await assert.rejects(mutate('delete',{},plan.id),e=>e.code==='P0002');
  await assert.rejects(query('SELECT workout_zone_get_trainer_plan($1,$2)',[root,plan.id]),e=>e.code==='P0002');
});

test('role checks allow live owners/admins, deny trainers, revoked/inactive/unknown actors', async () => {
  for(const role of ['owner','admin','trainer']) {
    const actor = (await query('INSERT INTO users(email,display_name) VALUES($1,$1) RETURNING id',[role+'@example.com']))[0].id;
    await query('INSERT INTO role_assignments(user_id,role,trainer_id) VALUES($1,$2,$3)',[actor,role,role==='trainer'?trainer:null]);
    if(role==='trainer') {
      await assert.rejects(list(actor),e=>e.code==='42501');
      await assert.rejects(mutate('create',{name:'Forbidden',price:1,duration:1},null,actor),e=>e.code==='42501');
    } else {
      assert.equal((await list(actor)).length,1);
      const plan = await mutate('create',{name:role+' plan',price:1,duration:1},null,actor);
      await mutate('delete',{},plan.id,actor);
      await query('UPDATE users SET active=false WHERE id=$1',[actor]);
      await assert.rejects(list(actor),e=>e.code==='42501');
      await query('UPDATE users SET active=true WHERE id=$1',[actor]);
      await query('UPDATE role_assignments SET revoked_at=now() WHERE user_id=$1',[actor]);
      await assert.rejects(list(actor),e=>e.code==='42501');
    }
  }
  await assert.rejects(list('00000000-0000-0000-0000-000000000000'),e=>e.code==='42501');
});

test('active counts are distinct, inclusive, and exclude future/cancelled/inactive members', async () => {
  const plan = await create();
  await purchase(plan.id); await purchase(plan.id);
  assert.equal((await list()).find(p=>p.id===plan.id).activeMembersCount,1);
  await query("UPDATE member_trainer_plan SET status='cancelled'");
  assert.equal((await list()).find(p=>p.id===plan.id).activeMembersCount,0);
  await query("UPDATE member_trainer_plan SET status='active',starts_on=starts_on+1,ends_on=ends_on+1");
  assert.equal((await list()).find(p=>p.id===plan.id).activeMembersCount,0);
  await query("UPDATE member_trainer_plan SET starts_on=starts_on-1,ends_on=ends_on-1");
  await query("UPDATE members SET status='inactive'");
  assert.equal((await list()).find(p=>p.id===plan.id).activeMembersCount,0);
});

test('shared plan purchases permit different trainers and reject inactive trainers/plans', async () => {
  const plan = await create(); await purchase(plan.id);
  const other = (await query("INSERT INTO trainers(full_name) VALUES('Second Coach') RETURNING id"))[0].id;
  await purchase(plan.id,other);
  await mutate('update',{isActive:false},plan.id);
  await assert.rejects(purchase(plan.id),e=>e.code==='23514');
  await mutate('update',{isActive:true},plan.id);
  await query("UPDATE trainers SET status='inactive' WHERE id=$1",[trainer]);
  await assert.rejects(purchase(plan.id),e=>e.code==='23514');
  await purchase(plan.id,other);
});

test('editing/deleting referenced plans preserves assignments, invoice/payment/payout provenance', async () => {
  const plan = await create(); const subscription = await purchase(plan.id);
  const invoice = (await query("INSERT INTO invoices(member_id,invoice_number,due_date,status) VALUES($1,'INV001',current_date,'issued') RETURNING id",[member]))[0].id;
  const item = (await query("INSERT INTO invoice_items(invoice_id,member_id,member_trainer_plan_id,item_type,description,amount,billing_key) VALUES($1,$2,$3,'personal_training','Original PT',1000,'PT001') RETURNING id",[invoice,member,subscription.id]))[0].id;
  const payment = (await query("INSERT INTO payments(invoice_id,amount,method,status,idempotency_key,received_at) VALUES($1,1000,'cash','completed','PAY001',now()) RETURNING id",[invoice]))[0].id;
  const allocation = (await query('INSERT INTO payment_allocations(payment_id,invoice_item_id,invoice_id,amount) VALUES($1,$2,$3,1000) RETURNING id',[payment,item,invoice]))[0].id;
  const payout = (await query("INSERT INTO trainer_payouts(trainer_id,period_start,period_end) VALUES($1,current_date,current_date) RETURNING id",[trainer]))[0].id;
  await query("INSERT INTO trainer_payout_items(payout_id,trainer_id,allocation_id,rule_kind,rule_value,amount) VALUES($1,$2,$3,'percent',40,400)",[payout,trainer,allocation]);
  const snapshot = async () => Promise.all(['member_trainer_plan','invoice_items','payments','payment_allocations','trainer_payouts','trainer_payout_items'].map(table=>query(`SELECT * FROM ${table} ORDER BY id`)));
  const before = await snapshot();
  await mutate('update',{price:2000,duration:90,name:'Updated PT'},plan.id);
  assert.equal((await mutate('delete',{},plan.id)).mode,'REMOVED_FROM_CATALOG');
  assert.deepEqual(await snapshot(),before);
  const dashboard = (await query('SELECT workout_zone_trainer_dashboard($1,$2) AS data',[root,trainer]))[0].data;
  const historicalRow = dashboard.rows.find(r=>r.id===subscription.id);
  assert.equal(historicalRow.planId,plan.id); assert.equal(historicalRow.priceAtPurchase,1000);
  const drawer = (await query('SELECT workout_zone_trainer_member($1,$2,$3) AS data',[root,member,trainer]))[0].data;
  assert.ok(drawer.trainingHistory.some(s=>s.id===subscription.id));
  assert.equal((await list()).some(p=>p.id===plan.id),false);
  assert.equal((await query('SELECT active FROM trainer_plans WHERE id=$1',[plan.id]))[0].active,false);
  await assert.rejects(purchase(plan.id),e=>e.code==='23514');
  await assert.rejects(mutate('update',{isActive:true},plan.id),e=>e.code==='P0002');
  await assert.rejects(create('Updated PT'),e=>e.code==='23505');
  // Catalogue removal does not block existing assignment lifecycle updates.
  await query("UPDATE member_trainer_plan SET status='expired' WHERE id=$1",[subscription.id]);
});

test('browser roles cannot read catalogue/invoke RPCs; service role cannot bypass mutation audits', async () => {
  for(const role of ['anon','authenticated']) {
    await db.exec('SET ROLE '+role);
    await assert.rejects(list(),e=>e.code==='42501');
    await assert.rejects(query('SELECT * FROM trainer_plans'),e=>e.code==='42501');
    await assert.rejects(query('SELECT * FROM trainer_plan_events'),e=>e.code==='42501');
    await db.exec('RESET ROLE');
  }
  await db.exec('SET ROLE service_role');
  assert.equal((await list()).length,1);
  await create('Checked service plan');
  await assert.rejects(query("INSERT INTO trainer_plans(name,duration_days,list_price) VALUES('Bypass',30,1)"),e=>e.code==='42501');
  await assert.rejects(query('SELECT * FROM workout_zone_trainer_plan_projection'),e=>e.code==='42501');
  await db.exec('RESET ROLE');
});
