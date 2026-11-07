const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
async function setupOutsourcing() {
 const db=new PGlite()
  await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth; CREATE SCHEMA storage; GRANT USAGE ON SCHEMA auth TO authenticated;
   CREATE TABLE auth.users(id uuid PRIMARY KEY); CREATE TABLE profiles(id uuid,first_name text,last_name text);
   CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$ SELECT nullif(current_setting('test.user',true),'')::uuid $$;
   CREATE FUNCTION is_active_tms_user() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT auth.uid() IS NOT NULL$$;
   CREATE FUNCTION can_access_site(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT coalesce(current_setting('test.site',true),'yes')<>'no'$$;
   CREATE FUNCTION has_tms_permission(p text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.permission',true) IN ('admin',p)$$;
   CREATE FUNCTION has_tms_read_permission(p text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT current_setting('test.permission',true) IN ('reader','admin',p)$$;
   CREATE TABLE clients(id uuid PRIMARY KEY,business_name text); CREATE TABLE contracts(id uuid PRIMARY KEY,code text,client_id uuid); CREATE TABLE transport_requests(id uuid PRIMARY KEY,site_id uuid,contract_id uuid,request_number text);
   CREATE TABLE suppliers(id uuid PRIMARY KEY,is_active boolean,category text,business_name text);
   CREATE TABLE carriers(id uuid PRIMARY KEY,supplier_id uuid);
   CREATE TABLE dispatches(id uuid PRIMARY KEY,site_id uuid,status text,carrier_id uuid,freight_cost numeric,dispatch_number text);
   CREATE TABLE dispatch_requests(dispatch_id uuid,transport_request_id uuid);
   CREATE TABLE dispatch_request_freight(dispatch_id uuid,request_id uuid,status text,amount_pen numeric);
   CREATE TABLE transport_unloading_costs(dispatch_id uuid,transport_request_id uuid,supplier_id uuid,concept text,status text,planned_pen numeric);
   CREATE FUNCTION economic_closure_status(uuid) RETURNS text LANGUAGE sql STABLE AS $$SELECT current_setting('test.closure',true)$$;
   CREATE TABLE storage.buckets(id text PRIMARY KEY,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);
   CREATE TABLE storage.objects(bucket_id text,name text); ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
   INSERT INTO auth.users VALUES('${id(1)}'); INSERT INTO profiles VALUES('${id(1)}','Responsable','prueba');
   INSERT INTO clients VALUES('${id(10)}','Cliente QA'); INSERT INTO contracts VALUES('${id(9)}','OT-QA','${id(10)}');
   INSERT INTO transport_requests VALUES('${id(2)}','${id(3)}','${id(9)}','RT-1');
   INSERT INTO suppliers VALUES('${id(4)}',true,'TRANSPORTE','Transportista'),('${id(8)}',true,'GRUA','Gruista');
   INSERT INTO carriers VALUES('${id(5)}','${id(4)}');
   INSERT INTO dispatches VALUES('${id(6)}','${id(3)}','PROGRAMADO','${id(5)}',500,'D-1');
   INSERT INTO dispatch_requests VALUES('${id(6)}','${id(2)}');
   SELECT set_config('test.user','${id(1)}',false),set_config('test.permission','admin',false);`)
  await db.exec(readFileSync('supabase/migrations/20261227090000_transport_outsourcing.sql','utf8'))

return db
}
module.exports={setupOutsourcing,id}
