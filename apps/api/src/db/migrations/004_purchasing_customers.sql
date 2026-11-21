-- Phase 4: suppliers, purchasing, customers, credit, cheques.

-- ---------- suppliers & purchasing ----------
CREATE TABLE supplier (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shop(id),
  name text NOT NULL,
  phone text,
  email text,
  address text,
  payment_terms_days int NOT NULL DEFAULT 30,
  return_terms text,                       -- important for near-expiry stock
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);
CREATE UNIQUE INDEX supplier_name ON supplier (shop_id, lower(name));

CREATE TABLE purchase_order (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  number text NOT NULL,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','approved','partial','received','cancelled')),
  expected_date date,
  note text,
  created_by uuid NOT NULL,
  approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, number),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branch(shop_id, id),
  FOREIGN KEY (shop_id, supplier_id) REFERENCES supplier(shop_id, id)
);
CREATE TABLE purchase_order_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  po_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  qty_unit numeric(18,4) NOT NULL CHECK (qty_unit > 0),
  qty_base numeric(18,4) NOT NULL CHECK (qty_base > 0),
  unit_cost numeric(18,4) NOT NULL CHECK (unit_cost >= 0),    -- per selling unit
  received_base numeric(18,4) NOT NULL DEFAULT 0,
  FOREIGN KEY (shop_id, po_id) REFERENCES purchase_order(shop_id, id),
  FOREIGN KEY (shop_id, product_id) REFERENCES product(shop_id, id),
  FOREIGN KEY (shop_id, unit_id) REFERENCES product_unit(shop_id, id)
);

CREATE TABLE purchase (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  po_id uuid,
  number text NOT NULL,
  supplier_invoice_no text,
  subtotal numeric(18,2) NOT NULL,
  landed_cost numeric(18,2) NOT NULL DEFAULT 0,
  total numeric(18,2) NOT NULL,
  note text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, number),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branch(shop_id, id),
  FOREIGN KEY (shop_id, supplier_id) REFERENCES supplier(shop_id, id)
);
CREATE TABLE purchase_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  purchase_id uuid NOT NULL,
  po_line_id uuid,
  product_id uuid NOT NULL,
  unit text NOT NULL,
  qty_unit numeric(18,4) NOT NULL CHECK (qty_unit > 0),
  qty_base numeric(18,4) NOT NULL CHECK (qty_base > 0),
  factor numeric(18,6) NOT NULL,
  unit_cost numeric(18,4) NOT NULL,              -- per selling unit as invoiced
  line_cost numeric(18,2) NOT NULL,
  landed_alloc numeric(18,4) NOT NULL DEFAULT 0, -- share of transport etc.
  unit_cost_base numeric(18,4) NOT NULL,         -- effective cost per base unit incl. landed
  batch_id uuid,
  movement_id bigint,
  FOREIGN KEY (shop_id, purchase_id) REFERENCES purchase(shop_id, id),
  FOREIGN KEY (shop_id, product_id) REFERENCES product(shop_id, id)
);
CREATE UNIQUE INDEX purchase_line_id ON purchase_line (shop_id, id);

CREATE TABLE purchase_return (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  purchase_id uuid NOT NULL,
  number text NOT NULL,
  reason text NOT NULL,
  total numeric(18,2) NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, number),
  FOREIGN KEY (shop_id, purchase_id) REFERENCES purchase(shop_id, id)
);
CREATE TABLE purchase_return_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  return_id uuid NOT NULL,
  purchase_line_id uuid NOT NULL,
  qty_unit numeric(18,4) NOT NULL CHECK (qty_unit > 0),
  qty_base numeric(18,4) NOT NULL CHECK (qty_base > 0),
  amount numeric(18,2) NOT NULL,
  FOREIGN KEY (shop_id, return_id) REFERENCES purchase_return(shop_id, id),
  FOREIGN KEY (shop_id, purchase_line_id) REFERENCES purchase_line(shop_id, id)
);

