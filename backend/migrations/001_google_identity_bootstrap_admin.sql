-- Additive migration for the existing schema; never replay the initial schema.
-- Fails atomically on duplicate email/subject data: reconcile, don't delete it.
BEGIN;

CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_subject
ON public.users (google_subject)
WHERE google_subject IS NOT NULL;

-- Required to serialize concurrent first-login account creation, including case variants.
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_normalized_email
ON public.users (lower(btrim(email)));

CREATE OR REPLACE FUNCTION public.guard_permanent_admin_and_google_identity()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF lower(btrim(OLD.email)) = 'aryapat1234@gmail.com' THEN
      RAISE EXCEPTION 'Permanent Super Admin cannot be deleted' USING ERRCODE = '23514';
    END IF;
    RETURN OLD;
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF OLD.google_subject IS NOT NULL AND NEW.google_subject IS DISTINCT FROM OLD.google_subject THEN
      RAISE EXCEPTION 'A bound Google identity cannot be replaced or cleared' USING ERRCODE = '23514';
    END IF;
    IF lower(btrim(OLD.email)) = 'aryapat1234@gmail.com' AND
       (lower(btrim(NEW.email)) IS DISTINCT FROM 'aryapat1234@gmail.com' OR NEW.id IS DISTINCT FROM OLD.id) THEN
      RAISE EXCEPTION 'Permanent Super Admin identity cannot be changed' USING ERRCODE = '23514';
    END IF;
    IF lower(btrim(NEW.email)) = 'aryapat1234@gmail.com' AND
       lower(btrim(OLD.email)) IS DISTINCT FROM 'aryapat1234@gmail.com' THEN
      RAISE EXCEPTION 'An existing account cannot be renamed to the bootstrap identity' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF lower(btrim(NEW.email)) = 'aryapat1234@gmail.com' AND NEW.active IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'Permanent Super Admin cannot be deactivated' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS protect_permanent_admin_identity ON public.users;
CREATE TRIGGER protect_permanent_admin_identity
BEFORE INSERT OR UPDATE OR DELETE ON public.users
FOR EACH ROW EXECUTE FUNCTION public.guard_permanent_admin_and_google_identity();

CREATE OR REPLACE FUNCTION public.guard_permanent_admin_role_assignments()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    IF EXISTS (SELECT 1 FROM public.users WHERE id = OLD.user_id AND lower(btrim(email)) = 'aryapat1234@gmail.com') THEN
      RAISE EXCEPTION 'Permanent Super Admin grants cannot be changed' USING ERRCODE = '23514';
    END IF;
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    IF EXISTS (SELECT 1 FROM public.users WHERE id = NEW.user_id AND lower(btrim(email)) = 'aryapat1234@gmail.com') THEN
      RAISE EXCEPTION 'Permanent Super Admin does not use ordinary role assignments' USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS protect_permanent_admin_grants ON public.role_assignments;
CREATE TRIGGER protect_permanent_admin_grants
BEFORE INSERT OR UPDATE OR DELETE ON public.role_assignments
FOR EACH ROW EXECUTE FUNCTION public.guard_permanent_admin_role_assignments();

-- Restore availability without fabricating a subject or creating a user from SQL.
UPDATE public.users SET active = true
WHERE lower(btrim(email)) = 'aryapat1234@gmail.com' AND active IS DISTINCT FROM true;

REVOKE ALL ON FUNCTION public.guard_permanent_admin_and_google_identity() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.guard_permanent_admin_role_assignments() FROM PUBLIC;
COMMIT;
