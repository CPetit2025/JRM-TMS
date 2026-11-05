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
const checks = [
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
]
const failures = checks.filter(([, ok]) => !ok)
if (failures.length) {
  for (const [name] of failures) process.stderr.write(`FALLÓ: ${name}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`WMS acceptance guards OK (${checks.length})\n`)
}
