-- Gym management schema, PostgreSQL 15+. Run once on an empty database.
-- Amounts use a single configured currency (default INR); no FX conversion.
BEGIN;
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL UNIQUE CHECK (email = lower(email) AND length(trim(email)) > 3),
  google_subject text UNIQUE,
  display_name text NOT NULL CHECK (length(trim(display_name)) > 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE members (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_number text NOT NULL UNIQUE,
  full_name text NOT NULL CHECK (length(trim(full_name)) > 0),
  email text, phone text,
  joined_on date NOT NULL DEFAULT current_date,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE trainers (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name text NOT NULL CHECK (length(trim(full_name)) > 0),
  email text, phone text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  created_at timestamptz NOT NULL DEFAULT now()
);
-- Trainers have no user_id. Staff access is attached here.
CREATE TABLE role_assignments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  role text NOT NULL CHECK (role IN ('owner','admin','trainer')),
  trainer_id uuid REFERENCES trainers(id) ON DELETE RESTRICT,
  granted_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  granted_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  CHECK ((role = 'trainer') = (trainer_id IS NOT NULL)),
  CHECK (revoked_at IS NULL OR revoked_at >= granted_at)
);
CREATE UNIQUE INDEX role_assignments_active_role_uq ON role_assignments(user_id, role) WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX role_assignments_active_trainer_uq ON role_assignments(trainer_id) WHERE revoked_at IS NULL AND trainer_id IS NOT NULL;

CREATE TABLE gym_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  duration_days integer NOT NULL CHECK (duration_days > 0),
  list_price numeric(12,2) NOT NULL CHECK (list_price >= 0),
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE trainer_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  duration_days integer NOT NULL CHECK (duration_days > 0),
  list_price numeric(12,2) NOT NULL CHECK (list_price >= 0),
  active boolean NOT NULL DEFAULT true
);
CREATE TABLE member_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  gym_plan_id uuid NOT NULL REFERENCES gym_plans(id) ON DELETE RESTRICT,
  starts_on date NOT NULL, ends_on date NOT NULL,
  price_snapshot numeric(12,2) NOT NULL CHECK (price_snapshot >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on), UNIQUE (id, member_id)
);
CREATE TABLE member_trainer_plan (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  trainer_id uuid NOT NULL REFERENCES trainers(id) ON DELETE RESTRICT,
  trainer_plan_id uuid NOT NULL REFERENCES trainer_plans(id) ON DELETE RESTRICT,
  starts_on date NOT NULL, ends_on date NOT NULL,
  price_snapshot numeric(12,2) NOT NULL CHECK (price_snapshot >= 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','cancelled','expired')),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (ends_on >= starts_on), UNIQUE (id, member_id), UNIQUE (id, trainer_id)
);

CREATE TABLE billing_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  cycle_key text NOT NULL UNIQUE CHECK (length(trim(cycle_key)) > 0),
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running','completed','failed')),
  started_at timestamptz NOT NULL DEFAULT now(), finished_at timestamptz,
  error_message text,
  CHECK (finished_at IS NULL OR finished_at >= started_at)
);
CREATE TABLE invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  member_id uuid NOT NULL REFERENCES members(id) ON DELETE RESTRICT,
  invoice_number text NOT NULL UNIQUE,
  invoice_date date NOT NULL DEFAULT current_date,
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','issued','void')),
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (due_date >= invoice_date), UNIQUE (id, member_id)
);
CREATE TABLE invoice_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL,
  member_id uuid NOT NULL,
  member_plan_id uuid,
  member_trainer_plan_id uuid,
  item_type text NOT NULL CHECK (item_type IN ('gym','personal_training','other')),
  description text NOT NULL CHECK (length(trim(description)) > 0),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  service_start date, service_end date,
  billing_key text NOT NULL UNIQUE CHECK (length(trim(billing_key)) > 0),
  CONSTRAINT item_invoice_member_fk FOREIGN KEY (invoice_id, member_id) REFERENCES invoices(id, member_id) ON DELETE RESTRICT,
  CONSTRAINT item_gym_member_fk FOREIGN KEY (member_plan_id, member_id) REFERENCES member_plans(id, member_id) ON DELETE RESTRICT,
  CONSTRAINT item_pt_member_fk FOREIGN KEY (member_trainer_plan_id, member_id) REFERENCES member_trainer_plan(id, member_id) ON DELETE RESTRICT,
  CHECK ((item_type = 'gym' AND member_plan_id IS NOT NULL AND member_trainer_plan_id IS NULL)
      OR (item_type = 'personal_training' AND member_trainer_plan_id IS NOT NULL AND member_plan_id IS NULL)
      OR (item_type = 'other' AND member_plan_id IS NULL AND member_trainer_plan_id IS NULL)),
  CHECK (service_start IS NULL OR service_end IS NULL OR service_end >= service_start),
  UNIQUE (id, invoice_id)
);
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES invoices(id) ON DELETE RESTRICT,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  method text NOT NULL CHECK (method IN ('cash','upi','card','bank','other')),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','completed','failed')),
  provider text, provider_payment_id text,
  idempotency_key text NOT NULL UNIQUE,
  received_at timestamptz,
  received_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (length(trim(idempotency_key)) > 0),
  CHECK (status <> 'completed' OR received_at IS NOT NULL),
  UNIQUE (id, invoice_id)
);
CREATE UNIQUE INDEX payments_provider_ref_uq ON payments(provider, provider_payment_id)
  WHERE provider IS NOT NULL AND provider_payment_id IS NOT NULL;
