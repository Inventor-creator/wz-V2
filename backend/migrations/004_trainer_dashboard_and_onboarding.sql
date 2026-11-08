-- Additive: requires migrations 001, 002 and 003. Never replay gym_schema.sql.
BEGIN;

-- Custom Google sessions do not establish auth.uid(). Keep direct browser
-- database access closed; the backend and these checked RPCs are the boundary.
DO $$
DECLARE table_name text; browser_role text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['members','trainers','trainer_plans','member_trainer_plan',
    'trainer_payout_rules','trainer_payouts','trainer_payout_items','invoices','invoice_items',
    'payments','payment_allocations','refunds'] LOOP
    EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',table_name);
    EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC',table_name);
    FOREACH browser_role IN ARRAY ARRAY['anon','authenticated'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=browser_role) THEN
        EXECUTE format('REVOKE ALL ON public.%I FROM %I',table_name,browser_role);
      END IF;
    END LOOP;
  END LOOP;
  REVOKE ALL ON public.invoice_balances FROM PUBLIC;
  FOREACH browser_role IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=browser_role) THEN
      EXECUTE format('REVOKE ALL ON public.invoice_balances FROM %I',browser_role);
    END IF;
  END LOOP;
END;
$$;

CREATE OR REPLACE FUNCTION public.workout_zone_grant_new_trainer(
  p_actor_id uuid, p_action text, p_name text, p_phone text DEFAULT NULL,
  p_assignment_id uuid DEFAULT NULL, p_email text DEFAULT NULL, p_display_name text DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE profile_id uuid; contact_email text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('workout-zone-access-management',0));
  PERFORM public.workout_zone_require_access_actor(p_actor_id);
  IF p_action NOT IN ('create','update') OR p_action IS NULL OR length(btrim(p_name))<2 OR p_name IS NULL THEN
    RAISE EXCEPTION 'Trainer name and supported action required' USING ERRCODE='22023';
  END IF;
  IF p_action='create' THEN
    contact_email:=lower(btrim(p_email));
  ELSE
    SELECT u.email INTO contact_email FROM public.role_assignments ra
    JOIN public.users u ON u.id=ra.user_id WHERE ra.id=p_assignment_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Assignment not found' USING ERRCODE='P0002'; END IF;
    IF p_email IS NOT NULL AND lower(btrim(p_email))<>contact_email THEN
      RAISE EXCEPTION 'Account identity cannot change' USING ERRCODE='22023';
    END IF;
  END IF;
  IF contact_email='aryapat1234@gmail.com' THEN
    RAISE EXCEPTION 'Permanent Super Admin cannot change' USING ERRCODE='42501';
  END IF;
  IF contact_email IS NULL OR length(contact_email)<4 THEN
    RAISE EXCEPTION 'Authorized email required' USING ERRCODE='22023';
  END IF;
  INSERT INTO public.trainers(full_name,email,phone,status)
  VALUES(btrim(p_name),contact_email,NULLIF(btrim(p_phone),''),'active') RETURNING id INTO profile_id;
  -- Same transaction and advisory lock as ordinary grants: any failure rolls
  -- back the trainer profile, pending user, grant and audit event together.
  RETURN public.workout_zone_mutate_access(
    p_actor_id,p_action,p_assignment_id,p_email,'trainer',profile_id,true,'ACTIVE',
    COALESCE(p_display_name,btrim(p_name))
  );
END;
$$;

