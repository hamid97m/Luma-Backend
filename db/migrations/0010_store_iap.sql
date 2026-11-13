-- Bazaar / Myket in-app purchases: per-store SKU and Toman price on plans,
-- and the store purchase token on transactions (one grant per token per provider).

ALTER TABLE premium_plans ADD COLUMN bazaar_sku text;
ALTER TABLE premium_plans ADD COLUMN myket_sku  text;
ALTER TABLE premium_plans ADD COLUMN bazaar_price_toman integer CHECK (bazaar_price_toman > 0);
ALTER TABLE premium_plans ADD COLUMN myket_price_toman  integer CHECK (myket_price_toman  > 0);
CREATE UNIQUE INDEX premium_plans_bazaar_sku_key ON premium_plans (bazaar_sku) WHERE bazaar_sku IS NOT NULL;
CREATE UNIQUE INDEX premium_plans_myket_sku_key  ON premium_plans (myket_sku)  WHERE myket_sku  IS NOT NULL;

ALTER TABLE premium_transactions DROP CONSTRAINT premium_transactions_provider_check;
ALTER TABLE premium_transactions ADD CONSTRAINT premium_transactions_provider_check
  CHECK (provider IN ('stars','tonpays','bazaar','myket'));
ALTER TABLE premium_transactions ADD COLUMN store_sku text;
ALTER TABLE premium_transactions ADD COLUMN store_purchase_token text;
CREATE UNIQUE INDEX premium_transactions_store_token_key
  ON premium_transactions (provider, store_purchase_token) WHERE store_purchase_token IS NOT NULL;
