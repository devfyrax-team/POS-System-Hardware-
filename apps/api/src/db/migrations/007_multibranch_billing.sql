-- Phase 7: branch transfers, platform billing, platform statistics.

CREATE TABLE branch_transfer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  from_branch_id uuid NOT NULL,
  to_branch_id uuid NOT NULL,
  number text NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','approved','in_transit','received','closed','rejected','cancelled')),
  note text,
  requested_by uuid NOT NULL,
  approved_by uuid,
  dispatched_by uuid,
  dispatched_at timestamptz,
  received_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, number),
  CHECK (from_branch_id <> to_branch_id),
  FOREIGN KEY (shop_id, from_branch_id) REFERENCES branch(shop_id, id),
  FOREIGN KEY (shop_id, to_branch_id) REFERENCES branch(shop_id, id)
);

CREATE TABLE branch_transfer_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  transfer_id uuid NOT NULL,
  product_id uuid NOT NULL,
  qty_requested numeric(18,4) NOT NULL CHECK (qty_requested > 0),
  qty_dispatched numeric(18,4) NOT NULL DEFAULT 0,
  qty_received numeric(18,4) NOT NULL DEFAULT 0,
  unit_cost numeric(18,4),                 -- cost per base unit that travels with the stock
  batches jsonb,                           -- [{ batchNo, mfgDate, expiryDate, qty, supplierId }] to recreate at the destination
  FOREIGN KEY (shop_id, transfer_id) REFERENCES branch_transfer(shop_id, id),
  FOREIGN KEY (shop_id, product_id) REFERENCES product(shop_id, id),
  CHECK (qty_received <= qty_dispatched)
);

CREATE TABLE transfer_discrepancy (
  id bigserial PRIMARY KEY,
  shop_id uuid NOT NULL,
  transfer_id uuid NOT NULL,
  product_id uuid NOT NULL,
  qty_missing numeric(18,4) NOT NULL,
  value numeric(18,2) NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Platform billing: completely separate from a shop's own sales, customers and payments.
CREATE SEQUENCE platform_invoice_seq;
CREATE TABLE platform_invoice (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shop(id),
  number text NOT NULL UNIQUE,
  plan_id uuid NOT NULL REFERENCES plan(id),
  period text NOT NULL CHECK (period IN ('monthly','annual')),
  amount numeric(18,2) NOT NULL CHECK (amount >= 0),
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','paid','void')),
  issued_at timestamptz NOT NULL DEFAULT now(),
  due_at timestamptz NOT NULL,
  paid_at timestamptz
);
CREATE TABLE platform_payment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id uuid NOT NULL REFERENCES platform_invoice(id),
  shop_id uuid NOT NULL REFERENCES shop(id),
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  method text NOT NULL,
  reference text,
  recorded_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['branch_transfer','branch_transfer_line','transfer_discrepancy']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_or_platform ON %I USING (shop_id = app_shop() OR app_is_platform()) WITH CHECK (shop_id = app_shop() OR app_is_platform())', t);
  END LOOP;
  FOREACH t IN ARRAY ARRAY['platform_invoice','platform_payment']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_read ON %I FOR SELECT USING (shop_id = app_shop() OR app_is_platform())', t);
    EXECUTE format('CREATE POLICY platform_write ON %I FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform())', t);
  END LOOP;
END $$;

-- Aggregate counts only (no sales detail): feeds the Super Admin analytics page.
CREATE FUNCTION platform_stats() RETURNS json
LANGUAGE sql SECURITY DEFINER SET search_path = public AS
$$ SELECT json_build_object(
     'shops_total', (SELECT count(*) FROM shop),
     'shops_by_status', (SELECT coalesce(json_object_agg(status, c), '{}'::json) FROM (SELECT status, count(*) c FROM shop GROUP BY status) x),
     'subscriptions_by_status', (SELECT coalesce(json_object_agg(status, c), '{}'::json) FROM (SELECT status, count(*) c FROM subscription GROUP BY status) x),
     'plan_mix', (SELECT coalesce(json_object_agg(code, c), '{}'::json) FROM (SELECT p.code, count(*) c FROM subscription s JOIN plan p ON p.id = s.plan_id GROUP BY p.code) x),
     'signups_by_month', (SELECT coalesce(json_object_agg(m, c), '{}'::json) FROM (SELECT to_char(date_trunc('month', created_at), 'YYYY-MM') m, count(*) c FROM shop GROUP BY 1) x),
     'active_terminals', (SELECT count(*) FROM terminal WHERE status = 'active'),
     'active_users', (SELECT count(*) FROM users WHERE status = 'active'),
     'branches', (SELECT count(*) FROM branch WHERE status = 'active')
   ) $$;
REVOKE ALL ON FUNCTION platform_stats() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION platform_stats() TO pos_app;