CREATE OR REPLACE FUNCTION public.workout_zone_trainer_scope(p_actor_id uuid)
RETURNS TABLE(can_choose boolean,trainer_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor_email text; actor_active boolean; own_trainer uuid;
BEGIN
  SELECT email,active INTO actor_email,actor_active FROM public.users WHERE id=p_actor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown actor' USING ERRCODE='42501'; END IF;
  IF actor_email='aryapat1234@gmail.com' THEN RETURN QUERY SELECT true,NULL::uuid; RETURN; END IF;
  IF NOT actor_active THEN RAISE EXCEPTION 'Inactive actor' USING ERRCODE='42501'; END IF;
  IF EXISTS(SELECT 1 FROM public.role_assignments WHERE user_id=p_actor_id AND role='owner' AND revoked_at IS NULL) THEN
    RETURN QUERY SELECT true,NULL::uuid; RETURN;
  END IF;
  -- Match the effective-role priority used by /auth/me. Receptionists cannot
  -- fall back to a lower-priority trainer grant to open this dashboard.
  IF EXISTS(SELECT 1 FROM public.role_assignments WHERE user_id=p_actor_id AND role='admin' AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Dashboard not allowed' USING ERRCODE='42501';
  END IF;
  SELECT ra.trainer_id INTO own_trainer FROM public.role_assignments ra
  WHERE ra.user_id=p_actor_id AND ra.role='trainer' AND ra.revoked_at IS NULL;
  IF own_trainer IS NULL THEN RAISE EXCEPTION 'No trainer link' USING ERRCODE='42501'; END IF;
  RETURN QUERY SELECT false,own_trainer;
END;
$$;

CREATE OR REPLACE FUNCTION public.workout_zone_resolve_trainer(p_actor_id uuid,p_trainer_id uuid DEFAULT NULL)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE chooser boolean; own_id uuid; selected_id uuid;
BEGIN
  SELECT can_choose,trainer_id INTO chooser,own_id FROM public.workout_zone_trainer_scope(p_actor_id);
  IF NOT chooser THEN
    IF p_trainer_id IS NOT NULL AND p_trainer_id<>own_id THEN
      RAISE EXCEPTION 'Other trainer forbidden' USING ERRCODE='42501';
    END IF;
    RETURN own_id;
  END IF;
  IF p_trainer_id IS NOT NULL THEN
    SELECT id INTO selected_id FROM public.trainers WHERE id=p_trainer_id;
    IF NOT FOUND THEN RAISE EXCEPTION 'Trainer not found' USING ERRCODE='P0002'; END IF;
  ELSE
    SELECT id INTO selected_id FROM public.trainers ORDER BY (status='active') DESC,full_name,id LIMIT 1;
  END IF;
  RETURN selected_id;
END;
$$;

CREATE OR REPLACE VIEW public.workout_zone_training_rows AS
SELECT s.id,s.trainer_id,s.member_id,s.trainer_plan_id AS plan_id,m.full_name,p.name AS plan_name,
  s.starts_on,s.ends_on,s.price_snapshot,
  (s.ends_on-(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date) AS days_remaining,
  CASE WHEN s.starts_on>(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date THEN 'Upcoming'
       WHEN s.ends_on<(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date THEN 'Expired'
       WHEN s.ends_on<=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date+7 THEN 'Expiring Soon'
       ELSE 'Active' END AS training_status,
  jsonb_build_object(
    'id',s.id,'memberId',m.id,'fullName',m.full_name,'email',COALESCE(m.email,''),'phone',COALESCE(m.phone,''),
    'planId',p.id,'planName',p.name,'startDate',s.starts_on,'endDate',s.ends_on,
    'priceAtPurchase',s.price_snapshot,'daysRemaining',s.ends_on-(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date,
    'status',CASE WHEN s.starts_on>(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date THEN 'Upcoming'
       WHEN s.ends_on<(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date THEN 'Expired'
       WHEN s.ends_on<=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date+7 THEN 'Expiring Soon' ELSE 'Active' END
  ) AS payload
FROM public.member_trainer_plan s JOIN public.members m ON m.id=s.member_id
JOIN public.trainer_plans p ON p.id=s.trainer_plan_id
WHERE s.status<>'cancelled' AND m.status='active';
REVOKE ALL ON public.workout_zone_training_rows FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.workout_zone_trainer_options(p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE chooser boolean; own_id uuid; result jsonb;
BEGIN
  SELECT can_choose,trainer_id INTO chooser,own_id FROM public.workout_zone_trainer_scope(p_actor_id);
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'name',full_name,'email',COALESCE(email,''),
    'phone',COALESCE(phone,''),'isActive',status='active') ORDER BY full_name,id),'[]'::jsonb)
  INTO result FROM public.trainers WHERE chooser OR id=own_id;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.workout_zone_trainer_payout_estimate(p_trainer_id uuid,p_start date,p_end date)
RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
WITH receipts AS (
  SELECT a.id,a.amount,(p.received_at AT TIME ZONE 'Asia/Kolkata')::date AS collection_date,
    EXISTS(SELECT 1 FROM public.refunds r WHERE r.payment_id=p.id) AS refunded
  FROM public.payment_allocations a JOIN public.payments p ON p.id=a.payment_id
  JOIN public.invoice_items li ON li.id=a.invoice_item_id JOIN public.invoices i ON i.id=li.invoice_id
  JOIN public.member_trainer_plan s ON s.id=li.member_trainer_plan_id
  WHERE s.trainer_id=p_trainer_id AND p.status='completed' AND i.status='issued'
    AND (p.received_at AT TIME ZONE 'Asia/Kolkata')::date BETWEEN p_start AND p_end
    AND NOT EXISTS(SELECT 1 FROM public.trainer_payout_items pi WHERE pi.allocation_id=a.id)
), rated AS (
  SELECT r.*,rule.n,rule.kind,rule.value FROM receipts r
  CROSS JOIN LATERAL (
    SELECT count(*) AS n,min(kind) AS kind,min(value) AS value FROM public.trainer_payout_rules pr
    WHERE pr.trainer_id=p_trainer_id AND pr.effective_from<=r.collection_date
      AND (pr.effective_until IS NULL OR pr.effective_until>=r.collection_date)
  ) rule
), stats AS (
  SELECT count(*) AS n,count(*) FILTER(WHERE refunded) AS refunds,
    count(*) FILTER(WHERE NOT refunded AND n=0) AS missing,
    count(*) FILTER(WHERE NOT refunded AND (n>1 OR kind<>'percent')) AS invalid,
    COALESCE(sum(round(amount*value/100,2)) FILTER(WHERE NOT refunded AND n=1 AND kind='percent'),0) AS amount
  FROM rated
), current_rule AS (
  SELECT count(*) AS n,min(kind) AS kind FROM public.trainer_payout_rules
  WHERE trainer_id=p_trainer_id AND effective_from<=p_end AND (effective_until IS NULL OR effective_until>=p_end)
), decision AS (
  SELECT s.*, CASE
    WHEN s.refunds>0 OR s.invalid>0 OR (s.n=0 AND (c.n>1 OR c.kind='fixed')) THEN 'REVIEW_REQUIRED'
    WHEN s.missing>0 OR (s.n=0 AND c.n=0) THEN 'NOT_CONFIGURED'
    ELSE 'CONFIGURED' END AS state
  FROM stats s CROSS JOIN current_rule c
)
SELECT jsonb_build_object('status',state,'amount',CASE WHEN state='CONFIGURED' THEN amount ELSE NULL END,
  'note',CASE WHEN refunds>0 THEN 'Refunded receipts require review; line-level refund attribution is unavailable.'
    WHEN state='REVIEW_REQUIRED' THEN 'Fixed or overlapping rules require a defined payout policy.'
    WHEN state='NOT_CONFIGURED' THEN 'No applicable commission rule for the reporting period or collection date.'
    ELSE 'This month’s unsettled collected PT allocations; already reserved payout sources excluded.' END)
FROM decision;
$$;

CREATE OR REPLACE FUNCTION public.workout_zone_trainer_dashboard(
  p_actor_id uuid,p_trainer_id uuid DEFAULT NULL,p_search text DEFAULT '',p_plan_id uuid DEFAULT NULL,
  p_status text DEFAULT '',p_page integer DEFAULT 1,p_page_size integer DEFAULT 8
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE selected_id uuid; profile jsonb; summary jsonb; rows_json jsonb; plans_json jsonb;
  total_rows integer; current_page integer; payout jsonb;
  today date:=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date;
  period_start date:=date_trunc('month',CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  selected_id:=public.workout_zone_resolve_trainer(p_actor_id,p_trainer_id);
  IF p_page<1 OR p_page_size<1 OR p_page_size>100 OR p_status NOT IN ('','Active','Expired','Expiring Soon','Upcoming') THEN
    RAISE EXCEPTION 'Invalid pagination or status' USING ERRCODE='22023';
  END IF;
  SELECT jsonb_build_object('id',id,'name',full_name,'email',COALESCE(email,''),'phone',COALESCE(phone,''),'isActive',status='active')
  INTO profile FROM public.trainers WHERE id=selected_id;
  payout:=public.workout_zone_trainer_payout_estimate(selected_id,period_start,today);
  SELECT jsonb_build_object('totalAssignedMembers',count(DISTINCT member_id),
    'activeTrainingMembers',count(DISTINCT member_id) FILTER(WHERE starts_on<=today AND ends_on>=today),
    'planValue',COALESCE(sum(price_snapshot),0),'estimatedPayout',payout->'amount',
    'payoutStatus',payout->>'status','payoutNote',payout->>'note','periodStart',period_start,'periodEnd',today)
  INTO summary FROM public.workout_zone_training_rows WHERE trainer_id=selected_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',plan_id,'name',plan_name) ORDER BY plan_name),'[]'::jsonb)
  INTO plans_json FROM (SELECT DISTINCT plan_id,plan_name FROM public.workout_zone_training_rows WHERE trainer_id=selected_id) x;
  SELECT count(*) INTO total_rows FROM public.workout_zone_training_rows
  WHERE trainer_id=selected_id AND strpos(lower(full_name),lower(btrim(COALESCE(p_search,''))))>0
    AND (p_plan_id IS NULL OR plan_id=p_plan_id) AND (p_status='' OR training_status=p_status);
  current_page:=LEAST(p_page,GREATEST(1,ceil(total_rows::numeric/p_page_size)::integer));
  SELECT COALESCE(jsonb_agg(payload ORDER BY days_remaining,full_name,id),'[]'::jsonb) INTO rows_json
  FROM (SELECT id,payload,days_remaining,full_name FROM public.workout_zone_training_rows
    WHERE trainer_id=selected_id AND strpos(lower(full_name),lower(btrim(COALESCE(p_search,''))))>0
      AND (p_plan_id IS NULL OR plan_id=p_plan_id) AND (p_status='' OR training_status=p_status)
    ORDER BY days_remaining,full_name,id LIMIT p_page_size OFFSET (current_page-1)*p_page_size) x;
  RETURN jsonb_build_object('trainer',profile,'summary',summary,'rows',rows_json,'plans',plans_json,
    'total',total_rows,'page',current_page,'pageSize',p_page_size);
END;
$$;

CREATE OR REPLACE FUNCTION public.workout_zone_trainer_member(p_actor_id uuid,p_member_id uuid,p_trainer_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE selected_id uuid; profile jsonb; history jsonb;
BEGIN
  selected_id:=public.workout_zone_resolve_trainer(p_actor_id,p_trainer_id);
  SELECT jsonb_build_object('id',m.id,'fullName',m.full_name,'email',COALESCE(m.email,''),
    'phone',COALESCE(m.phone,''),'joiningDate',m.joined_on) INTO profile
  FROM public.members m WHERE m.id=p_member_id AND m.status='active'
    AND EXISTS(SELECT 1 FROM public.workout_zone_training_rows r WHERE r.member_id=m.id AND r.trainer_id=selected_id);
  IF profile IS NULL THEN RAISE EXCEPTION 'Assigned member not found' USING ERRCODE='P0002'; END IF;
  SELECT jsonb_agg(payload ORDER BY starts_on DESC,id) INTO history FROM public.workout_zone_training_rows
  WHERE member_id=p_member_id AND trainer_id=selected_id;
  RETURN jsonb_build_object('member',profile,'trainingHistory',history);
END;
$$;

-- Revoke default function privileges explicitly, including Supabase defaults.
DO $$
DECLARE fn record; role_name text;
BEGIN
  FOR fn IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('workout_zone_grant_new_trainer','workout_zone_trainer_scope',
      'workout_zone_resolve_trainer','workout_zone_trainer_options','workout_zone_trainer_payout_estimate',
      'workout_zone_trainer_dashboard','workout_zone_trainer_member')
  LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
    FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',fn.signature,role_name);
      END IF;
    END LOOP;
  END LOOP;
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN
      EXECUTE format('REVOKE ALL ON public.workout_zone_training_rows FROM %I',role_name);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT SELECT ON public.trainers TO service_role;
    GRANT EXECUTE ON FUNCTION public.workout_zone_grant_new_trainer(uuid,text,text,text,uuid,text,text),
      public.workout_zone_trainer_options(uuid),public.workout_zone_trainer_dashboard(uuid,uuid,text,uuid,text,integer,integer),
      public.workout_zone_trainer_member(uuid,uuid,uuid) TO service_role;
  END IF;
END;
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
