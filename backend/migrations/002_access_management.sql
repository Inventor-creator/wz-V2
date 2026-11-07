-- Additive migration AFTER gym_schema.sql (and 001 if installed).
-- Do not replay the initial schema against an existing database.
BEGIN;

CREATE TABLE IF NOT EXISTS public.access_audit_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  actor_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  target_user_id uuid NOT NULL REFERENCES public.users(id) ON DELETE RESTRICT,
  assignment_id uuid NOT NULL REFERENCES public.role_assignments(id) ON DELETE RESTRICT,
  event_type text NOT NULL CHECK (event_type IN ('create','change','revoke','reactivate')),
  old_state jsonb, new_state jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS access_audit_target_time_idx ON public.access_audit_events(target_user_id, created_at DESC);
ALTER TABLE public.access_audit_events ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.access_audit_events FROM PUBLIC;
-- Custom Google sessions are NOT Supabase Auth sessions. Browser database roles
-- have no direct identity/grant access; backend service-role queries remain supported.
ALTER TABLE public.users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.role_assignments ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.users, public.role_assignments FROM PUBLIC;

-- This private projection deliberately excludes Google subjects and other secrets.
CREATE OR REPLACE VIEW public.workout_zone_access_projection AS
SELECT ra.id, ra.user_id, false AS is_permanent,
  jsonb_build_object(
    'id',ra.id, 'userId',ra.user_id, 'email',u.email,
    'name',CASE WHEN u.google_subject IS NULL THEN NULL ELSE u.display_name END,
    'role',CASE ra.role WHEN 'owner' THEN 'GYM_OWNER' WHEN 'admin' THEN 'GYM_RECEPTIONIST' WHEN 'trainer' THEN 'GYM_TRAINER' END,
    'status',CASE WHEN ra.revoked_at IS NULL THEN 'ACTIVE' ELSE 'REVOKED' END,
    'grantedBy',COALESCE(g.display_name,g.email,'System'), 'grantedAt',ra.granted_at,
    'trainerId',ra.trainer_id, 'isPermanent',false, 'accountActive',u.active
  ) AS payload
FROM public.role_assignments ra JOIN public.users u ON u.id=ra.user_id
LEFT JOIN public.users g ON g.id=ra.granted_by
WHERE lower(u.email) <> 'aryapat1234@gmail.com'
UNION ALL
SELECT u.id, u.id, true,
  jsonb_build_object(
    'id',u.id, 'userId',u.id, 'email',u.email, 'name',u.display_name,
    'role','SUPER_ADMIN', 'status','ACTIVE', 'grantedBy','Permanent configuration',
    'grantedAt',u.created_at, 'trainerId',NULL, 'isPermanent',true, 'accountActive',u.active
  )
FROM public.users u WHERE lower(u.email)='aryapat1234@gmail.com';
REVOKE ALL ON public.workout_zone_access_projection FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.workout_zone_require_access_actor(p_actor_id uuid)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE actor public.users%ROWTYPE;
BEGIN
  SELECT * INTO actor FROM public.users WHERE id=p_actor_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'Unknown actor' USING ERRCODE='42501';
  END IF;
  IF lower(actor.email)='aryapat1234@gmail.com' THEN RETURN; END IF;
  IF NOT actor.active OR NOT EXISTS (
    SELECT 1 FROM public.role_assignments WHERE user_id=actor.id AND role='owner' AND revoked_at IS NULL
  ) THEN
    RAISE EXCEPTION 'Owner or permanent Super Admin required' USING ERRCODE='42501';
  END IF;
END;
$$;

