-- Phase 3: POS and sales. Sales, lines, payments are insert-only; corrections are new rows (void / return).

ALTER TABLE product ADD COLUMN non_returnable boolean NOT NULL DEFAULT false;

CREATE TABLE sale (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  cashier_id uuid NOT NULL,
  customer_id uuid,
  invoice_no text NOT NULL,
  idempotency_key text NOT NULL,
  price_tier text NOT NULL DEFAULT 'retail',
  subtotal numeric(18,2) NOT NULL,          -- sum of line totals (after line discounts)
  bill_discount numeric(18,2) NOT NULL DEFAULT 0,
  total numeric(18,2) NOT NULL,
  paid numeric(18,2) NOT NULL,              -- applied to the bill (cash tendered minus change)
  tendered numeric(18,2),                   -- cash handed over
  change_due numeric(18,2) NOT NULL DEFAULT 0,
  cogs_total numeric(18,4) NOT NULL DEFAULT 0,
  has_estimated_cost boolean NOT NULL DEFAULT false,
  approver_id uuid,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, invoice_no),
  UNIQUE (shop_id, idempotency_key),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branch(shop_id, id),
  FOREIGN KEY (shop_id, terminal_id) REFERENCES terminal(shop_id, id)
);
CREATE INDEX sale_branch_time ON sale (shop_id, branch_id, created_at DESC);
CREATE INDEX sale_cashier_time ON sale (shop_id, cashier_id, created_at DESC);

CREATE TABLE sale_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  line_no int NOT NULL,
  product_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  unit text NOT NULL,
  qty_unit numeric(18,4) NOT NULL CHECK (qty_unit > 0),
  qty_base numeric(18,4) NOT NULL CHECK (qty_base > 0),
  factor numeric(18,6) NOT NULL,            -- snapshot of the conversion used
  price_list numeric(18,4) NOT NULL,        -- shelf price per selling unit when sold
  price_charged numeric(18,4) NOT NULL,     -- what the till actually charged per selling unit
  price_overridden boolean NOT NULL DEFAULT false,
  discount numeric(18,2) NOT NULL DEFAULT 0,
  line_total numeric(18,2) NOT NULL,
  cogs numeric(18,4) NOT NULL,              -- cost of goods sold, stored permanently
  cost_estimated boolean NOT NULL DEFAULT false,
  below_cost boolean NOT NULL DEFAULT false,
  batch_id uuid,
  movement_id bigint,
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, sale_id) REFERENCES sale(shop_id, id),
  FOREIGN KEY (shop_id, product_id) REFERENCES product(shop_id, id)
);
CREATE INDEX sale_line_product ON sale_line (shop_id, product_id);
CREATE INDEX sale_line_sale ON sale_line (sale_id);

CREATE TABLE payment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  terminal_id uuid,
  sale_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'sale' CHECK (kind IN ('sale','refund','void')),
  method text NOT NULL CHECK (method IN ('cash','card','bank_transfer','cheque','credit')),
  amount numeric(18,2) NOT NULL,            -- negative for refunds / void reversals
  reference text,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, sale_id) REFERENCES sale(shop_id, id)
);
CREATE INDEX payment_sale ON payment (sale_id);
CREATE INDEX payment_time ON payment (shop_id, branch_id, created_at);

CREATE TABLE sale_void (
  sale_id uuid PRIMARY KEY,
  shop_id uuid NOT NULL,
  reason text NOT NULL,
  voided_by uuid NOT NULL,
  approver_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, sale_id) REFERENCES sale(shop_id, id)
);

CREATE TABLE sales_return (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  terminal_id uuid,
  sale_id uuid NOT NULL,
  number text NOT NULL,
  reason text NOT NULL,
  refund_method text NOT NULL,
  total numeric(18,2) NOT NULL,
  created_by uuid NOT NULL,
  approver_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, number),
  FOREIGN KEY (shop_id, sale_id) REFERENCES sale(shop_id, id)
);
CREATE TABLE sales_return_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  return_id uuid NOT NULL,
  sale_line_id uuid NOT NULL,
  product_id uuid NOT NULL,
  qty_unit numeric(18,4) NOT NULL CHECK (qty_unit > 0),
  qty_base numeric(18,4) NOT NULL CHECK (qty_base > 0),
  amount numeric(18,2) NOT NULL,
  disposition text NOT NULL CHECK (disposition IN ('sellable','damaged')),
  unit_cost numeric(18,4) NOT NULL,
  FOREIGN KEY (shop_id, return_id) REFERENCES sales_return(shop_id, id),
  FOREIGN KEY (shop_id, sale_line_id) REFERENCES sale_line(shop_id, id)
);

CREATE TABLE held_bill (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  terminal_id uuid NOT NULL,
  user_id uuid NOT NULL,
  label text,
  cart jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE quotation (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  number text NOT NULL,
  customer_id uuid,
  customer_name text,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','converted','expired','cancelled')),
  valid_until date,
  lines jsonb NOT NULL,
  total numeric(18,2) NOT NULL,
  note text,
  created_by uuid NOT NULL,
  converted_sale_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, number)
);

CREATE TABLE delivery_note (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  sale_id uuid NOT NULL,
  number text NOT NULL,
  created_by uuid NOT NULL,
  note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, number),
  FOREIGN KEY (shop_id, sale_id) REFERENCES sale(shop_id, id)
);
CREATE TABLE delivery_note_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  note_id uuid NOT NULL,
  sale_line_id uuid NOT NULL,
  qty_unit numeric(18,4) NOT NULL CHECK (qty_unit > 0),
  FOREIGN KEY (shop_id, note_id) REFERENCES delivery_note(shop_id, id),
  FOREIGN KEY (shop_id, sale_line_id) REFERENCES sale_line(shop_id, id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['sale','sale_line','payment','sale_void','sales_return','sales_return_line','held_bill','quotation','delivery_note','delivery_note_line']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_or_platform ON %I USING (shop_id = app_shop() OR app_is_platform()) WITH CHECK (shop_id = app_shop() OR app_is_platform())', t);
  END LOOP;
END $$;