CREATE TABLE purchase_price_history (
  id bigserial PRIMARY KEY,
  shop_id uuid NOT NULL,
  product_id uuid NOT NULL,
  supplier_id uuid,
  purchase_id uuid,
  unit_cost_base numeric(18,4) NOT NULL,
  qty_base numeric(18,4) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX purchase_price_history_product ON purchase_price_history (shop_id, product_id, id DESC);

-- What we owe a supplier. Insert-only; positive = we owe more.
CREATE TABLE supplier_ledger (
  id bigserial PRIMARY KEY,
  shop_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('purchase','payment','return','cheque_bounce','adjustment')),
  amount numeric(18,2) NOT NULL,
  ref_type text,
  ref_id text,
  due_date date,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, supplier_id) REFERENCES supplier(shop_id, id)
);
CREATE INDEX supplier_ledger_supplier ON supplier_ledger (shop_id, supplier_id, id);

CREATE TABLE supplier_payment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  supplier_id uuid NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  method text NOT NULL CHECK (method IN ('cash','bank_transfer','cheque','card')),
  reference text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, supplier_id) REFERENCES supplier(shop_id, id)
);

-- ---------- customers & credit ----------
CREATE TABLE customer (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shop(id),
  name text NOT NULL,
  phone text,
  email text,
  address text,
  type text NOT NULL DEFAULT 'retail' CHECK (type IN ('retail','contractor','wholesale')),
  credit_limit numeric(18,2) NOT NULL DEFAULT 0 CHECK (credit_limit >= 0),
  balance numeric(18,2) NOT NULL DEFAULT 0,       -- cached sum of credit_entry; row-locked when it changes
  due_days int NOT NULL DEFAULT 30,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  notes text,
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);
CREATE INDEX customer_name ON customer USING gin (lower(name || ' ' || coalesce(phone,'')) gin_trgm_ops);

CREATE TABLE credit_entry (
  id bigserial PRIMARY KEY,
  shop_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  entry_type text NOT NULL CHECK (entry_type IN ('sale','payment','reversal','cheque_bounce','fee','adjustment')),
  amount numeric(18,2) NOT NULL,                  -- positive = customer owes more
  sale_id uuid,
  payment_id uuid,
  due_date date,
  note text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, customer_id) REFERENCES customer(shop_id, id)
);
CREATE INDEX credit_entry_customer ON credit_entry (shop_id, customer_id, id);

CREATE TABLE customer_payment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  customer_id uuid NOT NULL,
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  method text NOT NULL CHECK (method IN ('cash','card','bank_transfer','cheque')),
  reference text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES customer(shop_id, id)
);

ALTER TABLE sale ADD CONSTRAINT sale_customer_fk FOREIGN KEY (shop_id, customer_id) REFERENCES customer(shop_id, id);

CREATE TABLE cheque (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  direction text NOT NULL CHECK (direction IN ('received','issued')),
  customer_id uuid,
  supplier_id uuid,
  bank text,
  cheque_no text NOT NULL,
  cheque_date date NOT NULL,                      -- post-dated cheques have a future date
  amount numeric(18,2) NOT NULL CHECK (amount > 0),
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','deposited','cleared','bounced')),
  sale_id uuid,
  customer_payment_id uuid,
  supplier_payment_id uuid,
  fee numeric(18,2) NOT NULL DEFAULT 0,
  note text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  status_changed_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES customer(shop_id, id),
  FOREIGN KEY (shop_id, supplier_id) REFERENCES supplier(shop_id, id),
  CHECK ((direction = 'received' AND supplier_id IS NULL) OR (direction = 'issued' AND customer_id IS NULL))
);
CREATE INDEX cheque_due ON cheque (shop_id, status, cheque_date);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['supplier','purchase_order','purchase_order_line','purchase','purchase_line','purchase_return','purchase_return_line',
    'purchase_price_history','supplier_ledger','supplier_payment','customer','credit_entry','customer_payment','cheque']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_or_platform ON %I USING (shop_id = app_shop() OR app_is_platform()) WITH CHECK (shop_id = app_shop() OR app_is_platform())', t);
  END LOOP;
END $$;
