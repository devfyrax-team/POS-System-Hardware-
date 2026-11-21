-- Phase 5: batch and expiry tracking. One alert per batch per warning band.
CREATE TABLE expiry_alert_state (
  shop_id uuid NOT NULL,
  batch_id uuid NOT NULL,
  band int NOT NULL,                 -- the warning window (days) last alerted; 0 = expired
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (batch_id),
  FOREIGN KEY (shop_id, batch_id) REFERENCES stock_batch(shop_id, id)
);
ALTER TABLE expiry_alert_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE expiry_alert_state FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_or_platform ON expiry_alert_state USING (shop_id = app_shop() OR app_is_platform()) WITH CHECK (shop_id = app_shop() OR app_is_platform());

-- Faster allocation: batches with stock, earliest expiry first
CREATE INDEX stock_batch_open ON stock_batch (branch_id, product_id, expiry_date NULLS LAST, created_at) WHERE qty_remaining > 0;
