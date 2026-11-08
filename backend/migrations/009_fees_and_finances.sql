-- CREATED — NOT APPLIED — AWAITING MANUAL REVIEW. Requires base schema + 001–008.
-- Never run automatically. Back up first; see docs/fees_finances.md for preflight.
BEGIN;

-- numeric CHECK(value>=0) alone permits PostgreSQL NaN. Never turn corrupt legacy
-- money into a plausible report; require human reconciliation before deployment.
DO $$
DECLARE field record; invalid boolean;
BEGIN
  FOR field IN SELECT * FROM (VALUES
    ('payments','amount'),('payment_allocations','amount'),('refunds','amount'),('invoice_items','amount'),
    ('expenses','amount'),('trainer_payout_items','amount'),('trainer_payout_items','rule_value'),
    ('trainer_payout_rules','value'),('member_plans','price_snapshot'),('member_trainer_plan','price_snapshot'),
    ('gym_plans','list_price'),('trainer_plans','list_price')) AS money_fields(table_name,column_name) LOOP
    EXECUTE format('SELECT EXISTS(SELECT 1 FROM public.%I WHERE %I::text IN (''NaN'',''Infinity'',''-Infinity''))',field.table_name,field.column_name) INTO invalid;
    IF invalid THEN RAISE EXCEPTION 'Non-finite legacy money in %.% requires reconciliation',field.table_name,field.column_name; END IF;
  END LOOP;
END $$;

ALTER TABLE public.payments ADD COLUMN notes text NOT NULL DEFAULT '';
ALTER TABLE public.refunds ADD COLUMN kind text NOT NULL DEFAULT 'refund'
  CHECK(kind IN ('refund','reversal'));
ALTER TABLE public.expenses ADD COLUMN paid_on date;
ALTER TABLE public.expenses ADD COLUMN payment_method text
  CHECK(payment_method IN ('cash','upi','card','bank','other'));
ALTER TABLE public.expenses ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK(version>0);
ALTER TABLE public.expenses ADD COLUMN reversed_at timestamptz;
-- Existing paid expenses lacking payment facts remain visible as reconciliation
-- warnings; do not invent payment dates or methods for historical rows.

