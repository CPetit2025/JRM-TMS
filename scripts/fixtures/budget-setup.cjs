// Esquema "tipo producción" mínimo de la partida de transporte para las pruebas del control presupuestal (PGlite):
// saldo real por familia (transport_budget_balance / transport_family_refresh de 20261010060000), solicitudes, rutas,
// reparto del flete por OT, gastos de Caja, unidades y configuración.
const { PGlite } = require('@electric-sql/pglite')
const { readFileSync } = require('node:fs')
const assert = require('node:assert/strict')
const read = p => readFileSync(p, 'utf8')
const id = n => `00000000-0000-4000-8000-${String(n).padStart(12,'0')}`
const fn = (file, name, end = 'END $$;') => { const s = read(file), a = s.indexOf(`CREATE OR REPLACE FUNCTION public.${name}(`); assert(a >= 0, name); return s.slice(a, s.indexOf(end, s.indexOf('AS $$', a) + 5) + end.length) }
async function setupBudget() {
 const db = new PGlite()
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE SCHEMA auth;
  CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT NULL::uuid$$;
  CREATE FUNCTION is_active_tms_user() RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
  CREATE FUNCTION has_tms_read_permission(text) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
  CREATE FUNCTION can_access_site(uuid) RETURNS boolean LANGUAGE sql STABLE AS $$SELECT true$$;
  CREATE TABLE contracts(id uuid PRIMARY KEY, code text, parent_contract_id uuid);
  CREATE FUNCTION contract_root_id(p uuid) RETURNS uuid LANGUAGE sql STABLE AS $$
   WITH RECURSIVE up(id, parent) AS (SELECT id, parent_contract_id FROM contracts WHERE id = p UNION SELECT c.id, c.parent_contract_id FROM contracts c JOIN up ON c.id = up.parent)
   SELECT id FROM up WHERE parent IS NULL$$;
  CREATE FUNCTION transport_operating_budget(p numeric) RETURNS numeric LANGUAGE sql IMMUTABLE AS $$SELECT COALESCE(p,0) - round(COALESCE(p,0) * 0.2, 2)$$;
  CREATE TABLE contract_budgets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), contract_id uuid, concept text, allocated_pen numeric DEFAULT 0, own_allocated_pen numeric DEFAULT 0,
   reserved_pen numeric DEFAULT 0, consumed_pen numeric DEFAULT 0, balance_pen numeric, updated_at timestamptz);
  CREATE TABLE transport_requests(id uuid PRIMARY KEY, request_number text, contract_id uuid, estimated_weight numeric);
  CREATE TABLE dispatches(id uuid PRIMARY KEY, status text, contract_id uuid, freight_cost numeric DEFAULT 0, vehicle_plate text, modalidad text DEFAULT 'PROPIA',
   carrier_id uuid, scheduled_departure timestamptz, actual_distance_km numeric NOT NULL DEFAULT 0, estimated_km numeric, estimated_distance_km numeric DEFAULT 0, site_id uuid);
  CREATE TABLE dispatch_requests(dispatch_id uuid, transport_request_id uuid);
  CREATE TABLE dispatch_request_freight(dispatch_id uuid, request_id uuid, contract_id uuid, amount_pen numeric, status text DEFAULT 'RESERVADO');
  CREATE TABLE dispatch_expenses(id uuid PRIMARY KEY, dispatch_id uuid, transport_request_id uuid, expense_type varchar, amount numeric DEFAULT 0,
   approved_amount numeric, status text DEFAULT 'PENDIENTE', is_billable boolean DEFAULT false);
  CREATE TABLE vehicles(id uuid PRIMARY KEY DEFAULT gen_random_uuid(), plate varchar, expected_km_per_gallon numeric);
  CREATE TABLE caja_settings(id boolean PRIMARY KEY DEFAULT true, default_km_per_gallon numeric DEFAULT 10, fuel_price_per_gallon numeric DEFAULT 16);
  INSERT INTO caja_settings DEFAULT VALUES;
  CREATE TABLE economic_settings(id boolean PRIMARY KEY DEFAULT true CHECK (id), deviation_pct numeric DEFAULT 10, deviation_pen numeric DEFAULT 100,
   max_pending_days int DEFAULT 7, budget_alert_pct numeric DEFAULT 70, budget_cap_pct numeric DEFAULT 80);
  INSERT INTO economic_settings DEFAULT VALUES;`)
 // Saldo de la partida real (familia, tope operativo) y su dueño
 const fam = 'supabase/migrations/20261010060000_transport_family_budget.sql'
 await db.exec(fn(fam, 'transport_family_totals', '$$;'))
 await db.exec(fn(fam, 'transport_budget_balance'))
 await db.exec(fn(fam, 'contract_budget_owner', '$$;'))
 await db.exec(fn(fam, 'transport_family_refresh'))
 await db.exec(`CREATE TRIGGER transport_budget_balance BEFORE INSERT OR UPDATE ON contract_budgets FOR EACH ROW EXECUTE FUNCTION transport_budget_balance();
  CREATE TRIGGER transport_family_refresh AFTER INSERT OR UPDATE OR DELETE ON contract_budgets FOR EACH ROW EXECUTE FUNCTION transport_family_refresh();
  INSERT INTO contracts VALUES ('${id(10)}','OT-A',NULL),('${id(20)}','OT-B',NULL),('${id(30)}','OT-C',NULL),('${id(31)}','OT-C-S1','${id(30)}');
  INSERT INTO contract_budgets(contract_id,concept,allocated_pen) VALUES ('${id(10)}','PARTIDA_TRANSPORTE',1000),('${id(20)}','PARTIDA_TRANSPORTE',1000),('${id(30)}','PARTIDA_TRANSPORTE',1000);
  INSERT INTO vehicles(plate,expected_km_per_gallon) VALUES ('PRO-1',20);`)

 return db
}
module.exports = { setupBudget, read, id, fn }
