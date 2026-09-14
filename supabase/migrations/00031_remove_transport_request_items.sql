-- Drop the transport_request_items table
DROP TABLE IF EXISTS transport_request_items CASCADE;

-- Drop the products table if it's no longer used anywhere else
DROP TABLE IF EXISTS products CASCADE;
