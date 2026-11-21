-- Phase 6: paint - colour tinting (mix transactions) and saved formulas.

ALTER TABLE stock_movement DROP CONSTRAINT stock_movement_type_check;
ALTER TABLE stock_movement ADD CONSTRAINT stock_movement_type_check CHECK (type IN (
  'opening','purchase','sale','sales_return','purchase_return','adjustment','transfer_out','transfer_in','damaged','expired','stocktake','tint_in','tint_out'));

CREATE TABLE tint_formula (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  customer_id uuid,
  colour_code text NOT NULL,
  colour_name text,
  base_product_id uuid NOT NULL,
  colorants jsonb NOT NULL,            -- [{ productId, mlPerUnit }]  ml of colorant per 1 unit (litre) of base
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (shop_id, id),
  FOREIGN KEY (shop_id, customer_id) REFERENCES customer(shop_id, id),
  FOREIGN KEY (shop_id, base_product_id) REFERENCES product(shop_id, id)
);
CREATE UNIQUE INDEX tint_formula_unique ON tint_formula (shop_id, coalesce(customer_id, '00000000-0000-0000-0000-000000000000'::uuid), upper(colour_code), base_product_id);

CREATE TABLE tint_job (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id uuid NOT NULL,
  branch_id uuid NOT NULL,
  customer_id uuid,
  formula_id uuid,
  base_product_id uuid NOT NULL,
  tinted_product_id uuid NOT NULL,
  colour_code text NOT NULL,
  base_qty numeric(18,4) NOT NULL CHECK (base_qty > 0),
  colorants jsonb NOT NULL,            -- [{ productId, ml, cost }] actually consumed
  total_cost numeric(18,4) NOT NULL,
  created_by uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (shop_id, branch_id) REFERENCES branch(shop_id, id)
);
CREATE INDEX tint_job_customer ON tint_job (shop_id, customer_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['tint_formula','tint_job']
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('CREATE POLICY tenant_or_platform ON %I USING (shop_id = app_shop() OR app_is_platform()) WITH CHECK (shop_id = app_shop() OR app_is_platform())', t);
  END LOOP;
END $$;