CREATE TABLE public.financial_requests (
  request_key uuid PRIMARY KEY, actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  action text NOT NULL, target_id uuid, fields jsonb NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.financial_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  action text NOT NULL, target_id uuid NOT NULL, before_state jsonb, after_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.refund_allocations (
  refund_id uuid NOT NULL REFERENCES public.refunds(id) ON DELETE RESTRICT,
  allocation_id uuid NOT NULL REFERENCES public.payment_allocations(id) ON DELETE RESTRICT,
  amount numeric(12,2) NOT NULL CHECK(amount>0), PRIMARY KEY(refund_id,allocation_id)
);
CREATE TABLE public.invoice_adjustments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  operation_id uuid NOT NULL,
  invoice_item_id uuid NOT NULL REFERENCES public.invoice_items(id) ON DELETE RESTRICT,
  amount numeric(12,2) NOT NULL CHECK(amount>0), reason text NOT NULL CHECK(length(btrim(reason))>0),
  actor_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX financial_events_target_idx ON public.financial_events(target_id,created_at);
CREATE INDEX refund_allocations_source_idx ON public.refund_allocations(allocation_id);
CREATE INDEX invoice_adjustments_item_idx ON public.invoice_adjustments(invoice_item_id);
CREATE INDEX invoice_adjustments_operation_idx ON public.invoice_adjustments(operation_id);

-- Fail safely on legacy duplicate charges; a human must reconcile, never delete.
CREATE UNIQUE INDEX financial_gym_charge_uq ON public.invoice_items(member_plan_id)
  WHERE member_plan_id IS NOT NULL;
CREATE UNIQUE INDEX financial_pt_charge_uq ON public.invoice_items(member_trainer_plan_id)
  WHERE member_trainer_plan_id IS NOT NULL;

-- Historical refunds used no line provenance. Apply the documented deterministic
-- FIFO allocation policy, only where the full original receipt was allocated.
DO $$
DECLARE r record; a record; remaining numeric; take numeric;
BEGIN
  IF EXISTS(SELECT 1 FROM public.payments p WHERE EXISTS(SELECT 1 FROM public.refunds old_refund WHERE old_refund.payment_id=p.id)
    AND p.amount<>(SELECT COALESCE(sum(amount),0) FROM public.payment_allocations WHERE payment_id=p.id)) THEN
    RAISE EXCEPTION 'Legacy refunded receipts require full allocation reconciliation before 009';
  END IF;
  FOR r IN SELECT * FROM public.refunds ORDER BY refunded_at,id LOOP
    remaining:=r.amount;
    FOR a IN SELECT p.id,p.amount-COALESCE((SELECT sum(amount) FROM public.refund_allocations WHERE allocation_id=p.id),0) available
      FROM public.payment_allocations p WHERE p.payment_id=r.payment_id ORDER BY p.created_at,p.id LOOP
      take:=least(remaining,a.available);
      IF take>0 THEN INSERT INTO public.refund_allocations VALUES(r.id,a.id,take); remaining:=remaining-take; END IF;
    END LOOP;
    IF remaining<>0 THEN RAISE EXCEPTION 'Legacy refund cannot be reconciled'; END IF;
  END LOOP;
END $$;

CREATE VIEW public.financial_line_balances AS
SELECT li.*,
  li.amount-COALESCE((SELECT sum(amount) FROM public.invoice_adjustments WHERE invoice_item_id=li.id),0) AS charge,
  COALESCE((SELECT sum(a.amount-COALESCE((SELECT sum(r.amount) FROM public.refund_allocations r WHERE r.allocation_id=a.id),0))
    FROM public.payment_allocations a JOIN public.payments p ON p.id=a.payment_id
    WHERE a.invoice_item_id=li.id AND p.status='completed'),0) AS collected
FROM public.invoice_items li;

-- Same columns/types preserve dependent member/trainer views from older migrations.
CREATE OR REPLACE VIEW public.invoice_balances AS
SELECT i.id AS invoice_id,i.member_id,i.invoice_number,i.due_date,i.status,
  COALESCE((SELECT sum(charge) FROM public.financial_line_balances WHERE invoice_id=i.id),0)::numeric(12,2) billed,
  COALESCE((SELECT sum(collected) FROM public.financial_line_balances WHERE invoice_id=i.id),0)::numeric(12,2) allocated
FROM public.invoices i;

CREATE OR REPLACE FUNCTION public.check_payment_allocation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE p public.payments%ROWTYPE; allocated numeric; item_total numeric; charge numeric;
BEGIN
  SELECT * INTO p FROM public.payments WHERE id=COALESCE(NEW.payment_id,OLD.payment_id) FOR UPDATE;
  PERFORM 1 FROM public.invoice_items WHERE id=COALESCE(NEW.invoice_item_id,OLD.invoice_item_id) FOR UPDATE;
  SELECT COALESCE(sum(amount),0) INTO allocated FROM public.payment_allocations WHERE payment_id=p.id;
  IF allocated>p.amount OR (allocated>0 AND p.status<>'completed') THEN
    RAISE EXCEPTION 'Invalid payment allocation' USING ERRCODE='23514';
  END IF;
  SELECT collected,financial_line_balances.charge INTO item_total,charge FROM public.financial_line_balances
    WHERE id=COALESCE(NEW.invoice_item_id,OLD.invoice_item_id);
  IF item_total>charge OR item_total<0 THEN RAISE EXCEPTION 'Invalid line balance' USING ERRCODE='23514'; END IF;
  RETURN NULL;
END $$;

-- Deferred triggers may fire after the definer RPC has returned. Their narrow
-- validation reads must not depend on raw service-role table privileges.
ALTER FUNCTION public.check_refund_total() SECURITY DEFINER;
ALTER FUNCTION public.check_refund_total() SET search_path=pg_catalog,public;

CREATE FUNCTION public.financial_require_actor(p_actor_id uuid,p_owner boolean DEFAULT false)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM public.workout_zone_require_plan_actor(p_actor_id);
  IF p_owner AND NOT EXISTS(SELECT 1 FROM public.users u WHERE u.id=p_actor_id AND u.active AND
    (lower(btrim(u.email))='aryapat1234@gmail.com' OR EXISTS(SELECT 1 FROM public.role_assignments g
      WHERE g.user_id=u.id AND g.role='owner' AND g.revoked_at IS NULL))) THEN
    RAISE EXCEPTION 'Owner required' USING ERRCODE='42501';
  END IF;
END $$;

CREATE FUNCTION public.financial_issue_purchase() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE bill uuid:=gen_random_uuid(); label text; kind text; actor uuid;
  purchase_date date:=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  IF NEW.price_snapshot=0 THEN RETURN NEW; END IF;
  actor:=NULLIF(current_setting('wz.financial_actor',true),'')::uuid;
  IF TG_TABLE_NAME='member_plans' THEN
    SELECT name INTO label FROM public.gym_plans WHERE id=NEW.gym_plan_id; kind:='gym';
  ELSE SELECT name INTO label FROM public.trainer_plans WHERE id=NEW.trainer_plan_id; kind:='personal_training'; END IF;
  INSERT INTO public.invoices(id,member_id,invoice_number,invoice_date,due_date,status,created_by)
    VALUES(bill,NEW.member_id,'WZ-'||bill::text,purchase_date,
      greatest(NEW.starts_on,purchase_date),'issued',actor);
  INSERT INTO public.invoice_items(invoice_id,member_id,member_plan_id,member_trainer_plan_id,item_type,description,amount,
    service_start,service_end,billing_key)
    VALUES(bill,NEW.member_id,CASE WHEN kind='gym' THEN NEW.id END,CASE WHEN kind<>'gym' THEN NEW.id END,
      kind,label,NEW.price_snapshot,NEW.starts_on,NEW.ends_on,'purchase:'||NEW.id::text);
  IF actor IS NOT NULL THEN
    INSERT INTO public.financial_events(actor_id,action,target_id,after_state)
      VALUES(actor,'issue_purchase',bill,jsonb_build_object('subscriptionId',NEW.id,'amount',NEW.price_snapshot::text));
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_issue_purchase AFTER INSERT ON public.member_plans FOR EACH ROW EXECUTE FUNCTION public.financial_issue_purchase();
CREATE TRIGGER financial_issue_purchase AFTER INSERT ON public.member_trainer_plan FOR EACH ROW EXECUTE FUNCTION public.financial_issue_purchase();

-- Capture the authenticated onboarding actor without changing migration 008.
CREATE FUNCTION public.financial_capture_actor() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  UPDATE public.invoices SET created_by=NEW.actor_user_id
    WHERE member_id=NEW.member_id AND created_by IS NULL AND status='issued';
  INSERT INTO public.financial_events(actor_id,action,target_id,after_state)
    SELECT NEW.actor_user_id,'issue_purchase',i.id,jsonb_build_object('memberId',NEW.member_id,'invoiceId',i.id)
      FROM public.invoices i WHERE i.member_id=NEW.member_id AND i.created_by=NEW.actor_user_id
      AND NOT EXISTS(SELECT 1 FROM public.financial_events e WHERE e.target_id=i.id AND e.action='issue_purchase');
  RETURN NEW;
END $$;
CREATE TRIGGER financial_onboarding_actor AFTER INSERT ON public.member_events
  FOR EACH ROW WHEN (NEW.action='create') EXECUTE FUNCTION public.financial_capture_actor();

CREATE FUNCTION public.financial_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  -- Only onboarding may fill a previously unknown invoice actor.
  IF TG_TABLE_NAME='invoices' AND TG_OP='UPDATE' THEN
    -- Nested branch is intentional: other ledger tables have no created_by field.
    IF OLD.created_by IS NULL AND NEW.created_by IS NOT NULL
      AND (to_jsonb(OLD)-'created_by')=(to_jsonb(NEW)-'created_by') THEN RETURN NEW; END IF;
  END IF;
  RAISE EXCEPTION 'Posted financial history is immutable; use compensating entries' USING ERRCODE='23514';
END $$;
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['payments','payment_allocations','refunds','refund_allocations','invoice_adjustments','financial_events','financial_requests','invoice_items','invoices'] LOOP
    EXECUTE format('CREATE TRIGGER financial_immutable BEFORE UPDATE OR DELETE ON public.%I FOR EACH ROW EXECUTE FUNCTION public.financial_immutable()',t);
  END LOOP;
END $$;

CREATE FUNCTION public.financial_subscription_immutable() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Subscription history must be retained' USING ERRCODE='23514'; END IF;
  IF (to_jsonb(OLD)-'status') IS DISTINCT FROM (to_jsonb(NEW)-'status')
    OR (OLD.status='cancelled' AND NEW.status<>'cancelled') THEN
    RAISE EXCEPTION 'Purchase terms are immutable; create a new subscription' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_subscription_immutable BEFORE UPDATE OR DELETE ON public.member_plans
  FOR EACH ROW EXECUTE FUNCTION public.financial_subscription_immutable();
CREATE TRIGGER financial_subscription_immutable BEFORE UPDATE OR DELETE ON public.member_trainer_plan
  FOR EACH ROW EXECUTE FUNCTION public.financial_subscription_immutable();

CREATE FUNCTION public.financial_expense_transition() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog,public AS $$
BEGIN
  IF TG_OP='DELETE' THEN RAISE EXCEPTION 'Expense history must be retained' USING ERRCODE='23514'; END IF;
  IF TG_OP='INSERT' THEN
    IF NEW.status<>'recorded' OR NEW.version<>1 OR NEW.paid_on IS NOT NULL OR NEW.reversed_at IS NOT NULL THEN
      RAISE EXCEPTION 'Expenses must start as unpaid drafts' USING ERRCODE='23514'; END IF;
    RETURN NEW;
  END IF;
  IF OLD.status='void' OR NEW.version<>OLD.version+1
    OR NEW.id<>OLD.id OR NEW.created_by IS DISTINCT FROM OLD.created_by OR NEW.created_at<>OLD.created_at
    OR (NEW.status='paid' AND (NEW.paid_on IS NULL OR NEW.payment_method IS NULL OR NEW.paid_on<NEW.incurred_on
      OR NEW.paid_on>(clock_timestamp() AT TIME ZONE 'Asia/Kolkata')::date))
    OR (NEW.status='void' AND NEW.reversed_at IS NULL) THEN
    RAISE EXCEPTION 'Invalid expense transition' USING ERRCODE='23514'; END IF;
  IF OLD.status='paid' AND (NEW.status<>'void' OR
    (to_jsonb(OLD)-ARRAY['status','version','reversed_at']) IS DISTINCT FROM
    (to_jsonb(NEW)-ARRAY['status','version','reversed_at'])) THEN
    RAISE EXCEPTION 'Paid expense facts are immutable' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER financial_expense_transition BEFORE INSERT OR UPDATE OR DELETE ON public.expenses
  FOR EACH ROW EXECUTE FUNCTION public.financial_expense_transition();

CREATE FUNCTION public.financial_mutate(p_actor_id uuid,p_request_key uuid,p_action text,p_id uuid,p_fields jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
#variable_conflict use_column
<<financial_command>>
DECLARE prior public.financial_requests%ROWTYPE; bill public.invoices%ROWTYPE; receipt public.payments%ROWTYPE;
  expense public.expenses%ROWTYPE; line record; v_id uuid:=gen_random_uuid(); member_id uuid;
  amount numeric; remaining numeric; take numeric; v_date date; method text; result jsonb; before_state jsonb;
  today date:=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date;
  plan record; start_date date; subscription_kind text; expected integer; allowed text[];
BEGIN
  -- Same first lock as 008: deletion/payment and renewal/cancel serialize safely.
  PERFORM pg_advisory_xact_lock(hashtextextended('workout-zone-members',0));
  PERFORM pg_advisory_xact_lock(hashtextextended('workout-zone-financials',0));
  PERFORM public.financial_require_actor(p_actor_id,p_action IN ('expense_create','expense_edit','expense_post','expense_reverse','adjust','legacy_bill'));
  PERFORM set_config('wz.financial_actor',p_actor_id::text,true);
  IF p_request_key IS NULL OR jsonb_typeof(p_fields) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid financial request' USING ERRCODE='22023'; END IF;
  SELECT * INTO prior FROM public.financial_requests WHERE request_key=p_request_key;
  IF FOUND THEN
    IF prior.actor_id<>p_actor_id OR prior.action<>p_action OR prior.target_id IS DISTINCT FROM p_id OR prior.fields<>p_fields THEN
      RAISE EXCEPTION 'Request key reused' USING ERRCODE='23505'; END IF;
    RETURN prior.result;
  END IF;
  allowed:=CASE p_action
    WHEN 'payment' THEN ARRAY['amount','date','method','reference','notes']
    WHEN 'refund' THEN ARRAY['amount','date','reason','reversal']
    WHEN 'adjust' THEN ARRAY['amount','reason']
    WHEN 'expense_create' THEN ARRAY['amount','incurredOn','category','description','reference']
    WHEN 'expense_edit' THEN ARRAY['amount','incurredOn','category','description','reference','version']
    WHEN 'expense_post' THEN ARRAY['date','method','version']
    WHEN 'expense_reverse' THEN ARRAY['reason','version']
    WHEN 'purchase' THEN ARRAY['memberId','kind','planId','trainerId','startDate']
    WHEN 'cancel' THEN ARRAY['kind','reason'] WHEN 'legacy_bill' THEN ARRAY['kind','reason'] WHEN 'restore' THEN ARRAY['reason'] END;
  IF allowed IS NULL OR p_fields-allowed<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid fields' USING ERRCODE='22023'; END IF;
  IF p_action IN ('payment','refund','adjust','expense_create','expense_edit') THEN
    IF COALESCE(p_fields->>'amount','')!~'^[0-9]{1,10}(\.[0-9]{1,2})?$' THEN RAISE EXCEPTION 'Invalid money precision' USING ERRCODE='22023'; END IF;
    amount:=(p_fields->>'amount')::numeric;
    IF amount<=0 OR amount>9999999999.99 THEN RAISE EXCEPTION 'Invalid amount' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_action IN ('payment','refund','expense_post') THEN
    v_date:=(p_fields->>'date')::date;
    IF v_date IS NULL OR v_date>today OR v_date<'1900-01-01' THEN RAISE EXCEPTION 'Invalid posting date' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_action IN ('payment','expense_post') THEN
    method:=p_fields->>'method';
    IF method IS NULL OR method NOT IN ('cash','upi','card','bank','other') THEN RAISE EXCEPTION 'Payment method required' USING ERRCODE='22023'; END IF;
  END IF;
  IF p_action IN ('refund','adjust','cancel','restore','expense_reverse','legacy_bill') AND
    (COALESCE(length(btrim(p_fields->>'reason')),0)<3 OR length(p_fields->>'reason')>2000) THEN
    RAISE EXCEPTION 'Reason required' USING ERRCODE='22023'; END IF;

  IF p_action IN ('payment','adjust') THEN
    SELECT * INTO bill FROM public.invoices WHERE id=p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Invoice not found' USING ERRCODE='P0002'; END IF;
    PERFORM 1 FROM public.members WHERE id=bill.member_id FOR UPDATE;
    IF bill.status<>'issued' THEN RAISE EXCEPTION 'Issued invoice required' USING ERRCODE='23514'; END IF;
    IF EXISTS(SELECT 1 FROM public.payments p WHERE p.invoice_id=p_id AND p.status='completed'
      AND p.amount<>(SELECT COALESCE(sum(a.amount),0) FROM public.payment_allocations a WHERE a.payment_id=p.id)) THEN
      RAISE EXCEPTION 'Legacy receipt allocation requires reconciliation before collection or adjustment' USING ERRCODE='23514'; END IF;
    SELECT billed-allocated INTO remaining FROM public.invoice_balances WHERE invoice_id=p_id;
    IF amount>remaining THEN RAISE EXCEPTION 'Amount exceeds outstanding balance' USING ERRCODE='23514'; END IF;
    IF p_action='payment' THEN
      IF v_date<bill.invoice_date OR length(COALESCE(p_fields->>'reference',''))>200 OR length(COALESCE(p_fields->>'notes',''))>2000 THEN
        RAISE EXCEPTION 'Invalid receipt details' USING ERRCODE='22023'; END IF;
      -- References are unique per method/provider, when present; retry by request UUID.
      INSERT INTO public.payments(id,invoice_id,amount,method,status,idempotency_key,received_at,received_by,provider,provider_payment_id,notes)
        VALUES(v_id,p_id,amount,method,'completed',p_request_key::text,v_date::timestamp AT TIME ZONE 'Asia/Kolkata',p_actor_id,
          CASE WHEN NULLIF(btrim(p_fields->>'reference'),'') IS NOT NULL THEN method END,
          NULLIF(btrim(p_fields->>'reference'),''),COALESCE(p_fields->>'notes',''));
    END IF;
    remaining:=amount;
    FOR line IN SELECT * FROM public.financial_line_balances WHERE invoice_id=p_id ORDER BY id LOOP
      take:=least(remaining,line.charge-line.collected);
      IF take>0 THEN
        IF p_action='payment' THEN INSERT INTO public.payment_allocations(payment_id,invoice_item_id,invoice_id,amount) VALUES(v_id,line.id,p_id,take);
        ELSE INSERT INTO public.invoice_adjustments(operation_id,invoice_item_id,amount,reason,actor_id) VALUES(v_id,line.id,take,btrim(p_fields->>'reason'),p_actor_id); END IF;
        remaining:=remaining-take;
      END IF;
    END LOOP;
    IF remaining<>0 THEN RAISE EXCEPTION 'Allocation mismatch' USING ERRCODE='23514'; END IF;
  ELSIF p_action='refund' THEN
    SELECT * INTO receipt FROM public.payments WHERE id=p_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Payment not found' USING ERRCODE='P0002'; END IF;
    PERFORM 1 FROM public.invoices WHERE id=receipt.invoice_id FOR UPDATE;
    SELECT receipt.amount-COALESCE(sum(amount),0) INTO remaining FROM public.refunds WHERE payment_id=p_id;
    IF receipt.status<>'completed' OR amount>remaining OR v_date<(receipt.received_at AT TIME ZONE 'Asia/Kolkata')::date
      OR (COALESCE((p_fields->>'reversal')::boolean,false) AND amount<>remaining) THEN
      RAISE EXCEPTION 'Invalid refund or reversal' USING ERRCODE='23514'; END IF;
    IF receipt.amount<>(SELECT COALESCE(sum(amount),0) FROM public.payment_allocations WHERE payment_id=p_id) THEN
      RAISE EXCEPTION 'Legacy receipt allocation requires reconciliation' USING ERRCODE='23514'; END IF;
    IF EXISTS(SELECT 1 FROM public.trainer_payout_items t JOIN public.payment_allocations a ON a.id=t.allocation_id
      JOIN public.trainer_payouts b ON b.id=t.payout_id WHERE a.payment_id=p_id AND b.status<>'cancelled') THEN
      RAISE EXCEPTION 'Trainer settlement review required' USING ERRCODE='23514'; END IF;
    INSERT INTO public.refunds(id,payment_id,amount,reason,idempotency_key,refunded_at,created_by,kind)
      VALUES(v_id,p_id,amount,btrim(p_fields->>'reason'),p_request_key::text,v_date::timestamp AT TIME ZONE 'Asia/Kolkata',p_actor_id,
        CASE WHEN COALESCE((p_fields->>'reversal')::boolean,false) THEN 'reversal' ELSE 'refund' END);
    remaining:=amount;
    FOR line IN SELECT a.id,a.amount-COALESCE((SELECT sum(amount) FROM public.refund_allocations WHERE allocation_id=a.id),0) available
      FROM public.payment_allocations a WHERE a.payment_id=p_id ORDER BY a.created_at,a.id LOOP
      take:=least(remaining,line.available);
      IF take>0 THEN INSERT INTO public.refund_allocations VALUES(v_id,line.id,take); remaining:=remaining-take; END IF;
    END LOOP;
    IF remaining<>0 THEN RAISE EXCEPTION 'Refund allocation mismatch' USING ERRCODE='23514'; END IF;
  ELSIF p_action LIKE 'expense_%' THEN
    IF p_action<>'expense_create' THEN
      SELECT * INTO expense FROM public.expenses WHERE id=p_id FOR UPDATE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Expense not found' USING ERRCODE='P0002'; END IF;
      before_state:=to_jsonb(expense);
      expected:=(p_fields->>'version')::integer;
      IF expected IS NULL OR expected<>expense.version OR expense.status='void' THEN RAISE EXCEPTION 'Stale expense' USING ERRCODE='23514'; END IF;
      v_id:=p_id;
    END IF;
    IF p_action IN ('expense_create','expense_edit') THEN
      IF p_action='expense_edit' AND expense.status<>'recorded' THEN RAISE EXCEPTION 'Only drafts may be edited' USING ERRCODE='23514'; END IF;
      IF p_fields->>'category' IS NULL OR p_fields->>'category' NOT IN ('Rent','Electricity','Equipment','Maintenance','Salaries','Cleaning','Marketing','Miscellaneous')
        OR COALESCE(length(btrim(p_fields->>'description')),0) NOT BETWEEN 3 AND 2000
        OR length(COALESCE(p_fields->>'reference',''))>200 OR (p_fields->>'incurredOn')::date IS NULL
        OR (p_fields->>'incurredOn')::date<'1900-01-01' THEN RAISE EXCEPTION 'Invalid expense' USING ERRCODE='22023'; END IF;
      IF p_action='expense_create' THEN
        INSERT INTO public.expenses(id,incurred_on,category,description,amount,external_reference,created_by)
          VALUES(v_id,(p_fields->>'incurredOn')::date,p_fields->>'category',btrim(p_fields->>'description'),amount,p_fields->>'reference',p_actor_id);
      ELSE UPDATE public.expenses SET incurred_on=(p_fields->>'incurredOn')::date,category=p_fields->>'category',description=btrim(p_fields->>'description'),
        amount=financial_command.amount,external_reference=p_fields->>'reference',version=version+1 WHERE id=p_id; END IF;
    ELSIF p_action='expense_post' THEN
      IF expense.status<>'recorded' OR v_date<expense.incurred_on THEN RAISE EXCEPTION 'Invalid expense posting' USING ERRCODE='23514'; END IF;
      UPDATE public.expenses SET status='paid',paid_on=v_date,payment_method=method,version=version+1 WHERE id=p_id;
    ELSE
      IF expense.status='paid' AND (expense.paid_on IS NULL OR expense.payment_method IS NULL) THEN
        RAISE EXCEPTION 'Legacy expense payment facts require reconciliation' USING ERRCODE='23514'; END IF;
      UPDATE public.expenses SET status='void',reversed_at=clock_timestamp(),version=version+1 WHERE id=p_id;
    END IF;
  ELSIF p_action='legacy_bill' THEN
    -- Explicit owner approval only: never silently backfill old memberships.
    subscription_kind:=p_fields->>'kind';
    IF subscription_kind='GYM' THEN
      SELECT s.*,p.name INTO plan FROM public.member_plans s JOIN public.gym_plans p ON p.id=s.gym_plan_id WHERE s.id=p_id FOR UPDATE OF s;
    ELSIF subscription_kind='PT' THEN
      SELECT s.*,p.name INTO plan FROM public.member_trainer_plan s JOIN public.trainer_plans p ON p.id=s.trainer_plan_id WHERE s.id=p_id FOR UPDATE OF s;
    ELSE RAISE EXCEPTION 'Invalid subscription kind' USING ERRCODE='22023'; END IF;
    IF plan.id IS NULL THEN RAISE EXCEPTION 'Subscription not found' USING ERRCODE='P0002'; END IF;
    IF plan.price_snapshot<=0 OR EXISTS(SELECT 1 FROM public.invoice_items WHERE member_plan_id=p_id OR member_trainer_plan_id=p_id) THEN
      RAISE EXCEPTION 'Free or already billed subscription' USING ERRCODE='23514'; END IF;
    PERFORM 1 FROM public.members WHERE id=plan.member_id FOR UPDATE;
    INSERT INTO public.invoices(id,member_id,invoice_number,invoice_date,due_date,status,created_by)
      VALUES(v_id,plan.member_id,'WZ-'||v_id::text,today,greatest(today,plan.starts_on),'issued',p_actor_id);
    INSERT INTO public.invoice_items(invoice_id,member_id,member_plan_id,member_trainer_plan_id,item_type,description,amount,service_start,service_end,billing_key)
      VALUES(v_id,plan.member_id,CASE WHEN subscription_kind='GYM' THEN p_id END,CASE WHEN subscription_kind='PT' THEN p_id END,
        CASE WHEN subscription_kind='GYM' THEN 'gym' ELSE 'personal_training' END,plan.name,plan.price_snapshot,plan.starts_on,plan.ends_on,'purchase:'||p_id::text);
  ELSIF p_action='purchase' THEN
    member_id:=(p_fields->>'memberId')::uuid; subscription_kind:=p_fields->>'kind'; start_date:=(p_fields->>'startDate')::date;
    PERFORM 1 FROM public.members m WHERE m.id=member_id AND m.status='active' AND m.deleted_at IS NULL AND m.joined_on<=start_date FOR UPDATE;
    IF NOT FOUND OR start_date IS NULL OR subscription_kind IS NULL OR subscription_kind NOT IN ('GYM','PT') THEN RAISE EXCEPTION 'Active member and valid dates required' USING ERRCODE='23514'; END IF;
    IF subscription_kind='GYM' THEN
      SELECT id,duration_days,list_price INTO plan FROM public.gym_plans WHERE id=(p_fields->>'planId')::uuid AND active AND deleted_at IS NULL FOR SHARE;
    ELSE
      SELECT id,duration_days,list_price INTO plan FROM public.trainer_plans WHERE id=(p_fields->>'planId')::uuid AND active AND deleted_at IS NULL FOR SHARE;
      PERFORM 1 FROM public.trainers WHERE id=(p_fields->>'trainerId')::uuid AND status='active' FOR SHARE;
      IF NOT FOUND THEN RAISE EXCEPTION 'Active trainer required' USING ERRCODE='23514'; END IF;
    END IF;
    IF plan.id IS NULL OR plan.duration_days NOT BETWEEN 1 AND 36500 OR plan.list_price NOT BETWEEN 0 AND 9999999999.99
      OR start_date>'9999-12-31'::date-(plan.duration_days-1) THEN RAISE EXCEPTION 'Invalid plan' USING ERRCODE='23514'; END IF;
    -- Same purchase dates/plan cannot accidentally be renewed with a new key.
    IF (subscription_kind='GYM' AND EXISTS(SELECT 1 FROM public.member_plans s WHERE s.member_id=financial_command.member_id AND s.gym_plan_id=plan.id AND s.starts_on=start_date))
      OR (subscription_kind='PT' AND EXISTS(SELECT 1 FROM public.member_trainer_plan s WHERE s.member_id=financial_command.member_id AND s.trainer_plan_id=plan.id AND s.starts_on=start_date)) THEN
      RAISE EXCEPTION 'Duplicate purchase' USING ERRCODE='23505'; END IF;
    IF subscription_kind='GYM' THEN
      INSERT INTO public.member_plans(id,member_id,gym_plan_id,starts_on,ends_on,price_snapshot) VALUES(v_id,member_id,plan.id,start_date,start_date+plan.duration_days-1,plan.list_price);
    ELSE INSERT INTO public.member_trainer_plan(id,member_id,trainer_plan_id,trainer_id,starts_on,ends_on,price_snapshot)
      VALUES(v_id,member_id,plan.id,(p_fields->>'trainerId')::uuid,start_date,start_date+plan.duration_days-1,plan.list_price); END IF;
  ELSIF p_action='cancel' THEN
    IF p_fields->>'kind'='GYM' THEN
      SELECT to_jsonb(s) INTO before_state FROM public.member_plans s WHERE id=p_id AND status<>'cancelled' FOR UPDATE;
      UPDATE public.member_plans SET status='cancelled' WHERE id=p_id AND status<>'cancelled';
    ELSIF p_fields->>'kind'='PT' THEN
      SELECT to_jsonb(s) INTO before_state FROM public.member_trainer_plan s WHERE id=p_id AND status<>'cancelled' FOR UPDATE;
      UPDATE public.member_trainer_plan SET status='cancelled' WHERE id=p_id AND status<>'cancelled';
    ELSE RAISE EXCEPTION 'Invalid subscription kind' USING ERRCODE='22023'; END IF;
    IF before_state IS NULL THEN RAISE EXCEPTION 'Subscription missing or already cancelled' USING ERRCODE='23514'; END IF;
    v_id:=p_id;
  ELSIF p_action='restore' THEN
    SELECT to_jsonb(m) INTO before_state FROM public.members m WHERE id=p_id AND (deleted_at IS NOT NULL OR status='inactive') FOR UPDATE;
    IF before_state IS NULL THEN RAISE EXCEPTION 'Archived member not found' USING ERRCODE='P0002'; END IF;
    UPDATE public.members SET status='active',deleted_at=NULL WHERE id=p_id;
    v_id:=p_id;
  ELSE RAISE EXCEPTION 'Unknown action' USING ERRCODE='22023'; END IF;
  result:=jsonb_build_object('id',v_id,'action',p_action);
  IF p_action='adjust' THEN result:=result||jsonb_build_object('invoiceId',p_id); END IF;
  INSERT INTO public.financial_events(actor_id,action,target_id,before_state,after_state)
    VALUES(p_actor_id,p_action,v_id,before_state,p_fields||result);
  INSERT INTO public.financial_requests(request_key,actor_id,action,target_id,fields,result)
    VALUES(p_request_key,p_actor_id,p_action,p_id,p_fields,result);
  RETURN result;
EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow OR numeric_value_out_of_range THEN
  RAISE EXCEPTION 'Invalid financial values' USING ERRCODE='22023';
END $$;

CREATE FUNCTION public.financial_check_compensation() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE source public.refunds%ROWTYPE; a public.payment_allocations%ROWTYPE;
BEGIN
  IF TG_TABLE_NAME='invoices' THEN
    IF NEW.status='issued' AND NOT EXISTS(SELECT 1 FROM public.invoice_items WHERE invoice_id=NEW.id) THEN
      RAISE EXCEPTION 'Issued invoice must contain a charge' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='payments' THEN
    IF NEW.status='completed' AND COALESCE((SELECT sum(amount) FROM public.payment_allocations WHERE payment_id=NEW.id),0)<>NEW.amount THEN
      RAISE EXCEPTION 'New completed receipt must be fully allocated' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='refunds' THEN
    IF COALESCE((SELECT sum(amount) FROM public.refund_allocations WHERE refund_id=NEW.id),0)<>NEW.amount THEN
      RAISE EXCEPTION 'Refund must be fully line allocated' USING ERRCODE='23514'; END IF;
  ELSIF TG_TABLE_NAME='refund_allocations' THEN
    SELECT * INTO source FROM public.refunds WHERE id=NEW.refund_id FOR UPDATE;
    SELECT * INTO a FROM public.payment_allocations WHERE id=NEW.allocation_id FOR UPDATE;
    IF a.payment_id<>source.payment_id
      OR (SELECT sum(amount) FROM public.refund_allocations WHERE allocation_id=a.id)>a.amount
      OR (SELECT sum(amount) FROM public.refund_allocations WHERE refund_id=source.id)<>source.amount THEN
      RAISE EXCEPTION 'Invalid refund provenance' USING ERRCODE='23514'; END IF;
  ELSE
    PERFORM 1 FROM public.invoice_items WHERE id=NEW.invoice_item_id FOR UPDATE;
    IF EXISTS(SELECT 1 FROM public.financial_line_balances WHERE id=NEW.invoice_item_id AND (charge<collected OR charge<0)) THEN
      RAISE EXCEPTION 'Invalid adjustment balance' USING ERRCODE='23514'; END IF;
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER financial_refund_integrity AFTER INSERT ON public.refund_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.financial_check_compensation();
CREATE CONSTRAINT TRIGGER financial_refund_total_integrity AFTER INSERT ON public.refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.financial_check_compensation();
CREATE CONSTRAINT TRIGGER financial_receipt_total_integrity AFTER INSERT ON public.payments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.financial_check_compensation();
CREATE CONSTRAINT TRIGGER financial_invoice_issue_integrity AFTER INSERT ON public.invoices
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.financial_check_compensation();
CREATE CONSTRAINT TRIGGER financial_adjustment_integrity AFTER INSERT ON public.invoice_adjustments
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.financial_check_compensation();

-- One checked read, no N+1 HTTP queries. Backend performs exact Decimal reports.
CREATE FUNCTION public.financial_read(p_actor_id uuid,p_owner boolean DEFAULT false)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb; as_of date:=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  PERFORM public.financial_require_actor(p_actor_id,p_owner);
  PERFORM pg_advisory_xact_lock(hashtextextended('workout-zone-financials',0));
  SELECT jsonb_build_object(
    'asOfDate',as_of,
    'archivedMembers',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',m.id,'name',m.full_name,'memberNumber',m.member_number))
      FROM public.members m WHERE m.status='inactive' OR m.deleted_at IS NOT NULL),'[]'::jsonb),
    'unbilled',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',s.id,'kind',s.kind,'memberName',m.full_name,
      'planName',s.name,'amount',s.price_snapshot::text,'startDate',s.starts_on,'endDate',s.ends_on,'status',s.status)) FROM (
        SELECT s.id,s.member_id,'GYM'::text kind,p.name,s.price_snapshot,s.starts_on,s.ends_on,s.status FROM public.member_plans s JOIN public.gym_plans p ON p.id=s.gym_plan_id
          WHERE s.price_snapshot>0 AND NOT EXISTS(SELECT 1 FROM public.invoice_items WHERE member_plan_id=s.id)
        UNION ALL SELECT s.id,s.member_id,'PT'::text,p.name,s.price_snapshot,s.starts_on,s.ends_on,s.status FROM public.member_trainer_plan s JOIN public.trainer_plans p ON p.id=s.trainer_plan_id
          WHERE s.price_snapshot>0 AND NOT EXISTS(SELECT 1 FROM public.invoice_items WHERE member_trainer_plan_id=s.id)
      ) s JOIN public.members m ON m.id=s.member_id),'[]'::jsonb),
    'obligations',COALESCE((SELECT jsonb_agg(jsonb_build_object(
      'id',i.id,'memberId',m.id,'memberName',m.full_name,'memberNumber',m.member_number,
      'archived',m.deleted_at IS NOT NULL OR m.status='inactive','invoiceNumber',i.invoice_number,'invoiceDate',i.invoice_date,
      'dueDate',i.due_date,'status',i.status,'total',b.billed::text,'paid',b.allocated::text,'balance',(b.billed-b.allocated)::text,
      'reconciliationRequired',EXISTS(SELECT 1 FROM public.payments p WHERE p.invoice_id=i.id AND p.status='completed'
        AND p.amount<>(SELECT COALESCE(sum(a.amount),0) FROM public.payment_allocations a WHERE a.payment_id=p.id)),
      'lastPaymentDate',(SELECT max((received_at AT TIME ZONE 'Asia/Kolkata')::date) FROM public.payments WHERE invoice_id=i.id AND status='completed'),
      'adjustments',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'operationId',a.operation_id,'amount',a.amount::text,
        'reason',a.reason,'createdAt',a.created_at,'createdBy',u.display_name)) FROM public.invoice_adjustments a
        JOIN public.invoice_items li ON li.id=a.invoice_item_id LEFT JOIN public.users u ON u.id=a.actor_id WHERE li.invoice_id=i.id),'[]'::jsonb),
      'lines',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',li.id,'description',li.description,'amount',li.charge::text,'originalAmount',li.amount::text,
        'subscriptionId',COALESCE(li.member_plan_id,li.member_trainer_plan_id),'kind',CASE WHEN li.item_type='gym' THEN 'GYM' ELSE 'PT' END,
        'startDate',li.service_start,'endDate',li.service_end,
        'membershipStatus',CASE WHEN COALESCE((SELECT status FROM public.member_plans WHERE id=li.member_plan_id),
          (SELECT status FROM public.member_trainer_plan WHERE id=li.member_trainer_plan_id))='cancelled' THEN 'Cancelled'
          WHEN li.service_start>as_of THEN 'Upcoming'
          WHEN li.service_end<as_of THEN 'Expired'
          WHEN li.service_end IS NOT NULL THEN 'Active' ELSE 'Not applicable' END)) FROM public.financial_line_balances li WHERE li.invoice_id=i.id),'[]'::jsonb)))
      FROM public.invoices i JOIN public.members m ON m.id=i.member_id JOIN public.invoice_balances b ON b.invoice_id=i.id),'[]'::jsonb),
    'payments',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'invoiceId',p.invoice_id,'amount',p.amount::text,
      'date',(COALESCE(p.received_at,p.created_at) AT TIME ZONE 'Asia/Kolkata')::date,'method',p.method,'status',p.status,'reference',COALESCE(p.provider_payment_id,''),
      'notes',p.notes,'createdBy',u.display_name,'createdAt',p.created_at,
      'allocations',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',a.id,'lineId',a.invoice_item_id,'amount',a.amount::text)) FROM public.payment_allocations a WHERE a.payment_id=p.id),'[]'::jsonb)))
      FROM public.payments p LEFT JOIN public.users u ON u.id=p.received_by),'[]'::jsonb),
    'refunds',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',r.id,'paymentId',r.payment_id,'amount',r.amount::text,
      'date',(r.refunded_at AT TIME ZONE 'Asia/Kolkata')::date,'kind',r.kind,'reason',r.reason,'createdBy',u.display_name,
      'createdAt',COALESCE((SELECT min(e.created_at) FROM public.financial_events e WHERE e.target_id=r.id AND e.action='refund'),r.refunded_at),
      'allocations',COALESCE((SELECT jsonb_agg(jsonb_build_object('allocationId',a.allocation_id,'amount',a.amount::text)) FROM public.refund_allocations a WHERE a.refund_id=r.id),'[]'::jsonb)))
      FROM public.refunds r LEFT JOIN public.users u ON u.id=r.created_by),'[]'::jsonb)
  ) INTO result;
  IF p_owner THEN
    result:=result||jsonb_build_object(
      'expenses',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',e.id,'incurredOn',e.incurred_on,'date',e.paid_on,
        'category',e.category,'description',e.description,'amount',e.amount::text,'method',e.payment_method,'status',e.status,
        'reference',COALESCE(e.external_reference,''),'createdBy',u.display_name,'version',e.version,
        'reversedDate',(e.reversed_at AT TIME ZONE 'Asia/Kolkata')::date)) FROM public.expenses e LEFT JOIN public.users u ON u.id=e.created_by),'[]'::jsonb),
      'payouts',COALESCE((SELECT jsonb_agg(jsonb_build_object('id',p.id,'date',(p.paid_at AT TIME ZONE 'Asia/Kolkata')::date,
        'amount',COALESCE((SELECT sum(amount) FROM public.trainer_payout_items WHERE payout_id=p.id),0)::text,
        'name',t.full_name,'reference',p.payment_reference)) FROM public.trainer_payouts p JOIN public.trainers t ON t.id=p.trainer_id WHERE p.status='paid'),'[]'::jsonb),
      'events',COALESCE((SELECT jsonb_agg(to_jsonb(e)) FROM public.financial_events e),'[]'::jsonb));
  END IF;
  RETURN result;
