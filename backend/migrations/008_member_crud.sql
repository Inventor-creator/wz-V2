-- Additive after 001–007. Never replay the base schema or overwrite prior migrations.
BEGIN;
ALTER TABLE public.members ADD COLUMN notes text NOT NULL DEFAULT '';
ALTER TABLE public.members ADD COLUMN deleted_at timestamptz;
ALTER TABLE public.members ADD CONSTRAINT members_deleted_inactive CHECK(deleted_at IS NULL OR status='inactive');
CREATE TABLE public.member_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  member_id uuid REFERENCES public.members(id) ON DELETE SET NULL,
  action text NOT NULL CHECK(action IN ('create','update','delete')),
  old_state jsonb, new_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE public.member_onboarding_requests (
  request_key uuid PRIMARY KEY,
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  member_id uuid REFERENCES public.members(id) ON DELETE SET NULL,
  fields jsonb NOT NULL, result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.member_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_onboarding_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.member_events,public.member_onboarding_requests FROM PUBLIC;

CREATE VIEW public.workout_zone_member_subscriptions AS
WITH source AS (
  SELECT s.id,s.member_id,'GYM'::text AS kind,s.gym_plan_id AS plan_id,p.name AS plan_name,
    NULL::uuid AS trainer_id,NULL::text AS trainer_name,s.starts_on,s.ends_on,s.price_snapshot,s.status AS state,s.created_at
    FROM public.member_plans s JOIN public.gym_plans p ON p.id=s.gym_plan_id
  UNION ALL
  SELECT s.id,s.member_id,'PT',s.trainer_plan_id,p.name,s.trainer_id,t.full_name,s.starts_on,s.ends_on,s.price_snapshot,s.status,s.created_at
    FROM public.member_trainer_plan s JOIN public.trainer_plans p ON p.id=s.trainer_plan_id JOIN public.trainers t ON t.id=s.trainer_id
)
SELECT source.*,jsonb_build_object('id',id,'type',kind,'planId',plan_id,'planName',plan_name,
  'trainerId',trainer_id,'trainerName',trainer_name,'startDate',starts_on,'endDate',ends_on,'priceAtPurchase',price_snapshot,
  'daysRemaining',ends_on-(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date,
  'status',CASE WHEN state='cancelled' THEN 'Cancelled'
    WHEN starts_on>(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date THEN 'Upcoming'
    WHEN ends_on<(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date THEN 'Expired'
    WHEN ends_on<=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date+7 THEN 'Expiring Soon' ELSE 'Active' END) AS payload
FROM source;

CREATE VIEW public.workout_zone_member_current_subscriptions AS
SELECT DISTINCT ON(member_id,kind) * FROM public.workout_zone_member_subscriptions
WHERE state<>'cancelled'
ORDER BY member_id,kind,
  CASE WHEN starts_on<=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date AND ends_on>=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date THEN 0
    WHEN starts_on>(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date THEN 1 ELSE 2 END,
  CASE WHEN starts_on>(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date THEN starts_on END ASC,
  ends_on DESC,created_at DESC,id DESC;

CREATE VIEW public.workout_zone_member_projection AS
SELECT m.id,m.deleted_at,profile.payload AS profile,
  profile.payload||jsonb_build_object('gym',g.payload,'pt',pt.payload,
    'membershipStatus',CASE WHEN m.status='inactive' THEN 'Archived' ELSE COALESCE(g.payload->>'status','No plan') END,
    'outstandingAmount',COALESCE((SELECT sum(billed-allocated) FROM public.invoice_balances b WHERE b.member_id=m.id AND b.status='issued'),0)) AS payload
FROM public.members m
CROSS JOIN LATERAL (SELECT jsonb_build_object('id',m.id,'memberNumber',m.member_number,'fullName',m.full_name,
  'email',COALESCE(m.email,''),'phone',COALESCE(m.phone,''),'joiningDate',m.joined_on,'notes',m.notes,
  'status',CASE WHEN m.status='active' THEN 'ACTIVE' ELSE 'ARCHIVED' END) AS payload) profile
LEFT JOIN public.workout_zone_member_current_subscriptions g ON g.member_id=m.id AND g.kind='GYM'
LEFT JOIN public.workout_zone_member_current_subscriptions pt ON pt.member_id=m.id AND pt.kind='PT';
REVOKE ALL ON public.workout_zone_member_subscriptions,public.workout_zone_member_current_subscriptions,public.workout_zone_member_projection FROM PUBLIC;

CREATE FUNCTION public.workout_zone_list_members(p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE rows jsonb; stats jsonb;
BEGIN
  PERFORM public.workout_zone_require_plan_actor(p_actor_id);
  SELECT COALESCE(jsonb_agg(payload ORDER BY lower(payload->>'fullName'),id),'[]'::jsonb),
    jsonb_build_object('activeMembers',count(*) FILTER(WHERE payload->>'membershipStatus' IN ('Active','Expiring Soon')),
      'expiringSoon',count(*) FILTER(WHERE payload->>'membershipStatus'='Expiring Soon'),
      'expiredMemberships',count(*) FILTER(WHERE payload->>'membershipStatus'='Expired'))
    INTO rows,stats FROM public.workout_zone_member_projection WHERE deleted_at IS NULL;
  RETURN jsonb_build_object('members',rows,'summary',stats||jsonb_build_object('outstandingAmount',
    COALESCE((SELECT sum(billed-allocated) FROM public.invoice_balances WHERE status='issued'),0)));
END;
$$;

CREATE FUNCTION public.workout_zone_member_options(p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE gym jsonb; pt jsonb; coaches jsonb;
BEGIN
  PERFORM public.workout_zone_require_plan_actor(p_actor_id);
  SELECT COALESCE(jsonb_agg(payload ORDER BY lower(payload->>'name'),id),'[]'::jsonb) INTO gym
    FROM public.workout_zone_membership_plan_projection WHERE deleted_at IS NULL AND (payload->>'isActive')::boolean;
  SELECT COALESCE(jsonb_agg(payload ORDER BY lower(payload->>'name'),id),'[]'::jsonb) INTO pt
    FROM public.workout_zone_trainer_plan_projection WHERE deleted_at IS NULL AND (payload->>'isActive')::boolean;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'name',full_name,'email',COALESCE(email,''),'phone',COALESCE(phone,''),'isActive',true)
    ORDER BY lower(full_name),id),'[]'::jsonb) INTO coaches FROM public.trainers WHERE status='active';
  RETURN jsonb_build_object('membershipPlans',gym,'personalTrainingPlans',pt,'trainers',coaches);
END;
$$;

CREATE FUNCTION public.workout_zone_get_member(p_actor_id uuid,p_member_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE profile jsonb; subs jsonb; bills jsonb; receipts jsonb;
BEGIN
  PERFORM public.workout_zone_require_plan_actor(p_actor_id);
  SELECT p.profile INTO profile FROM public.workout_zone_member_projection p WHERE id=p_member_id AND deleted_at IS NULL;
  IF NOT FOUND THEN RAISE EXCEPTION 'Member not found' USING ERRCODE='P0002'; END IF;
  SELECT COALESCE(jsonb_agg(payload ORDER BY starts_on DESC,kind,id),'[]'::jsonb) INTO subs
    FROM public.workout_zone_member_subscriptions WHERE member_id=p_member_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',i.id,'invoiceNumber',i.invoice_number,'invoiceDate',i.invoice_date,
    'dueDate',i.due_date,'status',i.status,'totalAmount',b.billed,'allocatedAmount',b.allocated,
    'outstandingAmount',CASE WHEN i.status='issued' THEN b.billed-b.allocated ELSE 0 END,
    'paymentStatus',CASE WHEN i.status<>'issued' THEN 'NOT_ISSUED' WHEN b.billed>0 AND b.allocated>=b.billed THEN 'PAID'
      WHEN b.allocated>0 THEN 'PARTIAL' ELSE 'UNPAID' END) ORDER BY i.invoice_date DESC,i.id),'[]'::jsonb)
    INTO bills FROM public.invoices i JOIN public.invoice_balances b ON b.invoice_id=i.id WHERE i.member_id=p_member_id;
  SELECT COALESCE(jsonb_agg(jsonb_build_object('id',p.id,'invoiceId',p.invoice_id,'amount',p.amount,'method',p.method,
    'status',p.status,'receivedAt',p.received_at,'reference',COALESCE(p.provider_payment_id,''))
    ORDER BY p.created_at DESC,p.id),'[]'::jsonb) INTO receipts FROM public.payments p JOIN public.invoices i ON i.id=p.invoice_id WHERE i.member_id=p_member_id;
  RETURN jsonb_build_object('member',profile,'subscriptions',subs,'invoices',bills,'payments',receipts);
END;
$$;

CREATE FUNCTION public.workout_zone_create_member(p_actor_id uuid,p_request_key uuid,p_fields jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE request public.member_onboarding_requests%ROWTYPE; member_id uuid; result jsonb;
  gym public.gym_plans%ROWTYPE; pt public.trainer_plans%ROWTYPE; coach uuid; pt_id uuid;
  v_name text; v_email text; v_phone text; v_notes text; joined date; gym_start date; pt_start date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('workout-zone-members',0));
  PERFORM public.workout_zone_require_plan_actor(p_actor_id);
  IF p_request_key IS NULL OR jsonb_typeof(p_fields) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid request' USING ERRCODE='22023'; END IF;
  SELECT * INTO request FROM public.member_onboarding_requests WHERE request_key=p_request_key;
  IF FOUND THEN
    IF request.actor_user_id<>p_actor_id OR request.fields<>p_fields THEN RAISE EXCEPTION 'Request key reused with different fields' USING ERRCODE='23505'; END IF;
    RETURN request.result;
  END IF;
  IF p_fields-ARRAY['fullName','email','phone','notes','joiningDate','planId','startDate','trainerId','ptPlanId','ptStartDate']<>'{}'::jsonb
    OR NOT(p_fields ?& ARRAY['fullName','joiningDate','planId','startDate']) THEN RAISE EXCEPTION 'Invalid fields' USING ERRCODE='22023'; END IF;
  IF jsonb_typeof(p_fields->'fullName') IS DISTINCT FROM 'string'
    OR (p_fields?'email' AND jsonb_typeof(p_fields->'email') IS DISTINCT FROM 'string')
    OR (p_fields?'phone' AND jsonb_typeof(p_fields->'phone') IS DISTINCT FROM 'string')
    OR (p_fields?'notes' AND jsonb_typeof(p_fields->'notes') IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'Invalid contact types' USING ERRCODE='22023'; END IF;
  BEGIN
    v_name:=btrim(p_fields->>'fullName'); v_email:=lower(btrim(COALESCE(p_fields->>'email','')));
    v_phone:=btrim(COALESCE(p_fields->>'phone','')); v_notes:=btrim(COALESCE(p_fields->>'notes',''));
    joined:=(p_fields->>'joiningDate')::date; gym_start:=(p_fields->>'startDate')::date;
    coach:=NULLIF(p_fields->>'trainerId','')::uuid; pt_id:=NULLIF(p_fields->>'ptPlanId','')::uuid;
    pt_start:=NULLIF(p_fields->>'ptStartDate','')::date;
    SELECT * INTO gym FROM public.gym_plans WHERE id=(p_fields->>'planId')::uuid AND active AND deleted_at IS NULL
      AND duration_days BETWEEN 1 AND 36500 AND list_price BETWEEN 0 AND 9999999999.99 FOR SHARE;
  EXCEPTION WHEN invalid_text_representation OR invalid_datetime_format OR datetime_field_overflow THEN
    RAISE EXCEPTION 'Invalid dates or identifiers' USING ERRCODE='22023';
  END;
  IF gym.id IS NULL THEN RAISE EXCEPTION 'Active gym plan required' USING ERRCODE='23514'; END IF;
  IF char_length(v_name)<2 OR char_length(v_name)>160 OR char_length(v_email)>254
    OR (v_email<>'' AND v_email!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')
    OR char_length(v_phone)>32 OR (v_phone<>'' AND v_phone!~'^\+?[1-9][0-9]{7,14}$') OR char_length(v_notes)>2000
    OR joined IS NULL OR gym_start IS NULL OR gym_start<joined OR gym_start>'9999-12-31'::date-(gym.duration_days-1)
    OR (coach IS NULL)<>(pt_id IS NULL) OR (coach IS NOT NULL AND (pt_start IS NULL OR pt_start<joined)) THEN
    RAISE EXCEPTION 'Invalid profile or subscription dates' USING ERRCODE='22023';
  END IF;
  IF coach IS NOT NULL THEN
    SELECT * INTO pt FROM public.trainer_plans WHERE id=pt_id AND active AND deleted_at IS NULL
      AND duration_days BETWEEN 1 AND 36500 AND list_price BETWEEN 0 AND 9999999999.99 FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active PT plan required' USING ERRCODE='23514'; END IF;
    IF pt_start>'9999-12-31'::date-(pt.duration_days-1) THEN RAISE EXCEPTION 'PT end date out of supported range' USING ERRCODE='22023'; END IF;
    PERFORM 1 FROM public.trainers WHERE id=coach AND status='active' FOR SHARE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active trainer required' USING ERRCODE='23514'; END IF;
  END IF;
  member_id:=gen_random_uuid();
  INSERT INTO public.members(id,member_number,full_name,email,phone,joined_on,notes)
    VALUES(member_id,'WZ-'||upper(replace(member_id::text,'-','')),v_name,NULLIF(v_email,''),NULLIF(v_phone,''),joined,v_notes);
  INSERT INTO public.member_plans(member_id,gym_plan_id,starts_on,ends_on,price_snapshot)
    VALUES(member_id,gym.id,gym_start,gym_start+gym.duration_days-1,gym.list_price);
  IF coach IS NOT NULL THEN
    INSERT INTO public.member_trainer_plan(member_id,trainer_id,trainer_plan_id,starts_on,ends_on,price_snapshot)
      VALUES(member_id,coach,pt.id,pt_start,pt_start+pt.duration_days-1,pt.list_price);
  END IF;
  SELECT p.profile INTO result FROM public.workout_zone_member_projection p WHERE p.id=member_id;
  INSERT INTO public.member_events(actor_user_id,member_id,action,new_state) VALUES(p_actor_id,member_id,'create',result);
  INSERT INTO public.member_onboarding_requests(request_key,actor_user_id,member_id,fields,result)
    VALUES(p_request_key,p_actor_id,member_id,p_fields,result);
  RETURN result;
END;
$$;

CREATE FUNCTION public.workout_zone_mutate_member(p_actor_id uuid,p_member_id uuid,p_action text,p_fields jsonb DEFAULT '{}'::jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE previous public.members%ROWTYPE; before_state jsonb; result jsonb; mode text;
  v_name text; v_email text; v_phone text; v_notes text; joined date; first_start date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('workout-zone-members',0));
  PERFORM public.workout_zone_require_plan_actor(p_actor_id);
  IF p_action IS NULL OR p_action NOT IN ('update','delete') OR jsonb_typeof(p_fields) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'Invalid action' USING ERRCODE='22023'; END IF;
  SELECT * INTO previous FROM public.members WHERE id=p_member_id AND deleted_at IS NULL FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Member not found' USING ERRCODE='P0002'; END IF;
  SELECT p.profile INTO before_state FROM public.workout_zone_member_projection p WHERE id=p_member_id;
  IF p_action='delete' THEN
    IF p_fields<>'{}'::jsonb THEN RAISE EXCEPTION 'Delete takes no fields' USING ERRCODE='22023'; END IF;
    IF EXISTS(SELECT 1 FROM public.member_plans WHERE member_id=p_member_id)
      OR EXISTS(SELECT 1 FROM public.member_trainer_plan WHERE member_id=p_member_id)
      OR EXISTS(SELECT 1 FROM public.invoices WHERE member_id=p_member_id) THEN
      UPDATE public.members SET status='inactive',deleted_at=clock_timestamp() WHERE id=p_member_id;
      mode:='REMOVED_FROM_DIRECTORY';
    ELSE mode:='DELETED'; END IF;
    result:=jsonb_build_object('id',p_member_id,'mode',mode);
    INSERT INTO public.member_events(actor_user_id,member_id,action,old_state,new_state) VALUES(p_actor_id,p_member_id,'delete',before_state,result);
    IF mode='DELETED' THEN DELETE FROM public.members WHERE id=p_member_id; END IF;
    RETURN result;
  END IF;
  IF p_fields='{}'::jsonb OR p_fields-ARRAY['fullName','email','phone','notes','joiningDate']<>'{}'::jsonb THEN RAISE EXCEPTION 'Invalid profile fields' USING ERRCODE='22023'; END IF;
  IF (p_fields?'fullName' AND jsonb_typeof(p_fields->'fullName') IS DISTINCT FROM 'string')
    OR (p_fields?'email' AND jsonb_typeof(p_fields->'email') IS DISTINCT FROM 'string')
    OR (p_fields?'phone' AND jsonb_typeof(p_fields->'phone') IS DISTINCT FROM 'string')
    OR (p_fields?'notes' AND jsonb_typeof(p_fields->'notes') IS DISTINCT FROM 'string') THEN RAISE EXCEPTION 'Invalid contact types' USING ERRCODE='22023'; END IF;
  v_name:=CASE WHEN p_fields?'fullName' THEN btrim(p_fields->>'fullName') ELSE previous.full_name END;
  v_email:=CASE WHEN p_fields?'email' THEN lower(btrim(p_fields->>'email')) ELSE COALESCE(previous.email,'') END;
  v_phone:=CASE WHEN p_fields?'phone' THEN btrim(p_fields->>'phone') ELSE COALESCE(previous.phone,'') END;
  v_notes:=CASE WHEN p_fields?'notes' THEN btrim(p_fields->>'notes') ELSE previous.notes END;
  BEGIN joined:=CASE WHEN p_fields?'joiningDate' THEN (p_fields->>'joiningDate')::date ELSE previous.joined_on END;
  EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RAISE EXCEPTION 'Invalid joining date' USING ERRCODE='22023'; END;
  SELECT min(starts_on) INTO first_start FROM public.workout_zone_member_subscriptions WHERE member_id=p_member_id;
  IF (p_fields?'fullName' AND (char_length(v_name)<2 OR char_length(v_name)>160))
    OR (p_fields?'email' AND (char_length(v_email)>254 OR (v_email<>'' AND v_email!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')))
    OR (p_fields?'phone' AND (char_length(v_phone)>32 OR (v_phone<>'' AND v_phone!~'^\+?[1-9][0-9]{7,14}$')))
    OR char_length(v_notes)>2000 OR joined IS NULL OR (p_fields?'joiningDate' AND joined<>previous.joined_on AND first_start IS NOT NULL AND joined>first_start) THEN
    RAISE EXCEPTION 'Invalid profile fields or joining date' USING ERRCODE='22023';
  END IF;
  UPDATE public.members SET full_name=v_name,email=NULLIF(v_email,''),phone=NULLIF(v_phone,''),notes=v_notes,joined_on=joined WHERE id=p_member_id;
  SELECT p.profile INTO result FROM public.workout_zone_member_projection p WHERE id=p_member_id;
  INSERT INTO public.member_events(actor_user_id,member_id,action,old_state,new_state) VALUES(p_actor_id,p_member_id,'update',before_state,result);
  RETURN result;
END;
$$;

CREATE FUNCTION public.workout_zone_validate_member_purchase()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.members WHERE id=NEW.member_id AND status='active' AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Active member required for new subscriptions' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER validate_member_purchase BEFORE INSERT OR UPDATE OF member_id ON public.member_plans FOR EACH ROW EXECUTE FUNCTION public.workout_zone_validate_member_purchase();
CREATE TRIGGER validate_member_purchase BEFORE INSERT OR UPDATE OF member_id ON public.member_trainer_plan FOR EACH ROW EXECUTE FUNCTION public.workout_zone_validate_member_purchase();

DO $$
DECLARE fn record; r text;
BEGIN
  FOR fn IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('workout_zone_list_members','workout_zone_member_options','workout_zone_get_member',
      'workout_zone_create_member','workout_zone_mutate_member','workout_zone_validate_member_purchase') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
    FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',fn.signature,r); END IF;
    END LOOP;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON public.member_events,public.member_onboarding_requests,public.workout_zone_member_subscriptions,public.workout_zone_member_current_subscriptions,public.workout_zone_member_projection FROM %I',r);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    REVOKE ALL ON public.members,public.member_plans,public.member_trainer_plan FROM service_role;
    GRANT SELECT ON public.members,public.member_plans,public.member_trainer_plan TO service_role;
    GRANT EXECUTE ON FUNCTION public.workout_zone_list_members(uuid),public.workout_zone_member_options(uuid),public.workout_zone_get_member(uuid,uuid),
      public.workout_zone_create_member(uuid,uuid,jsonb),public.workout_zone_mutate_member(uuid,uuid,text,jsonb) TO service_role;
  END IF;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
