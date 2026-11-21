-- Phase 2: master catalog, shop products, units, barcodes, prices, inventory ledger, costing, stocktake, alerts, import.

-- Per-shop counters (SKU numbers, short codes, import batch numbers, ...)
CREATE TABLE shop_counter (
  shop_id uuid NOT NULL REFERENCES shop(id),
  key text NOT NULL,
  value bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, key)
);

-- ---------- master catalog (shared, identity only: never prices or stock) ----------
CREATE TABLE master_category (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL UNIQUE,
  name_si text,
  shop_type text NOT NULL DEFAULT 'both' CHECK (shop_type IN ('hardware','paint','both'))
);

CREATE TABLE master_product (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  category_id uuid REFERENCES master_category(id),
  name_en text NOT NULL,
  name_si text,
  alt_names text[] NOT NULL DEFAULT '{}',
  brand text,
  size text,
  material text,
  base_unit text NOT NULL DEFAULT 'pcs',
  decimal_qty boolean NOT NULL DEFAULT false,
  specs jsonb NOT NULL DEFAULT '{}',
  barcode text,
  image_url text,
  status text NOT NULL DEFAULT 'approved' CHECK (status IN ('pending','approved','rejected','merged')),
  merged_into uuid REFERENCES master_product(id),
  search_text text GENERATED ALWAYS AS (lower(name_en || ' ' || coalesce(name_si,'') || ' ' || coalesce(brand,'') || ' ' || coalesce(size,''))) STORED,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX master_product_trgm ON master_product USING gin (search_text gin_trgm_ops);
CREATE INDEX master_product_barcode ON master_product (barcode) WHERE barcode IS NOT NULL;

CREATE TABLE master_variant (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  master_product_id uuid NOT NULL REFERENCES master_product(id) ON DELETE CASCADE,
  label text NOT NULL,
  attrs jsonb NOT NULL DEFAULT '{}',
  barcode text,
  UNIQUE (master_product_id, label)
);

CREATE TABLE master_submission (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shop(id),
  submitted_by uuid,
  name text NOT NULL,
  base_unit text NOT NULL DEFAULT 'pcs',
  category text,
  brand text,
  size text,
  barcode text,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','merged')),
  master_product_id uuid REFERENCES master_product(id),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------- shop products ----------
CREATE TABLE product (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL REFERENCES shop(id),
  master_product_id uuid REFERENCES master_product(id),
  master_variant_id uuid REFERENCES master_variant(id),
  sku text NOT NULL,
  short_code text,
  name text NOT NULL,
  name_si text,
  alt_names text[] NOT NULL DEFAULT '{}',
  category text,
  brand text,
  size text,
  base_unit text NOT NULL,
  decimal_qty boolean NOT NULL DEFAULT false,
  track_batches boolean NOT NULL DEFAULT false,
  shelf_life_days int,
  min_level numeric(18,4) NOT NULL DEFAULT 0 CHECK (min_level >= 0),
  last_cost numeric(18,4),                       -- last known purchase cost per base unit (fallback for estimates)
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
  needs_review boolean NOT NULL DEFAULT false,
  favourite boolean NOT NULL DEFAULT false,
  version int NOT NULL DEFAULT 1,
  search_text text GENERATED ALWAYS AS (lower(name || ' ' || coalesce(name_si,'') || ' ' || coalesce(brand,'') || ' ' || coalesce(size,'') || ' ' || coalesce(category,''))) STORED,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  UNIQUE (shop_id, sku)
);
CREATE UNIQUE INDEX product_short_code ON product (shop_id, upper(short_code)) WHERE short_code IS NOT NULL;
CREATE UNIQUE INDEX product_master_once ON product (shop_id, master_product_id, coalesce(master_variant_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE master_product_id IS NOT NULL;
CREATE INDEX product_trgm ON product USING gin (search_text gin_trgm_ops);

CREATE TABLE product_unit (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit text NOT NULL,
  factor numeric(18,6) NOT NULL CHECK (factor > 0),   -- how many base units in one of this unit
  is_base boolean NOT NULL DEFAULT false,
  UNIQUE (shop_id, id),
  UNIQUE (product_id, unit),
  FOREIGN KEY (shop_id, product_id) REFERENCES product(shop_id, id)
);

CREATE TABLE product_barcode (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  code text NOT NULL,
  type text NOT NULL DEFAULT 'manufacturer' CHECK (type IN ('manufacturer','internal','supplier')),
  UNIQUE (shop_id, code),
  FOREIGN KEY (shop_id, product_id) REFERENCES product(shop_id, id),
  FOREIGN KEY (shop_id, unit_id) REFERENCES product_unit(shop_id, id)
);

CREATE TABLE product_price (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  tier text NOT NULL DEFAULT 'retail' CHECK (tier IN ('retail','wholesale','contractor')),
  price numeric(18,4) NOT NULL CHECK (price >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (product_id, unit_id, tier),
  FOREIGN KEY (shop_id, product_id) REFERENCES product(shop_id, id),
  FOREIGN KEY (shop_id, unit_id) REFERENCES product_unit(shop_id, id)
);

CREATE TABLE price_history (
  id bigserial PRIMARY KEY,
  shop_id uuid NOT NULL,
  product_id uuid NOT NULL,
  unit_id uuid NOT NULL,
  tier text NOT NULL,
  old_price numeric(18,4),
  new_price numeric(18,4) NOT NULL,
  changed_by uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX price_history_product ON price_history (shop_id, product_id, created_at DESC);

-- per-branch overrides for a product
CREATE TABLE branch_product (
  shop_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  min_level numeric(18,4) CHECK (min_level >= 0),
  available boolean NOT NULL DEFAULT true,
  PRIMARY KEY (branch_id, product_id),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branch(shop_id, id),
  FOREIGN KEY (shop_id, product_id) REFERENCES product(shop_id, id)
);

-- ---------- inventory ----------
CREATE TABLE stock_balance (
  shop_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  quantity numeric(18,4) NOT NULL DEFAULT 0 CHECK (quantity >= 0),   -- never negative
  damaged_qty numeric(18,4) NOT NULL DEFAULT 0 CHECK (damaged_qty >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, product_id),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branch(shop_id, id),
  FOREIGN KEY (shop_id, product_id) REFERENCES product(shop_id, id)
);

CREATE TABLE stock_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  batch_no text,
  mfg_date date,
  expiry_date date,
  qty_received numeric(18,4) NOT NULL,
  qty_remaining numeric(18,4) NOT NULL CHECK (qty_remaining >= 0),
  unit_cost numeric(18,4),
  supplier_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branch(shop_id, id),
  FOREIGN KEY (shop_id, product_id) REFERENCES product(shop_id, id)
);
CREATE INDEX stock_batch_expiry ON stock_batch (branch_id, product_id, expiry_date);

CREATE TABLE cost_layer (
  id bigserial PRIMARY KEY,
  shop_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  batch_id uuid,
  qty_in numeric(18,4) NOT NULL CHECK (qty_in > 0),
  qty_remaining numeric(18,4) NOT NULL CHECK (qty_remaining >= 0),
  unit_cost numeric(18,4) NOT NULL CHECK (unit_cost >= 0),
  estimated boolean NOT NULL DEFAULT false,         -- cost unknown at receipt (no purchase cost entered)
  source_type text NOT NULL,
  source_id text,
  supplier_id uuid,
  received_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branch(shop_id, id),
  FOREIGN KEY (shop_id, product_id) REFERENCES product(shop_id, id),
  FOREIGN KEY (shop_id, batch_id) REFERENCES stock_batch(shop_id, id)
);
CREATE INDEX cost_layer_open ON cost_layer (branch_id, product_id, received_at, id) WHERE qty_remaining > 0;

-- Immutable ledger. qty_base is signed: positive = stock in, negative = stock out.
CREATE TABLE stock_movement (
  id bigserial PRIMARY KEY,
  shop_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  batch_id uuid,
  type text NOT NULL CHECK (type IN ('opening','purchase','sale','sales_return','purchase_return','adjustment',
                                     'transfer_out','transfer_in','damaged','expired','stocktake')),
  qty_base numeric(18,4) NOT NULL CHECK (qty_base <> 0),
  unit text,
  qty_unit numeric(18,4),
  factor numeric(18,6),
  unit_cost numeric(18,4),
  ref_type text,
  ref_id text,
  reason text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branch(shop_id, id),
  FOREIGN KEY (shop_id, product_id) REFERENCES product(shop_id, id)
);
CREATE INDEX stock_movement_product ON stock_movement (branch_id, product_id, id);
CREATE INDEX stock_movement_time ON stock_movement (shop_id, created_at);

CREATE TABLE stock_adjustment (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'requested' CHECK (status IN ('requested','posted','rejected')),
  reason text NOT NULL,
  requested_by uuid NOT NULL,
  decided_by uuid,
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branch(shop_id, id)
);
CREATE TABLE stock_adjustment_line (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  adjustment_id uuid NOT NULL,
  product_id uuid NOT NULL,
  kind text NOT NULL DEFAULT 'adjustment' CHECK (kind IN ('adjustment','damaged','expired')),
  qty_delta numeric(18,4) NOT NULL CHECK (qty_delta <> 0),
  unit_cost numeric(18,4),
  FOREIGN KEY (shop_id, adjustment_id) REFERENCES stock_adjustment(shop_id, id),
  FOREIGN KEY (shop_id, product_id) REFERENCES product(shop_id, id)
);

CREATE TABLE stocktake (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  scope text NOT NULL DEFAULT 'all',
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open','posted','cancelled')),
  snapshot_movement_id bigint NOT NULL DEFAULT 0,
  created_by uuid NOT NULL,
  approved_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  posted_at timestamptz,
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branch(shop_id, id)
);
CREATE TABLE stocktake_line (
  stocktake_id uuid NOT NULL,
  shop_id uuid NOT NULL,
  product_id uuid NOT NULL,
  system_qty numeric(18,4) NOT NULL,       -- balance when the count opened
  counted_qty numeric(18,4),
  PRIMARY KEY (stocktake_id, product_id),
  FOREIGN KEY (shop_id, stocktake_id) REFERENCES stocktake(shop_id, id),
  FOREIGN KEY (shop_id, product_id) REFERENCES product(shop_id, id)
);

CREATE TABLE stock_discrepancy (
  id bigserial PRIMARY KEY,
  shop_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  balance numeric(18,4) NOT NULL,
  ledger_sum numeric(18,4) NOT NULL,
  detected_at timestamptz NOT NULL DEFAULT now(),
  resolved_at timestamptz
);

-- low-stock alert de-duplication: one alert per threshold crossing
CREATE TABLE low_stock_alert_state (
  shop_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  product_id uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('ok','low','out')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (branch_id, product_id)
);

-- in-app notifications (one row per recipient)
CREATE TABLE notification (
  id bigserial PRIMARY KEY,
  shop_id uuid NOT NULL,
  user_id uuid NOT NULL,
  branch_id uuid,
  type text NOT NULL,
  title text NOT NULL,
  body text,
  payload jsonb NOT NULL DEFAULT '{}',
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notification_user ON notification (user_id, read_at, id DESC);

-- ---------- bulk import ----------
CREATE TABLE import_batch (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  branch_id uuid,
  kind text NOT NULL DEFAULT 'products',
  status text NOT NULL DEFAULT 'staged' CHECK (status IN ('staged','validated','processing','done','failed','undone')),
  total_rows int NOT NULL DEFAULT 0,
  processed_rows int NOT NULL DEFAULT 0,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id)
);
CREATE TABLE import_row (
  id bigserial PRIMARY KEY,
  shop_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  row_no int NOT NULL,
  raw jsonb NOT NULL,
  row_hash text NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','ok','error','review','skipped','imported')),
  errors jsonb NOT NULL DEFAULT '[]',
  match jsonb,
  decision text CHECK (decision IN ('create','use_existing','skip')),
  product_id uuid,
  opening_qty numeric(18,4),
  FOREIGN KEY (shop_id, batch_id) REFERENCES import_batch(shop_id, id),
  UNIQUE (batch_id, row_hash)
);

-- ---------- RLS ----------
DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['shop_counter','master_submission','product','product_unit','product_barcode','product_price','price_history',
    'branch_product','stock_balance','stock_batch','cost_layer','stock_movement','stock_adjustment','stock_adjustment_line',
    'stocktake','stocktake_line','stock_discrepancy','low_stock_alert_state','notification','import_batch','import_row']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_or_platform ON %I USING (shop_id = app_shop() OR app_is_platform()) WITH CHECK (shop_id = app_shop() OR app_is_platform())', t);
  END LOOP;
  -- master catalog: everyone reads, only the platform writes
  FOREACH t IN ARRAY ARRAY['master_category','master_product','master_variant']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY read_all ON %I FOR SELECT USING (true)', t);
    EXECUTE format('CREATE POLICY platform_write ON %I FOR ALL USING (app_is_platform()) WITH CHECK (app_is_platform())', t);
  END LOOP;
END $$;