CREATE TABLE payment_allocations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL,
  invoice_item_id uuid NOT NULL,
  invoice_id uuid NOT NULL,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (payment_id, invoice_id) REFERENCES payments(id, invoice_id) ON DELETE RESTRICT,
  FOREIGN KEY (invoice_item_id, invoice_id) REFERENCES invoice_items(id, invoice_id) ON DELETE RESTRICT,
  UNIQUE (payment_id, invoice_item_id), UNIQUE (id, invoice_item_id)
);
CREATE TABLE refunds (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payment_id uuid NOT NULL REFERENCES payments(id) ON DELETE RESTRICT,
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  reason text NOT NULL CHECK (length(trim(reason)) > 0),
  idempotency_key text NOT NULL UNIQUE,
  refunded_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT
);

CREATE TABLE trainer_payout_rules (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id uuid NOT NULL REFERENCES trainers(id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('percent','fixed')),
  value numeric(12,2) NOT NULL CHECK (value >= 0),
  effective_from date NOT NULL, effective_until date,
  CHECK (kind <> 'percent' OR value <= 100),
  CHECK (effective_until IS NULL OR effective_until >= effective_from),
  UNIQUE (id, trainer_id)
);
CREATE TABLE trainer_payouts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trainer_id uuid NOT NULL REFERENCES trainers(id) ON DELETE RESTRICT,
  period_start date NOT NULL, period_end date NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','paid','cancelled')),
  approved_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  paid_at timestamptz, payment_reference text,
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (period_end >= period_start),
  CHECK (status <> 'paid' OR (paid_at IS NOT NULL AND payment_reference IS NOT NULL)),
  UNIQUE (trainer_id, period_start, period_end), UNIQUE (id, trainer_id)
);
CREATE TABLE trainer_payout_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  payout_id uuid NOT NULL,
  trainer_id uuid NOT NULL,
  allocation_id uuid NOT NULL UNIQUE REFERENCES payment_allocations(id) ON DELETE RESTRICT,
  rule_id uuid,
  rule_kind text NOT NULL CHECK (rule_kind IN ('percent','fixed')),
  rule_value numeric(12,2) NOT NULL CHECK (rule_value >= 0),
  amount numeric(12,2) NOT NULL CHECK (amount >= 0),
  FOREIGN KEY (payout_id, trainer_id) REFERENCES trainer_payouts(id, trainer_id) ON DELETE RESTRICT,
  FOREIGN KEY (rule_id, trainer_id) REFERENCES trainer_payout_rules(id, trainer_id) ON DELETE RESTRICT,
  CHECK (rule_kind <> 'percent' OR rule_value <= 100)
);
CREATE TABLE expenses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  incurred_on date NOT NULL,
  category text NOT NULL CHECK (length(trim(category)) > 0),
  description text NOT NULL CHECK (length(trim(description)) > 0),
  amount numeric(12,2) NOT NULL CHECK (amount > 0),
  currency char(3) NOT NULL DEFAULT 'INR' CHECK (currency = 'INR'),
  status text NOT NULL DEFAULT 'recorded' CHECK (status IN ('recorded','paid','void')),
  external_reference text,
  created_by uuid REFERENCES users(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Commit-time checks serialize on the parent row, including concurrent allocations.
CREATE FUNCTION check_payment_allocation() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE p payments%ROWTYPE; allocated numeric; item_total numeric;
BEGIN
  SELECT * INTO p FROM payments WHERE id = COALESCE(NEW.payment_id, OLD.payment_id) FOR UPDATE;
  PERFORM 1 FROM invoice_items WHERE id = COALESCE(NEW.invoice_item_id, OLD.invoice_item_id) FOR UPDATE;
  SELECT COALESCE(sum(amount),0) INTO allocated FROM payment_allocations WHERE payment_id = p.id;
  IF allocated > p.amount OR (allocated > 0 AND p.status <> 'completed') THEN
    RAISE EXCEPTION 'Invalid allocations for payment %', p.id;
  END IF;
  SELECT COALESCE(sum(a.amount),0) INTO item_total FROM payment_allocations a
    WHERE a.invoice_item_id = COALESCE(NEW.invoice_item_id, OLD.invoice_item_id);
  IF item_total > (SELECT amount FROM invoice_items WHERE id = COALESCE(NEW.invoice_item_id, OLD.invoice_item_id)) THEN
    RAISE EXCEPTION 'Invoice item overallocated';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER allocation_limit AFTER INSERT OR UPDATE OR DELETE ON payment_allocations
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_payment_allocation();

CREATE FUNCTION check_refund_total() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE paid_amount numeric; refunded numeric; payment_status text;
BEGIN
  SELECT amount, status INTO paid_amount, payment_status FROM payments
    WHERE id = COALESCE(NEW.payment_id, OLD.payment_id) FOR UPDATE;
  SELECT COALESCE(sum(amount),0) INTO refunded FROM refunds
    WHERE payment_id = COALESCE(NEW.payment_id, OLD.payment_id);
  IF refunded > paid_amount OR payment_status <> 'completed' THEN
    RAISE EXCEPTION 'Invalid refund total or payment status';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER refund_limit AFTER INSERT OR UPDATE OR DELETE ON refunds
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION check_refund_total();

CREATE FUNCTION check_payout_item() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE linked_trainer uuid; payment_status text;
BEGIN
  SELECT mtp.trainer_id, p.status INTO linked_trainer, payment_status
  FROM payment_allocations a JOIN invoice_items i ON i.id = a.invoice_item_id
  JOIN member_trainer_plan mtp ON mtp.id = i.member_trainer_plan_id
  JOIN payments p ON p.id = a.payment_id WHERE a.id = NEW.allocation_id;
  IF linked_trainer IS DISTINCT FROM NEW.trainer_id OR payment_status <> 'completed' THEN
    RAISE EXCEPTION 'Payout item must use completed PT collection for the same trainer';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER payout_item_source BEFORE INSERT OR UPDATE ON trainer_payout_items
  FOR EACH ROW EXECUTE FUNCTION check_payout_item();

CREATE INDEX member_plans_member_dates_idx ON member_plans(member_id, ends_on);
CREATE INDEX member_trainer_plan_member_dates_idx ON member_trainer_plan(member_id, ends_on);
CREATE INDEX member_trainer_plan_trainer_idx ON member_trainer_plan(trainer_id);
CREATE INDEX invoices_member_due_idx ON invoices(member_id, due_date) WHERE status = 'issued';
CREATE INDEX invoice_items_invoice_idx ON invoice_items(invoice_id);
CREATE INDEX payments_invoice_idx ON payments(invoice_id) WHERE status = 'completed';
CREATE INDEX allocations_item_idx ON payment_allocations(invoice_item_id);
CREATE INDEX refunds_payment_idx ON refunds(payment_id);
CREATE INDEX payouts_trainer_period_idx ON trainer_payouts(trainer_id, period_end);
CREATE INDEX expenses_date_category_idx ON expenses(incurred_on, category) WHERE status <> 'void';

CREATE VIEW invoice_balances AS
SELECT i.id AS invoice_id, i.member_id, i.invoice_number, i.due_date, i.status,
  COALESCE((SELECT sum(li.amount) FROM invoice_items li WHERE li.invoice_id=i.id),0)::numeric(12,2) AS billed,
  COALESCE((SELECT sum(a.amount) FROM payment_allocations a JOIN payments p ON p.id=a.payment_id
    WHERE a.invoice_id=i.id AND p.status='completed'),0)::numeric(12,2) AS allocated
FROM invoices i;
COMMIT;