END $$;

-- Close every raw browser/service write. Checked RPCs are the only mutation path.
CREATE FUNCTION public.financial_request_status(p_actor_id uuid,p_request_key uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.financial_require_actor(p_actor_id);
  PERFORM pg_advisory_xact_lock(hashtextextended('workout-zone-financials',0));
  SELECT r.result INTO result FROM public.financial_requests r
    WHERE request_key=p_request_key AND actor_id=p_actor_id;
  RETURN result;
END $$;

DO $$ DECLARE t text; r text; fn record; BEGIN
  FOREACH t IN ARRAY ARRAY['financial_requests','financial_events','refund_allocations','invoice_adjustments','expenses','payments','payment_allocations','refunds','invoices','invoice_items'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',t);
    FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON public.%I FROM %I',t,r); END IF;
    END LOOP;
  END LOOP;
  REVOKE ALL ON public.financial_line_balances FROM PUBLIC;
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON public.financial_line_balances FROM %I',r);
    END IF;
  END LOOP;
  FOR fn IN SELECT p.oid::regprocedure signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND (p.proname LIKE 'financial_%' OR p.proname IN ('check_payment_allocation','check_refund_total')) LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
    FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',fn.signature,r); END IF;
    END LOOP;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT EXECUTE ON FUNCTION public.financial_read(uuid,boolean),public.financial_mutate(uuid,uuid,text,uuid,jsonb),public.financial_request_status(uuid,uuid) TO service_role;
  END IF;
END $$;
NOTIFY pgrst,'reload schema';
COMMIT;
