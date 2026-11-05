// Acceptance guards for the APT-to-WMS data path. These keep the high-risk source links
// and dispatch controls visible during review; database behavior is validated separately
// by applying the migration in the target Supabase environment before release.
const { readFileSync } = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const sql = readFileSync(path.join(root, 'supabase/migrations/20261225103000_warehouse_wms_core.sql'), 'utf8')
const labeling = readFileSync(path.join(root, 'src/app/almacen/etiquetado/page.tsx'), 'utf8')
const reconciliation = readFileSync(path.join(root, 'src/app/almacen/conciliacion/page.tsx'), 'utf8')
const apt = readFileSync(path.join(root, 'src/app/almacen/apt/datos/page.tsx'), 'utf8')
const task = readFileSync(path.join(root, 'src/app/almacen/tareas/[id]/page.tsx'), 'utf8')
const uuidBootstrap = readFileSync(path.join(root, 'supabase/migrations/00000_supabase_uuid_compat.sql'), 'utf8')
const legacyCarrierAcl = readFileSync(path.join(root, 'supabase/migrations/000162_secure_tracking.sql'), 'utf8')
const checks = [
  ['fresh Supabase staging exposes the UUID function required by legacy baseline migrations', /CREATE OR REPLACE FUNCTION public\.uuid_generate_v4\(\)[\s\S]*?SELECT gen_random_uuid\(\)/.test(uuidBootstrap)],
  ['fresh TMS schema applies legacy cleanup only when its optional columns and RPCs exist', /CREATE POLICY carriers_public_names[\s\S]*?USING \(status = 'ACTIVE'\)/.test(legacyCarrierAcl) && /information_schema\.columns[\s\S]*?column_name = 'mock_password'[\s\S]*?UPDATE public\.profiles SET mock_password/.test(legacyCarrierAcl) && /column_name = 'pin'[\s\S]*?UPDATE public\.drivers SET pin/.test(legacyCarrierAcl) && /to_regprocedure\('public\.register_driver/.test(legacyCarrierAcl)],
  ['receipts use active ERP APT ingress', /inv_movements m WHERE m\.active AND m\.side='E' AND public\.apt_almacen\(m\.bodega\) IS NOT NULL/.test(sql)],
  ['outbound reconciliation uses active ERP APT egress', /inv_movements m WHERE m\.active AND m\.side='S' AND public\.apt_almacen\(m\.bodega\) IS NOT NULL/.test(sql)],
  ['labels cannot be issued from manually typed source data', /wh_label_package\(p_receipt_key text,p_package_count integer/.test(sql) && !/p_source\s*:/.test(labeling)],
  ['label RPC verifies the current active APT receipt', /IF NOT FOUND OR v_receipt\.quantity<=0 THEN RAISE EXCEPTION 'El ingreso APT no existe o ya no está activo/.test(sql)],
  ['packages preserve ERP and physical dispatch lineage', /source_warehouse text NOT NULL/.test(sql) && /source_contract_code text/.test(sql) && /dispatch_id uuid REFERENCES public\.dispatches/.test(sql)],
  ['ERP outbound reconciliation can be run from the active actualizable', /wh_reconcile_apt_outflows/.test(apt) && /wh_reconcile_apt_outflows/.test(reconciliation)],
  ['outbound comparison scopes loaded quantities to the same dispatch', /p\.dispatch_id=d\.id AND p\.status='LOADED'/.test(sql)],
  ['dispatch departure is blocked until WMS load or approved exception', /CREATE TRIGGER wh_dispatch_load_guard BEFORE UPDATE OF status ON public\.dispatches/.test(sql) && /load_override_reason/.test(sql)],
  ['duplicate scan retries are idempotent and conflicting IDs are rejected', /duplicate_retry/.test(sql) && /ya se usó para otra operación/.test(sql)],
  ['scan history is immutable', /CREATE TRIGGER wh_scan_immutable BEFORE UPDATE OR DELETE ON public\.wh_scan_events/.test(sql)],
  ['APT upload automatically refreshes outbound reconciliation', /Conciliación WMS actualizada/.test(apt)],
  ['partial delivery retains an outstanding balance and requires a supervisor', /LOAD_PARTIAL/.test(sql) && /remaining_qty/.test(task) && /Autorizar carga parcial/.test(task)],
  ['RECOJO and TRASLADO do not create warehouse pick tasks', /upper\(coalesce\(NEW\.request_type,'DESPACHO'\)\) IN \('RECOJO','TRASLADO'\) THEN RETURN NEW/.test(sql) && /upper\(coalesce\(r\.request_type,'DESPACHO'\)\) NOT IN \('RECOJO','TRASLADO'\)/.test(sql)],
  ['legacy RECOJO and TRASLADO tasks cannot block dispatch departure', /JOIN public\.transport_requests r ON r\.id=t\.transport_request_id[\s\S]{0,180}upper\(coalesce\(r\.request_type,'DESPACHO'\)\) NOT IN \('RECOJO','TRASLADO'\)/.test(sql)],
  ['LPN scan increments only quantities transitioned from PACKED to LOADED', /WITH moved AS \([\s\S]*?UPDATE public\.wh_packages SET status='LOADED'[\s\S]*?RETURNING task_line_id,quantity[\s\S]*?SELECT task_line_id,sum\(quantity\) AS qty FROM moved/.test(sql)],
  ['LPN scan retry recognizes its persisted LOAD_LPN event', /event_type IN \(upper\(p_event\),CASE WHEN upper\(p_event\)='LOAD' THEN 'LOAD_LPN'/.test(sql)],
  ['voiding picked or packed packages reverses task-line counters', /picked_qty=greatest\(0,picked_qty-CASE WHEN p\.status IN \('PICKED','PACKED'\)/.test(sql) && /packed_qty=greatest\(0,packed_qty-CASE WHEN p\.status='PACKED'/.test(sql)],
  ['loading operators can read package rows needed by load screens', /CREATE POLICY wh_packages_read[\s\S]*?almacen-carga/.test(sql)],
  ['APT actualizable export header variants are normalized for IPT receipt lookup', /tipodocumento: 'TIPODOCTO',[\s\S]*?nrodocumento: 'Numero'[\s\S]*?codproducto: 'Producto', producto: 'GLOSA'/.test(readFileSync(path.join(root,'src/lib/inventario/parse.ts'),'utf8'))],
  ['physical receipt quantity and variances are captured before labels', /CREATE TABLE public\.wh_receipt_validations/.test(sql) && /CREATE OR REPLACE FUNCTION public\.wh_validate_receipt\(p_receipt_key text,p_physical_quantity numeric/.test(sql) && /physical_quantity<>v_receipt\.quantity AND v_reason IS NULL/.test(sql)],
  ['label generation requires current physical validation and distributes the confirmed amount', /v_total:=v_validation\.physical_quantity/.test(sql) && /IF NOT FOUND THEN RAISE EXCEPTION 'Confirme la cantidad física del ingreso antes de generar etiquetas'/.test(sql) && /v_validation\.erp_quantity<>v_receipt\.quantity THEN RAISE EXCEPTION 'El IPT cambió/.test(sql)],
  ['client fallback can be entered and is retained in the immutable receipt audit', /manual_customer_name text/.test(sql) && /v_customer IS NULL AND v_manual IS NULL THEN RAISE EXCEPTION/.test(sql)],
  ['missing ERP weight stays unknown instead of becoming a fabricated zero', /round\(sum\(abs\(m\.peso_kg\)\),3\) AS weight_kg/.test(sql) && /CASE WHEN v_weight IS NOT NULL AND v_receipt\.quantity>0 THEN round\(v_weight\*v_qty\/v_receipt\.quantity,3\) END/.test(sql)],
]
const failures = checks.filter(([, ok]) => !ok)
if (failures.length) {
  for (const [name] of failures) process.stderr.write(`FALLÓ: ${name}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`WMS acceptance guards OK (${checks.length})\n`)
}