CREATE OR REPLACE FUNCTION public.workout_zone_list_access(p_actor_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE result jsonb;
BEGIN
  PERFORM public.workout_zone_require_access_actor(p_actor_id);
  SELECT COALESCE(jsonb_agg(payload ORDER BY is_permanent DESC,payload->>'email',id),'[]'::jsonb)
  INTO result FROM public.workout_zone_access_projection;
  RETURN result;
END;
$$;

CREATE OR REPLACE FUNCTION public.workout_zone_mutate_access(
  p_actor_id uuid, p_action text, p_assignment_id uuid DEFAULT NULL,
  p_email text DEFAULT NULL, p_role text DEFAULT NULL, p_trainer_id uuid DEFAULT NULL,
  p_set_trainer boolean DEFAULT false, p_status text DEFAULT NULL, p_display_name text DEFAULT NULL
)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE
  target public.users%ROWTYPE;
  previous public.role_assignments%ROWTYPE;
  new_id uuid; new_role text; new_trainer uuid; desired_status text;
  before_state jsonb; after_state jsonb; event_kind text;
BEGIN
  -- Serialize access mutations, then re-read actor authorization inside the transaction.
  PERFORM pg_advisory_xact_lock(hashtextextended('workout-zone-access-management',0));
  PERFORM public.workout_zone_require_access_actor(p_actor_id);
  IF p_action NOT IN ('create','update','revoke','reactivate') OR p_action IS NULL THEN
    RAISE EXCEPTION 'Invalid action' USING ERRCODE='22023';
  END IF;
  IF p_role IS NOT NULL AND p_role NOT IN ('owner','admin','trainer') THEN
    RAISE EXCEPTION 'Unsupported assignable role' USING ERRCODE='22023';
  END IF;
  IF p_status IS NOT NULL AND p_status NOT IN ('ACTIVE','REVOKED') THEN
    RAISE EXCEPTION 'Invalid status' USING ERRCODE='22023';
  END IF;
  -- Protect both the synthetic permanent row ID and any legacy ordinary grants.
  IF EXISTS (SELECT 1 FROM public.users WHERE id=p_assignment_id AND lower(email)='aryapat1234@gmail.com')
     OR lower(btrim(p_email))='aryapat1234@gmail.com' THEN
    RAISE EXCEPTION 'Permanent Super Admin cannot be modified' USING ERRCODE='42501';
  END IF;

  IF p_action='create' THEN
    IF p_email IS NULL OR length(btrim(p_email))<4 OR p_role IS NULL THEN
      RAISE EXCEPTION 'Email and role required' USING ERRCODE='22023';
    END IF;
    SELECT * INTO target FROM public.users WHERE email=lower(btrim(p_email)) FOR UPDATE;
    IF NOT FOUND THEN
      INSERT INTO public.users(email,display_name,active)
      VALUES(lower(btrim(p_email)),COALESCE(NULLIF(btrim(p_display_name),''),lower(btrim(p_email))),true)
      RETURNING * INTO target;
    END IF;
    new_role:=p_role; new_trainer:=p_trainer_id; desired_status:='ACTIVE';
    event_kind:='create';
  ELSE
    SELECT * INTO previous FROM public.role_assignments WHERE id=p_assignment_id FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Assignment not found' USING ERRCODE='P0002'; END IF;
    SELECT * INTO target FROM public.users WHERE id=previous.user_id FOR UPDATE;
    IF lower(target.email)='aryapat1234@gmail.com' THEN
      RAISE EXCEPTION 'Permanent Super Admin cannot be modified' USING ERRCODE='42501';
    END IF;
    IF p_email IS NOT NULL AND lower(btrim(p_email))<>target.email THEN
      RAISE EXCEPTION 'Identity email is immutable through access grants' USING ERRCODE='22023';
    END IF;
    SELECT payload INTO before_state FROM public.workout_zone_access_projection WHERE id=previous.id;
    new_role:=COALESCE(p_role,previous.role);
    new_trainer:=CASE WHEN p_set_trainer THEN p_trainer_id
                     WHEN new_role='trainer' THEN previous.trainer_id ELSE NULL END;
    desired_status:=CASE p_action WHEN 'revoke' THEN 'REVOKED' WHEN 'reactivate' THEN 'ACTIVE'
                    ELSE COALESCE(p_status,CASE WHEN previous.revoked_at IS NULL THEN 'ACTIVE' ELSE 'REVOKED' END) END;
    IF desired_status='REVOKED' THEN
      IF new_role<>previous.role OR new_trainer IS DISTINCT FROM previous.trainer_id THEN
        RAISE EXCEPTION 'Reactivate before changing a revoked grant' USING ERRCODE='22023';
      END IF;
      IF previous.revoked_at IS NOT NULL THEN RETURN before_state; END IF;
      UPDATE public.role_assignments SET revoked_at=GREATEST(clock_timestamp(),granted_at) WHERE id=previous.id;
      SELECT payload INTO after_state FROM public.workout_zone_access_projection WHERE id=previous.id;
      INSERT INTO public.access_audit_events(actor_user_id,target_user_id,assignment_id,event_type,old_state,new_state)
      VALUES(p_actor_id,target.id,previous.id,'revoke',before_state,after_state);
      RETURN after_state;
    END IF;
    IF NOT target.active THEN RAISE EXCEPTION 'Account disabled' USING ERRCODE='55000'; END IF;
    IF previous.revoked_at IS NULL AND new_role=previous.role AND new_trainer IS NOT DISTINCT FROM previous.trainer_id THEN
      RETURN before_state;
    END IF;
    event_kind:=CASE WHEN previous.revoked_at IS NULL THEN 'change' ELSE 'reactivate' END;
  END IF;

  IF NOT target.active THEN RAISE EXCEPTION 'Account disabled' USING ERRCODE='55000'; END IF;
  IF (new_role='trainer') <> (new_trainer IS NOT NULL) THEN
    RAISE EXCEPTION 'Trainer role requires exactly one trainer link' USING ERRCODE='22023';
  END IF;
  IF new_trainer IS NOT NULL THEN
    PERFORM 1 FROM public.trainers WHERE id=new_trainer AND status='active' FOR UPDATE;
    IF NOT FOUND THEN RAISE EXCEPTION 'Active trainer not found' USING ERRCODE='P0002'; END IF;
  END IF;
  -- Preserve the old grant; a failed insert rolls the revocation back atomically.
  IF p_action<>'create' AND previous.revoked_at IS NULL THEN
    UPDATE public.role_assignments SET revoked_at=GREATEST(clock_timestamp(),granted_at) WHERE id=previous.id;
  END IF;
  INSERT INTO public.role_assignments(user_id,role,trainer_id,granted_by,granted_at)
  VALUES(target.id,new_role,new_trainer,p_actor_id,clock_timestamp()) RETURNING id INTO new_id;
  SELECT payload INTO after_state FROM public.workout_zone_access_projection WHERE id=new_id;
  INSERT INTO public.access_audit_events(actor_user_id,target_user_id,assignment_id,event_type,old_state,new_state)
  VALUES(p_actor_id,target.id,new_id,event_kind,before_state,after_state);
  RETURN after_state;
END;
$$;

-- These RPCs trust only the backend service role to supply the session-derived actor.
-- No browser role may execute them with an arbitrary actor UUID.
REVOKE ALL ON FUNCTION public.workout_zone_require_access_actor(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.workout_zone_list_access(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.workout_zone_mutate_access(uuid,text,uuid,text,text,uuid,boolean,text,text) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON public.users, public.role_assignments, public.access_audit_events, public.workout_zone_access_projection FROM anon;
    REVOKE ALL ON FUNCTION public.workout_zone_require_access_actor(uuid),public.workout_zone_list_access(uuid),public.workout_zone_mutate_access(uuid,text,uuid,text,text,uuid,boolean,text,text) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON public.users, public.role_assignments, public.access_audit_events, public.workout_zone_access_projection FROM authenticated;
    REVOKE ALL ON FUNCTION public.workout_zone_require_access_actor(uuid),public.workout_zone_list_access(uuid),public.workout_zone_mutate_access(uuid,text,uuid,text,text,uuid,boolean,text,text) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    REVOKE ALL ON public.access_audit_events, public.workout_zone_access_projection FROM service_role;
    REVOKE ALL ON public.users, public.role_assignments FROM service_role;
    GRANT SELECT ON public.users, public.role_assignments TO service_role;
    GRANT INSERT(email,google_subject,display_name,active), UPDATE(google_subject,display_name,active) ON public.users TO service_role;
    REVOKE ALL ON FUNCTION public.workout_zone_require_access_actor(uuid) FROM service_role;
    GRANT EXECUTE ON FUNCTION public.workout_zone_list_access(uuid),public.workout_zone_mutate_access(uuid,text,uuid,text,text,uuid,boolean,text,text) TO service_role;
  END IF;
END;
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
