const fs = require("node:fs");
const { setupOutsourcing, id } = require("./outsourcing-setup.cjs");
async function setupResources() {
  const db = await setupOutsourcing();
  await db.exec(`CREATE ROLE service_role; CREATE TABLE transport_request_items(transport_request_id uuid,weight numeric,volume_m3 numeric,quantity numeric);
 ALTER TABLE transport_requests ADD COLUMN status text DEFAULT 'APROBADA';
 CREATE TABLE notif_reglas(evento text PRIMARY KEY,categoria text,descripcion text,severidad text,permisos text[],al_solicitante boolean);
 CREATE FUNCTION notif_emit(a text,b text,c text,d text,e text,f uuid) RETURNS bigint LANGUAGE sql AS $$SELECT 1::bigint$$;
 CREATE TABLE supplier_vehicles(id uuid,supplier_id uuid,is_active boolean,plate text);
 CREATE TABLE supplier_personnel(id uuid,supplier_id uuid,is_active boolean);
 CREATE TABLE vehicles(plate text,carrier_id uuid);
 ALTER TABLE dispatches ADD COLUMN vehicle_plate text;
 ALTER TABLE dispatches ADD COLUMN tercero_doc text;`);
  await db.exec(
    fs.readFileSync(
      "supabase/migrations/20261228090000_outsourcing_wizard_v2.sql",
      "utf8",
    ),
  );
  await db.exec(
    fs.readFileSync(
      "supabase/migrations/20261228090001_outsourcing_assignments.sql",
      "utf8",
    ),
  );

  return db;
}
module.exports = { setupResources, id };
