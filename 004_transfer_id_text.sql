-- Listing IDs from transferSystem are string tokens (lst_...), not UUIDs.
BEGIN;

ALTER TABLE transfer_bids DROP CONSTRAINT IF EXISTS transfer_bids_listing_id_fkey;
ALTER TABLE transfer_listings ALTER COLUMN id TYPE TEXT USING id::text;
ALTER TABLE transfer_bids ALTER COLUMN listing_id TYPE TEXT USING listing_id::text;
ALTER TABLE transfer_bids
  ADD CONSTRAINT transfer_bids_listing_id_fkey
  FOREIGN KEY (listing_id) REFERENCES transfer_listings(id) ON DELETE CASCADE;

COMMIT;
