-- Compatibility marker for databases that already applied the historical
-- 000172_site_scopes migration. The implementation now runs as 00056, after
-- contracts, inventory, and maintenance schemas are present.
SELECT 1;
