-- Additive after 001–005. PT plans are shared; trainers are chosen on purchases.
BEGIN;
ALTER TABLE public.trainer_plans ADD COLUMN description text NOT NULL DEFAULT '';
ALTER TABLE public.trainer_plans ADD COLUMN deleted_at timestamptz;
ALTER TABLE public.trainer_plans ADD CONSTRAINT trainer_plans_deleted_inactive_check CHECK(deleted_at IS NULL OR NOT active);
CREATE INDEX member_trainer_plan_plan_idx ON public.member_trainer_plan(trainer_plan_id);

CREATE TABLE public.trainer_plan_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  plan_id uuid REFERENCES public.trainer_plans(id) ON DELETE SET NULL,
  action text NOT NULL CHECK(action IN ('create','update','delete')),
  old_state jsonb, new_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.trainer_plan_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.trainer_plan_events FROM PUBLIC;

CREATE VIEW public.workout_zone_trainer_plan_projection AS
SELECT p.id,p.deleted_at,jsonb_build_object(
  'id',p.id,'name',p.name,'price',p.list_price,'duration',p.duration_days,'durationUnit','DAY',
  'description',p.description,'isActive',p.active,
  'activeMembersCount',(SELECT count(DISTINCT s.member_id) FROM public.member_trainer_plan s
    JOIN public.members m ON m.id=s.member_id WHERE s.trainer_plan_id=p.id AND m.status='active'
      AND s.status<>'cancelled' AND s.starts_on<=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date
      AND s.ends_on>=(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Kolkata')::date),
  'hasHistory',EXISTS(SELECT 1 FROM public.member_trainer_plan s WHERE s.trainer_plan_id=p.id)
) AS payload FROM public.trainer_plans p;
REVOKE ALL ON public.workout_zone_trainer_plan_projection FROM PUBLIC;

CREATE FUNCTION public.workout_zone_list_trainer_plans(p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.workout_zone_require_plan_actor(p_actor_id);
  SELECT COALESCE(jsonb_agg(payload ORDER BY lower(payload->>'name'),id),'[]'::jsonb)
  INTO result FROM public.workout_zone_trainer_plan_projection WHERE deleted_at IS NULL;
  RETURN result;
END;
$$;

CREATE FUNCTION public.workout_zone_get_trainer_plan(p_actor_id uuid,p_plan_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.workout_zone_require_plan_actor(p_actor_id);
  SELECT payload INTO result FROM public.workout_zone_trainer_plan_projection WHERE id=p_plan_id AND deleted_at IS NULL;
  IF result IS NULL THEN RAISE EXCEPTION 'Plan not found' USING ERRCODE='P0002'; END IF;
  RETURN result;
END;
$$;

CREATE FUNCTION public.workout_zone_mutate_trainer_plan(
  p_actor_id uuid,p_action text,p_plan_id uuid DEFAULT NULL,p_fields jsonb DEFAULT '{}'::jsonb
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE old_plan public.trainer_plans%ROWTYPE; new_id uuid; before_state jsonb; after_state jsonb;
  new_name text; new_description text; new_price numeric; new_days numeric; new_active boolean; deletion_mode text;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('workout-zone-trainer-plans',0));
  PERFORM public.workout_zone_require_plan_actor(p_actor_id);
  IF p_action IS NULL OR p_action NOT IN ('create','update','delete') OR jsonb_typeof(p_fields) IS DISTINCT FROM 'object' THEN
    RAISE EXCEPTION 'Invalid action or fields' USING ERRCODE='22023';
  END IF;
  IF p_fields-ARRAY['name','price','duration','durationUnit','description','isActive']<>'{}'::jsonb THEN
    RAISE EXCEPTION 'Unsupported fields' USING ERRCODE='22023';
  END IF;
  IF p_action<>'create' THEN
    SELECT * INTO old_plan FROM public.trainer_plans WHERE id=p_plan_id AND deleted_at IS NULL FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Plan not found' USING ERRCODE='P0002'; END IF;
    SELECT payload INTO before_state FROM public.workout_zone_trainer_plan_projection WHERE id=p_plan_id;
  END IF;
  IF p_action='delete' THEN
    IF p_fields<>'{}'::jsonb THEN RAISE EXCEPTION 'Delete takes no fields' USING ERRCODE='22023'; END IF;
    IF EXISTS(SELECT 1 FROM public.member_trainer_plan WHERE trainer_plan_id=old_plan.id) THEN
      UPDATE public.trainer_plans SET active=false,deleted_at=clock_timestamp() WHERE id=old_plan.id;
      deletion_mode:='REMOVED_FROM_CATALOG';
    ELSE deletion_mode:='DELETED'; END IF;
    after_state:=jsonb_build_object('id',old_plan.id,'mode',deletion_mode);
    INSERT INTO public.trainer_plan_events(actor_user_id,plan_id,action,old_state,new_state)
      VALUES(p_actor_id,old_plan.id,'delete',before_state,after_state);
    IF deletion_mode='DELETED' THEN DELETE FROM public.trainer_plans WHERE id=old_plan.id; END IF;
    RETURN after_state;
  END IF;
  IF p_action='create' AND NOT(p_fields ?& ARRAY['name','price','duration']) THEN
    RAISE EXCEPTION 'Required plan fields missing' USING ERRCODE='22023';
  END IF;
  IF p_action='update' AND p_fields='{}'::jsonb THEN RAISE EXCEPTION 'No changes provided' USING ERRCODE='22023'; END IF;
  IF p_fields?'durationUnit' AND p_fields->>'durationUnit' IS DISTINCT FROM 'DAY' THEN
    RAISE EXCEPTION 'Use fixed calendar days' USING ERRCODE='22023';
  END IF;
  IF (p_fields?'name' AND jsonb_typeof(p_fields->'name') IS DISTINCT FROM 'string')
    OR (p_fields?'description' AND jsonb_typeof(p_fields->'description') IS DISTINCT FROM 'string')
    OR (p_fields?'isActive' AND jsonb_typeof(p_fields->'isActive') IS DISTINCT FROM 'boolean') THEN
    RAISE EXCEPTION 'Invalid plan field types' USING ERRCODE='22023';
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
    INSERT INTO public.trainer_plans(name,duration_days,list_price,active,description)
      VALUES(new_name,new_days::integer,new_price,new_active,new_description) RETURNING id INTO new_id;
  ELSE
    UPDATE public.trainer_plans SET name=new_name,duration_days=new_days::integer,list_price=new_price,
      active=new_active,description=new_description WHERE id=old_plan.id RETURNING id INTO new_id;
  END IF;
  SELECT payload INTO after_state FROM public.workout_zone_trainer_plan_projection WHERE id=new_id;
  INSERT INTO public.trainer_plan_events(actor_user_id,plan_id,action,old_state,new_state)
    VALUES(p_actor_id,new_id,p_action,before_state,after_state);
  RETURN after_state;
END;
$$;

CREATE FUNCTION public.workout_zone_validate_new_pt_subscription()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
  -- Lifecycle-only updates must keep working for historical assignments.
  PERFORM 1 FROM public.trainer_plans WHERE id=NEW.trainer_plan_id AND active AND deleted_at IS NULL FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active PT catalog plan' USING ERRCODE='23514'; END IF;
  PERFORM 1 FROM public.trainers WHERE id=NEW.trainer_id AND status='active' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Choose an active trainer' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END;
$$;
CREATE TRIGGER validate_new_pt_subscription_plan BEFORE INSERT OR UPDATE OF trainer_plan_id,trainer_id ON public.member_trainer_plan
  FOR EACH ROW EXECUTE FUNCTION public.workout_zone_validate_new_pt_subscription();

DO $$
DECLARE fn record; r text;
BEGIN
  FOR fn IN SELECT p.oid::regprocedure AS signature FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
    WHERE n.nspname='public' AND p.proname IN ('workout_zone_list_trainer_plans','workout_zone_get_trainer_plan',
      'workout_zone_mutate_trainer_plan','workout_zone_validate_new_pt_subscription') LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC',fn.signature);
    FOREACH r IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN EXECUTE format('REVOKE ALL ON FUNCTION %s FROM %I',fn.signature,r); END IF;
    END LOOP;
  END LOOP;
  FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
    IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname=r) THEN
      EXECUTE format('REVOKE ALL ON public.trainer_plans,public.member_trainer_plan,public.trainer_plan_events,public.workout_zone_trainer_plan_projection FROM %I',r);
    END IF;
  END LOOP;
  IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    REVOKE ALL ON public.trainer_plans,public.trainer_plan_events,public.workout_zone_trainer_plan_projection FROM service_role;
    GRANT SELECT ON public.trainer_plans TO service_role;
    GRANT EXECUTE ON FUNCTION public.workout_zone_list_trainer_plans(uuid),public.workout_zone_get_trainer_plan(uuid,uuid),
      public.workout_zone_mutate_trainer_plan(uuid,text,uuid,jsonb) TO service_role;
  END IF;
END;
$$;
NOTIFY pgrst,'reload schema';
COMMIT;
