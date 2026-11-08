import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {randomUUID} from 'node:crypto';
import {test} from 'node:test';
import assert from 'node:assert/strict';
const {PGlite}=await import(process.env.PGLITE_MODULE?pathToFileURL(process.env.PGLITE_MODULE).href:'@electric-sql/pglite');
const read=p=>readFile(new URL(p,import.meta.url),'utf8');
test('trainer dashboard and onboarding using the complete migration chain',async t=>{
 const db=new PGlite();
 try{
  await db.exec((await read('../docs/gym_schema.sql')).replace('CREATE EXTENSION IF NOT EXISTS pgcrypto;',''));
  await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role BYPASSRLS;');
  for(const file of ['001_google_identity_bootstrap_admin.sql','002_access_management.sql','003_delete_access_assignments.sql','004_trainer_dashboard_and_onboarding.sql'])await db.exec(await read('../migrations/'+file));
  const user=async email=>(await db.query('INSERT INTO users(email,display_name) VALUES($1,$1) RETURNING id',[email])).rows[0].id;
  const root=await user('aryapat1234@gmail.com'),owner=await user('owner@example.com'),coach=await user('coach@example.com'),admin=await user('admin@example.com');
  const a=(await db.query("INSERT INTO trainers(full_name) VALUES('Coach A') RETURNING id")).rows[0].id;
  const b=(await db.query("INSERT INTO trainers(full_name) VALUES('Coach B') RETURNING id")).rows[0].id;
  await db.query("INSERT INTO role_assignments(user_id,role,trainer_id) VALUES($1,'owner',NULL),($2,'trainer',$3),($4,'admin',NULL)",[owner,coach,a,admin]);
  const plan=(await db.query("INSERT INTO trainer_plans(name,duration_days,list_price) VALUES('Shared catalog plan',30,9999) RETURNING id")).rows[0].id;
  const member=async(name,status='active')=>(await db.query('INSERT INTO members(member_number,full_name,status) VALUES($1,$2,$3) RETURNING id',[randomUUID(),name,status])).rows[0].id;
  const sub=async(m,tr,start,end,price=1000,status='active')=>(await db.query("INSERT INTO member_trainer_plan(member_id,trainer_id,trainer_plan_id,starts_on,ends_on,price_snapshot,status) VALUES($1,$2,$3,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date+$4::int,(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date+$5::int,$6,$7) RETURNING id",[m,tr,plan,start,end,price,status])).rows[0].id;
  const current=await member('Current Member'),expired=await member('Expired Member'),upcoming=await member('Upcoming Member'),secret=await member('Other Trainer Secret');
  const currentSub=await sub(current,a,-10,0,1234.56);await sub(expired,a,-30,-2,2000);await sub(upcoming,a,5,30,3000);
  await sub(secret,b,-5,20);await sub(await member('Inactive Secret','inactive'),a,-5,20);await sub(await member('Cancelled Secret'),a,-5,20,1000,'cancelled');
  const dash=async(actor=coach,trainer=null,search='',status='',page=1,size=8)=>(await db.query('SELECT workout_zone_trainer_dashboard($1,$2,$3,NULL,$4,$5,$6) AS data',[actor,trainer,search,status,page,size])).rows[0].data;
  await t.test('trainer sees only own subscriptions, original prices, numeric expiry and inclusive end day',async()=>{
    const d=await dash();assert.equal(d.trainer.id,a);assert.equal(d.total,3);assert.equal(d.rows[0].fullName,'Expired Member');
    assert.deepEqual(d.rows.map(r=>r.daysRemaining),[-2,0,30]);assert.equal(d.summary.activeTrainingMembers,1);assert.equal(d.summary.totalAssignedMembers,3);
    assert.equal(d.summary.planValue,6234.56);assert.equal(d.rows[1].priceAtPurchase,1234.56);assert.equal(d.rows[2].status,'Upcoming');
    assert.equal(JSON.stringify(d).includes('Secret'),false);assert.equal(d.summary.estimatedPayout,null);
  });
  await t.test('search, status, pagination and plan options stay trainer scoped',async()=>{
    assert.equal((await dash(coach,null,'Expired')).total,1);assert.equal((await dash(coach,null,'','Upcoming')).rows[0].memberId,upcoming);
    const d=await dash(coach,null,'','',2,1);assert.equal(d.page,2);assert.equal(d.rows.length,1);assert.equal(d.total,3);assert.equal(d.plans[0].id,plan);
  });
  await t.test('owners may select trainers; trainer ID spoofing and reception access are denied',async()=>{
    assert.equal((await dash(owner,b)).rows[0].memberId,secret);assert.equal((await dash(root,b)).trainer.id,b);
    await assert.rejects(dash(coach,b),e=>e.code==='42501');await assert.rejects(dash(admin,a),e=>e.code==='42501');
    const options=(await db.query('SELECT workout_zone_trainer_options($1) AS data',[coach])).rows[0].data;assert.deepEqual(options.map(t=>t.id),[a]);
  });
  await t.test('member drawer excludes invoices, gym subscriptions and other trainers',async()=>{
    const d=(await db.query('SELECT workout_zone_trainer_member($1,$2,NULL) AS data',[coach,current])).rows[0].data;
    assert.equal(d.member.id,current);assert.equal(d.trainingHistory.length,1);assert.equal('invoices' in d,false);assert.equal('notes' in d.member,false);
    await assert.rejects(db.query('SELECT workout_zone_trainer_member($1,$2,NULL)',[coach,secret]),e=>e.code==='P0002');
  });
  const invoice=(await db.query("INSERT INTO invoices(member_id,invoice_number,due_date,status) VALUES($1,$2,current_date,'issued') RETURNING id",[current,randomUUID()])).rows[0].id;
  const line=(await db.query("INSERT INTO invoice_items(invoice_id,member_id,member_trainer_plan_id,item_type,description,amount,billing_key) VALUES($1,$2,$3,'personal_training','PT fee',1000,$4) RETURNING id",[invoice,current,currentSub,randomUUID()])).rows[0].id;
  const payment=(await db.query("INSERT INTO payments(invoice_id,amount,method,status,idempotency_key,received_at) VALUES($1,1000,'upi','completed',$2,now()) RETURNING id",[invoice,randomUUID()])).rows[0].id;
  const allocation=(await db.query('INSERT INTO payment_allocations(payment_id,invoice_item_id,invoice_id,amount) VALUES($1,$2,$3,800) RETURNING id',[payment,line,invoice])).rows[0].id;
  const rule=(await db.query("INSERT INTO trainer_payout_rules(trainer_id,kind,value,effective_from) VALUES($1,'percent',40,current_date-30) RETURNING id",[a])).rows[0].id;
  await t.test('commission is based on actual PT allocations, not plan values or whole receipts',async()=>{assert.equal((await dash()).summary.estimatedPayout,320);});
  await t.test('overlapping and undefined fixed rules do not invent estimates',async()=>{
    const overlap=(await db.query("INSERT INTO trainer_payout_rules(trainer_id,kind,value,effective_from) VALUES($1,'fixed',500,current_date-30) RETURNING id",[a])).rows[0].id;
    assert.equal((await dash()).summary.payoutStatus,'REVIEW_REQUIRED');assert.equal((await dash()).summary.estimatedPayout,null);
    await db.query('DELETE FROM trainer_payout_rules WHERE id=$1',[overlap]);
    await db.query("UPDATE trainer_payout_rules SET kind='fixed',value=500 WHERE id=$1",[rule]);assert.equal((await dash()).summary.payoutStatus,'REVIEW_REQUIRED');
    await db.query("UPDATE trainer_payout_rules SET kind='percent',value=40,effective_from=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date+1 WHERE id=$1",[rule]);assert.equal((await dash()).summary.payoutStatus,'NOT_CONFIGURED');
    await db.query('UPDATE trainer_payout_rules SET effective_from=current_date-30 WHERE id=$1',[rule]);
  });
  await t.test('refunded receipts require review; reserved payout allocations are excluded',async()=>{
    const refund=(await db.query("INSERT INTO refunds(payment_id,amount,reason,idempotency_key) VALUES($1,100,'Fixture adjustment',$2) RETURNING id",[payment,randomUUID()])).rows[0].id;
    assert.equal((await dash()).summary.payoutStatus,'REVIEW_REQUIRED');await db.query('DELETE FROM refunds WHERE id=$1',[refund]);
    const payout=(await db.query('INSERT INTO trainer_payouts(trainer_id,period_start,period_end) VALUES($1,current_date,current_date) RETURNING id',[a])).rows[0].id;
    await db.query("INSERT INTO trainer_payout_items(payout_id,trainer_id,allocation_id,rule_id,rule_kind,rule_value,amount) VALUES($1,$2,$3,$4,'percent',40,320)",[payout,a,allocation,rule]);
    assert.equal((await dash()).summary.estimatedPayout,0);
  });
  await t.test('create-and-link trainer access commits profile, user, grant and audit together',async()=>{
    const result=(await db.query("SELECT workout_zone_grant_new_trainer($1,'create','New Coach','9876543210',NULL,'newcoach@example.com',NULL) AS data",[root])).rows[0].data;
    const profile=(await db.query('SELECT * FROM trainers WHERE id=$1',[result.trainerId])).rows[0];assert.equal(profile.email,'newcoach@example.com');assert.equal(profile.full_name,'New Coach');
    const before=(await db.query('SELECT count(*)::int AS n FROM trainers')).rows[0].n;
    await assert.rejects(db.query("SELECT workout_zone_grant_new_trainer($1,'create','Duplicate',NULL,NULL,'newcoach@example.com',NULL)",[root]),e=>e.code==='23505');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM trainers')).rows[0].n,before);
    await assert.rejects(db.query("SELECT workout_zone_grant_new_trainer($1,'create','Forbidden Self',NULL,NULL,'aryapat1234@gmail.com',NULL)",[root]),e=>e.code==='42501');
    assert.equal((await db.query('SELECT count(*)::int AS n FROM trainers')).rows[0].n,before);
    assert.equal((await db.query('SELECT google_subject FROM users WHERE id=$1',[result.userId])).rows[0].google_subject,null);
  });
  await t.test('unauthorized onboarding and revoked trainer queries fail closed',async()=>{
    await assert.rejects(db.query("SELECT workout_zone_grant_new_trainer($1,'create','Forbidden',NULL,NULL,'blocked@example.com',NULL)",[admin]),e=>e.code==='42501');
    await db.query('UPDATE users SET active=false WHERE id=$1',[coach]);await assert.rejects(dash(),e=>e.code==='42501');await db.query('UPDATE users SET active=true WHERE id=$1',[coach]);
    await db.query("UPDATE role_assignments SET revoked_at=now() WHERE user_id=$1 AND role='trainer'",[coach]);await assert.rejects(dash(),e=>e.code==='42501');
  });
  await t.test('browser roles cannot call trainer RPCs or private views',async()=>{
    await db.exec('SET ROLE authenticated');await assert.rejects(dash(),e=>e.code==='42501');await assert.rejects(db.query('SELECT * FROM workout_zone_training_rows'),e=>e.code==='42501');await db.exec('RESET ROLE');
    await db.exec('SET ROLE anon');await assert.rejects(db.query('SELECT full_name FROM members'),e=>e.code==='42501');await assert.rejects(db.query('SELECT * FROM invoice_balances'),e=>e.code==='42501');await db.exec('RESET ROLE');
    await db.exec('SET ROLE service_role');assert.equal((await dash(owner,a)).trainer.id,a);await assert.rejects(db.query('SELECT * FROM workout_zone_training_rows'),e=>e.code==='42501');await db.exec('RESET ROLE');
  });
 }finally{await db.close();}
});
