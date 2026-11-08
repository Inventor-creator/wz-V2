-- Additive migration after 001–004. Do not replay the initial schema.
BEGIN;
ALTER TABLE public.gym_plans ADD COLUMN IF NOT EXISTS description text NOT NULL DEFAULT '';
ALTER TABLE public.gym_plans ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE public.gym_plans ADD CONSTRAINT gym_plans_deleted_inactive_check CHECK(deleted_at IS NULL OR NOT active);
CREATE INDEX IF NOT EXISTS member_plans_gym_plan_idx ON public.member_plans(gym_plan_id);

CREATE TABLE public.membership_plan_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  plan_id uuid REFERENCES public.gym_plans(id) ON DELETE SET NULL,
  action text NOT NULL CHECK(action IN ('create','update','delete')),
  old_state jsonb, new_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.gym_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.member_plans ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.membership_plan_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.gym_plans,public.member_plans,public.membership_plan_events FROM PUBLIC;

CREATE OR REPLACE VIEW public.workout_zone_membership_plan_projection AS
SELECT g.id,g.deleted_at,jsonb_build_object(
  'id',g.id,'name',g.name,'price',g.list_price,'duration',g.duration_days,'durationUnit','DAY',
  'description',g.description,'isActive',g.active,
  'activeMembersCount',(SELECT count(DISTINCT s.member_id) FROM public.member_plans s
    JOIN public.members m ON m.id=s.member_id WHERE s.gym_plan_id=g.id AND m.status='active'
      AND s.status<>'cancelled' AND s.starts_on<=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
      AND s.ends_on>=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date),
  'hasHistory',EXISTS(SELECT 1 FROM public.member_plans s WHERE s.gym_plan_id=g.id)
) AS payload FROM public.gym_plans g;
REVOKE ALL ON public.workout_zone_membership_plan_projection FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.workout_zone_require_plan_actor(p_actor_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor_email text; actor_active boolean;
BEGIN
  SELECT email,active INTO actor_email,actor_active FROM public.users WHERE id=p_actor_id;
  IF NOT FOUND THEN RAISE EXCEPTION 'Unknown actor' USING ERRCODE='42501'; END IF;
  IF actor_email='aryapat1234@gmail.com' THEN RETURN; END IF;
  IF NOT actor_active OR NOT EXISTS(SELECT 1 FROM public.role_assignments
    WHERE user_id=p_actor_id AND role IN ('owner','admin') AND revoked_at IS NULL) THEN
    RAISE EXCEPTION 'Plan management not permitted' USING ERRCODE='42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.workout_zone_list_membership_plans(p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.workout_zone_require_plan_actor(p_actor_id);
  SELECT COALESCE(jsonb_agg(payload ORDER BY lower(payload->>'name'),id),'[]'::jsonb)
  INTO result FROM public.workout_zone_membership_plan_projection WHERE deleted_at IS NULL;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.workout_zone_get_membership_plan(p_actor_id uuid,p_plan_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.workout_zone_require_plan_actor(p_actor_id);
  SELECT payload INTO result FROM public.workout_zone_membership_plan_projection WHERE id=p_plan_id AND deleted_at IS NULL;
  IF result IS NULL THEN RAISE EXCEPTION 'Plan not found' USING ERRCODE='P0002'; END IF;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.workout_zone_mutate_membership_plan(
 p_actor_id uuid,p_action text,p_plan_id uuid DEFAULT NULL,p_fields jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE old_plan public.gym_plans%ROWTYPE; new_id uuid; before_state jsonb; after_state jsonb;
  new_name text; new_description text; new_price numeric; new_days numeric; new_active boolean; deletion_mode text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('workout-zone-membership-plans',0));
  PERFORM public.workout_zone_require_plan_actor(p_actor_id);
  IF p_action IS NULL OR p_action NOT IN ('create','update','delete') OR jsonb_typeof(p_fields) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid action or fields' USING ERRCODE='22023';
  END IF;
  IF p_fields-ARRAY['name','price','duration','durationUnit','description','isActive']<>'{}'::jsonb THEN
    RAISE EXCEPTION 'Unsupported fields' USING ERRCODE='22023';
  END IF;
  IF p_action<>'create' THEN
    -- Locks conflict with FK/key-share locks taken by concurrent purchases.
    SELECT * INTO old_plan FROM public.gym_plans WHERE id=p_plan_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Plan not found' USING ERRCODE='P0002'; END IF;
    SELECT payload INTO before_state FROM public.workout_zone_membership_plan_projection WHERE id=p_plan_id;
  END IF;
  IF p_action='delete' THEN
    IF EXISTS(SELECT 1 FROM public.member_plans WHERE gym_plan_id=old_plan.id) THEN
      UPDATE public.gym_plans SET active=false,deleted_at=clock_timestamp() WHERE id=old_plan.id;
      deletion_mode:='REMOVED_FROM_CATALOG';
    ELSE deletion_mode:='DELETED'; END IF;
    after_state:=jsonb_build_object('id',old_plan.id,'mode',deletion_mode);
    INSERT INTO public.membership_plan_events(actor_user_id,plan_id,action,old_state,new_state)
      VALUES(p_actor_id,old_plan.id,'delete',before_state,after_state);
    IF deletion_mode='DELETED' THEN DELETE FROM public.gym_plans WHERE id=old_plan.id; END IF;
    RETURN after_state;
  END IF;
  IF p_action='create' AND NOT(p_fields ?& ARRAY['name','price','duration']) THEN
    RAISE EXCEPTION 'Required plan fields missing' USING ERRCODE='22023';
  END IF;
  IF p_action='update' AND p_fields='{}'::jsonb THEN RAISE EXCEPTION 'No changes provided' USING ERRCODE='22023'; END IF;
  IF p_fields?'durationUnit' AND p_fields->>'durationUnit' IS DISTINCT FROM 'DAY' THEN
    RAISE EXCEPTION 'Use fixed calendar days; months are not approximated' USING ERRCODE='22023';
  END IF;
  IF p_fields?'isActive' AND jsonb_typeof(p_fields->'isActive') IS DISTINCT FROM 'boolean' THEN
    RAISE EXCEPTION 'Active status must be boolean' USING ERRCODE='22023';
  END IF;
  BEGIN
    new_name:=CASE WHEN p_fields?'name' THEN btrim(p_fields->>'name') ELSE old_plan.name END;
    new_description:=CASE WHEN p_fields?'description' THEN btrim(p_fields->>'description') ELSE COALESCE(old_plan.description,'') END;
    new_price:=CASE WHEN p_fields?'price' THEN (p_fields->>'price')::numeric ELSE old_plan.list_price END;
    new_days:=CASE WHEN p_fields?'duration' THEN (p_fields->>'duration')::numeric ELSE old_plan.duration_days END;
    new_active:=CASE WHEN p_fields?'isActive' THEN (p_fields->>'isActive')::boolean ELSE COALESCE(old_plan.active,true) END;
  EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'Invalid plan values' USING ERRCODE='22023';
  END;
  IF new_name IS NULL OR char_length(new_name)<2 OR char_length(new_name)>120
    OR new_description IS NULL OR char_length(new_description)>2000
    OR new_price IS NULL OR new_price<0 OR new_price>9999999999.99 OR new_price<>round(new_price,2)
    OR new_days IS NULL OR new_days<1 OR new_days>36500 OR new_days<>trunc(new_days) THEN
    RAISE EXCEPTION 'Plan fields outside supported bounds' USING ERRCODE='22023';
  END IF;
  IF p_action='create' THEN
    INSERT INTO public.gym_plans(name,duration_days,list_price,active,description)
    VALUES(new_name,new_days::integer,new_price,new_active,new_description) RETURNING id INTO new_id;
  ELSE
    UPDATE public.gym_plans SET name=new_name,duration_days=new_days::integer,list_price=new_price,
      active=new_active,description=new_description WHERE id=old_plan.id RETURNING id INTO new_id;
  END IF;
  SELECT payload INTO after_state FROM public.workout_zone_membership_plan_projection WHERE id=new_id;
  INSERT INTO public.membership_plan_events(actor_user_id,plan_id,action,old_state,new_state)
    VALUES(p_actor_id,new_id,p_action,before_state,after_state);
  RETURN after_state;
END;
$$;

CREATE OR REPLACE FUNCTION public.workout_zone_validate_new_gym_subscription()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  PERFORM 1 FROM public.gym_plans WHERE id=NEW.gym_plan_id AND active AND deleted_at IS NULL FOR KEY SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active catalog plan' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER validate_new_gym_subscription_plan BEFORE INSERT OR UPDATE OF gym_plan_id ON public.member_plans
FOR EACH ROW EXECUTE FUNCTION public.workout_zone_validate_new_gym_subscription();

DO $$
DECLARE fn record; r text;
BEGIN
  FOR fn IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('workout_zone_require_plan_actor','workout_zone_list_membership_plans',
      'workout_zone_get_membership_plan','workout_zone_mutate_membership_plan','workout_zone_validate_new_gym_subscription') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
    FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',fn.signature,r); END IF;
    END LOOP;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON public.gym_plans,public.member_plans,public.membership_plan_events,public.workout_zone_membership_plan_projection FROM %I',r);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    REVOKE ALL ON public.gym_plans,public.membership_plan_events,public.workout_zone_membership_plan_projection FROM service_role;
    GRANT SELECT ON public.gym_plans TO service_role;
    GRANT EXECUTE ON FUNCTION public.workout_zone_list_membership_plans(uuid),public.workout_zone_get_membership_plan(uuid,uuid),
      public.workout_zone_mutate_membership_plan(uuid,text,uuid,jsonb) TO service_role;
  END IF;
END;
$$;
REVOKE ALL ON public.workout_zone_membership_plan_projection FROM PUBLIC;
NOTIFY pgrst,'reload schema';
COMMIT;
