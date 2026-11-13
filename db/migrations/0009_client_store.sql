-- App store an Android build was distributed through (X-Client-Store header).
-- NULL for Telegram / web devices and for Android builds that don't send it.

ALTER TABLE user_devices ADD COLUMN store text CHECK (store IN ('bazaar','myket'));
