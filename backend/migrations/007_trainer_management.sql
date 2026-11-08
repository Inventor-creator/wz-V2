-- Additive after 001–006. Profiles, Google identities and grants stay separate.
BEGIN;
CREATE TABLE public.trainer_management_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  trainer_id uuid NOT NULL REFERENCES public.trainers(id) ON DELETE RESTRICT,
  action text NOT NULL CHECK(action IN ('create','update','schedule_commission')),
  old_state jsonb, new_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.trainer_management_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trainer_management_events FROM PUBLIC;

CREATE VIEW public.workout_zone_trainer_directory AS
SELECT t.id,jsonb_build_object(
  'id',t.id,'name',t.full_name,'email',COALESCE(t.email,''),'phone',COALESCE(t.phone,''),'isActive',t.status='active',
  'assignedMembersCount',(SELECT count(DISTINCT s.member_id) FROM public.member_trainer_plan s WHERE s.trainer_id=t.id),
  'activeMembersCount',(SELECT count(DISTINCT s.member_id) FROM public.member_trainer_plan s JOIN public.members m ON m.id=s.member_id
    WHERE s.trainer_id=t.id AND m.status='active' AND s.status<>'cancelled'
      AND s.starts_on<=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
      AND s.ends_on>=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date),
  'hasLoginAccess',EXISTS(SELECT 1 FROM public.role_assignments r JOIN public.users u ON u.id=r.user_id
    WHERE r.trainer_id=t.id AND r.role='trainer' AND r.revoked_at IS NULL AND u.active)
) AS payload FROM public.trainers t;
REVOKE ALL ON public.workout_zone_trainer_directory FROM PUBLIC;

