-- Apply after 002. Delete grants, never accounts or financial records.
BEGIN;
ALTER TABLE public.access_audit_events ALTER COLUMN assignment_id DROP NOT NULL;
ALTER TABLE public.access_audit_events DROP CONSTRAINT access_audit_events_assignment_id_fkey;
ALTER TABLE public.access_audit_events ADD CONSTRAINT access_audit_events_assignment_id_fkey
  FOREIGN KEY (assignment_id) REFERENCES public.role_assignments(id) ON DELETE SET NULL;
ALTER TABLE public.access_audit_events DROP CONSTRAINT access_audit_events_event_type_check;
ALTER TABLE public.access_audit_events ADD CONSTRAINT access_audit_events_event_type_check
  CHECK (event_type IN ('create','change','revoke','reactivate','delete'));

CREATE OR REPLACE FUNCTION public.workout_zone_delete_access(p_actor_id uuid,p_assignment_id uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE grant_row public.role_assignments%ROWTYPE; target public.users%ROWTYPE; snapshot jsonb;
BEGIN
  PERFORM pg_advisory_xact_lock(hashtextextended('workout-zone-access-management',0));
  PERFORM public.workout_zone_require_access_actor(p_actor_id);
  IF EXISTS (SELECT 1 FROM public.users WHERE id=p_assignment_id AND lower(email)='aryapat1234@gmail.com') THEN
    RAISE EXCEPTION 'Permanent Super Admin cannot be deleted' USING ERRCODE='42501';
  END IF;
  SELECT * INTO grant_row FROM public.role_assignments WHERE id=p_assignment_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'Assignment not found' USING ERRCODE='P0002'; END IF;
  SELECT * INTO target FROM public.users WHERE id=grant_row.user_id FOR UPDATE;
  IF lower(target.email)='aryapat1234@gmail.com' THEN
    RAISE EXCEPTION 'Permanent Super Admin cannot be deleted' USING ERRCODE='42501';
  END IF;
  SELECT payload INTO snapshot FROM public.workout_zone_access_projection WHERE id=grant_row.id;
  INSERT INTO public.access_audit_events(actor_user_id,target_user_id,assignment_id,event_type,old_state,new_state)
  VALUES(p_actor_id,target.id,grant_row.id,'delete',snapshot,
         jsonb_build_object('deleted',true,'assignmentId',grant_row.id));
  DELETE FROM public.role_assignments WHERE id=grant_row.id;
  -- Audit FK links become NULL; original grant UUIDs and all historical facts
  -- remain in immutable JSON snapshots. Users and other grants are untouched.
  RETURN true;
END;
$$;
REVOKE ALL ON FUNCTION public.workout_zone_delete_access(uuid,uuid) FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON FUNCTION public.workout_zone_delete_access(uuid,uuid) FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON FUNCTION public.workout_zone_delete_access(uuid,uuid) FROM authenticated;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN
    GRANT EXECUTE ON FUNCTION public.workout_zone_delete_access(uuid,uuid) TO service_role;
  END IF;
END;
$$;
NOTIFY pgrst, 'reload schema';
COMMIT;