CREATE FUNCTION public.workout_zone_list_trainers(p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.workout_zone_require_plan_actor(p_actor_id);
  SELECT COALESCE(jsonb_agg(payload ORDER BY lower(payload->>'name'),id),'[]'::jsonb)
    INTO result FROM public.workout_zone_trainer_directory;
  RETURN result;
END;
$$;

CREATE FUNCTION public.workout_zone_get_trainer(p_actor_id uuid,p_trainer_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE profile jsonb; assignments jsonb; rules jsonb; can_read_rules boolean;
BEGIN
  PERFORM public.workout_zone_require_plan_actor(p_actor_id);
  SELECT payload INTO profile FROM public.workout_zone_trainer_directory WHERE id=p_trainer_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trainer not found' USING ERRCODE='P0002'; END IF;
  SELECT COALESCE(jsonb_agg(jsonb_build_object(
    'id',s.id,'memberId',m.id,'memberName',m.full_name,'memberEmail',COALESCE(m.email,''),'memberPhone',COALESCE(m.phone,''),
    'planId',p.id,'planName',p.name,'startDate',s.starts_on,'endDate',s.ends_on,'priceAtPurchase',s.price_snapshot,
    'status',CASE WHEN s.status='cancelled' THEN 'Cancelled'
      WHEN s.starts_on>(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date THEN 'Upcoming'
      WHEN s.ends_on<(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date THEN 'Expired' ELSE 'Active' END
  ) ORDER BY s.starts_on DESC,s.id),'[]'::jsonb) INTO assignments
  FROM public.member_trainer_plan s JOIN public.members m ON m.id=s.member_id
  JOIN public.trainer_plans p ON p.id=s.trainer_plan_id WHERE s.trainer_id=p_trainer_id;
  SELECT u.email='aryapat1234@gmail.com' OR EXISTS(SELECT 1 FROM public.role_assignments r
    WHERE r.user_id=u.id AND r.role='owner' AND r.revoked_at IS NULL)
    INTO can_read_rules FROM public.users u WHERE u.id=p_actor_id;
  IF can_read_rules THEN
    SELECT COALESCE(jsonb_agg(jsonb_build_object('id',id,'kind',kind,'value',value,
      'effectiveFrom',effective_from,'effectiveUntil',effective_until) ORDER BY effective_from DESC,id),'[]'::jsonb)
      INTO rules FROM public.trainer_payout_rules WHERE trainer_id=p_trainer_id;
  END IF;
  RETURN jsonb_build_object('trainer',profile,'assignments',assignments,'payoutRules',rules);
END;
$$;

CREATE FUNCTION public.workout_zone_mutate_trainer(
  p_actor_id uuid,p_action text,p_trainer_id uuid DEFAULT NULL,p_fields jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE previous public.trainers%ROWTYPE; target_id uuid; before_state jsonb; after_state jsonb;
  new_name text; new_email text; new_phone text; new_active boolean;
BEGIN
  -- Same lock order as access grants/onboarding (002–004), then the trainer row.
  PERFORM pg_advisory_xact_lock(hashtextextended('workout-zone-access-management',0));
  PERFORM public.workout_zone_require_plan_actor(p_actor_id);
  IF p_action IS NULL OR p_action NOT IN ('create','update') OR jsonb_typeof(p_fields) IS DISTINCT FROM 'object'
    OR p_fields-ARRAY['name','email','phone','isActive']<>'{}'::jsonb THEN
    RAISE EXCEPTION 'Invalid profile fields or action' USING ERRCODE='22023';
  END IF;
  IF (p_action='create' AND NOT(p_fields?'name')) OR (p_action='update' AND p_fields='{}'::jsonb) THEN
    RAISE EXCEPTION 'Profile fields required' USING ERRCODE='22023';
  END IF;
  IF (p_fields?'name' AND jsonb_typeof(p_fields->'name') IS DISTINCT FROM 'string')
    OR (p_fields?'email' AND jsonb_typeof(p_fields->'email') IS DISTINCT FROM 'string')
    OR (p_fields?'phone' AND jsonb_typeof(p_fields->'phone') IS DISTINCT FROM 'string')
    OR (p_fields?'isActive' AND jsonb_typeof(p_fields->'isActive') IS DISTINCT FROM 'boolean') THEN
    RAISE EXCEPTION 'Invalid profile field types' USING ERRCODE='22023';
  END IF;
  IF p_action='update' THEN
    SELECT * INTO previous FROM public.trainers WHERE id=p_trainer_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Trainer not found' USING ERRCODE='P0002'; END IF;
    SELECT payload INTO before_state FROM public.workout_zone_trainer_directory WHERE id=p_trainer_id;
  END IF;
  new_name:=CASE WHEN p_fields?'name' THEN btrim(p_fields->>'name') ELSE previous.full_name END;
  new_email:=CASE WHEN p_fields?'email' THEN lower(btrim(p_fields->>'email')) ELSE COALESCE(previous.email,'') END;
  new_phone:=CASE WHEN p_fields?'phone' THEN btrim(p_fields->>'phone') ELSE COALESCE(previous.phone,'') END;
  new_active:=CASE WHEN p_fields?'isActive' THEN (p_fields->>'isActive')::boolean ELSE COALESCE(previous.status='active',true) END;
  IF (p_fields?'name' AND (new_name IS NULL OR char_length(new_name)<2 OR char_length(new_name)>160))
    OR (p_fields?'email' AND (char_length(new_email)>254 OR (new_email<>'' AND new_email!~'^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$')))
    OR (p_fields?'phone' AND (char_length(new_phone)>32 OR (new_phone<>'' AND new_phone!~'^\+?[1-9][0-9]{7,14}$'))) THEN
    RAISE EXCEPTION 'Invalid profile values' USING ERRCODE='22023';
  END IF;
  IF p_action='create' THEN
    INSERT INTO public.trainers(full_name,email,phone,status)
      VALUES(new_name,NULLIF(new_email,''),NULLIF(new_phone,''),CASE WHEN new_active THEN 'active' ELSE 'inactive' END)
      RETURNING id INTO target_id;
  ELSE
    UPDATE public.trainers SET full_name=new_name,email=NULLIF(new_email,''),phone=NULLIF(new_phone,''),
      status=CASE WHEN new_active THEN 'active' ELSE 'inactive' END WHERE id=previous.id RETURNING id INTO target_id;
  END IF;
  SELECT payload INTO after_state FROM public.workout_zone_trainer_directory WHERE id=target_id;
  INSERT INTO public.trainer_management_events(actor_user_id,trainer_id,action,old_state,new_state)
    VALUES(p_actor_id,target_id,p_action,before_state,after_state);
  RETURN after_state;
END;
$$;

CREATE FUNCTION public.workout_zone_schedule_trainer_commission(
  p_actor_id uuid,p_trainer_id uuid,p_rate numeric,p_start date,p_end date DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE before_state jsonb; after_state jsonb; result jsonb; rule_id uuid; overlapping integer;
  today date:=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('workout-zone-access-management',0));
  PERFORM public.workout_zone_require_access_actor(p_actor_id);
  PERFORM 1 FROM public.trainers WHERE id=p_trainer_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Trainer not found' USING ERRCODE='P0002'; END IF;
  IF p_rate IS NULL OR p_rate<0 OR p_rate>100 OR p_rate<>round(p_rate,2)
    OR p_start IS NULL OR p_start<=today OR (p_end IS NOT NULL AND p_end<p_start) THEN
    RAISE EXCEPTION 'Future period and percent rate required' USING ERRCODE='22023';
  END IF;
  -- Reject ambiguous legacy overlaps and future schedules; never silently replace them.
  SELECT count(*) INTO overlapping FROM public.trainer_payout_rules
    WHERE trainer_id=p_trainer_id AND effective_from<=COALESCE(p_end,'infinity'::date)
      AND COALESCE(effective_until,'infinity'::date)>=p_start;
  IF overlapping>1 OR EXISTS(SELECT 1 FROM public.trainer_payout_rules WHERE trainer_id=p_trainer_id
    AND effective_from<=COALESCE(p_end,'infinity'::date) AND COALESCE(effective_until,'infinity'::date)>=p_start
    AND effective_from>today) THEN
    RAISE EXCEPTION 'Overlapping or scheduled rules require review' USING ERRCODE='23P01';
  END IF;
  SELECT COALESCE(jsonb_agg(to_jsonb(r) ORDER BY effective_from,id),'[]'::jsonb) INTO before_state
    FROM public.trainer_payout_rules r WHERE trainer_id=p_trainer_id;
  UPDATE public.trainer_payout_rules SET effective_until=p_start-1
    WHERE trainer_id=p_trainer_id AND effective_from<p_start AND COALESCE(effective_until,'infinity'::date)>=p_start;
  INSERT INTO public.trainer_payout_rules(trainer_id,kind,value,effective_from,effective_until)
    VALUES(p_trainer_id,'percent',p_rate,p_start,p_end) RETURNING id INTO rule_id;
  SELECT jsonb_build_object('id',id,'kind',kind,'value',value,'effectiveFrom',effective_from,'effectiveUntil',effective_until)
    INTO result FROM public.trainer_payout_rules WHERE id=rule_id;
  SELECT jsonb_agg(to_jsonb(r) ORDER BY effective_from,id) INTO after_state
    FROM public.trainer_payout_rules r WHERE trainer_id=p_trainer_id;
  INSERT INTO public.trainer_management_events(actor_user_id,trainer_id,action,old_state,new_state)
    VALUES(p_actor_id,p_trainer_id,'schedule_commission',before_state,after_state);
  RETURN result;
END;
$$;

DO $$
DECLARE fn record; r text;
BEGIN
  FOR fn IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('workout_zone_list_trainers','workout_zone_get_trainer',
      'workout_zone_mutate_trainer','workout_zone_schedule_trainer_commission') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
    FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',fn.signature,r); END IF;
    END LOOP;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON public.trainer_management_events,public.workout_zone_trainer_directory FROM %I',r);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    REVOKE ALL ON public.trainers,public.trainer_payout_rules,public.trainer_management_events,public.workout_zone_trainer_directory FROM service_role;
    GRANT SELECT ON public.trainers,public.trainer_payout_rules TO service_role;
    GRANT EXECUTE ON FUNCTION public.workout_zone_list_trainers(uuid),public.workout_zone_get_trainer(uuid,uuid),
      public.workout_zone_mutate_trainer(uuid,text,uuid,jsonb),public.workout_zone_schedule_trainer_commission(uuid,uuid,numeric,date,date) TO service_role;
  END IF;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
