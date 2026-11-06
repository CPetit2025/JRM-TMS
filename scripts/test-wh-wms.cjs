// Acceptance guards for the APT-to-WMS data path. These keep the high-risk source links
// and dispatch controls visible during review; database behavior is validated separately
// by applying the migration in the target Supabase environment before release.
const { readFileSync } = require('node:fs')
const path = require('node:path')
const root = path.resolve(__dirname, '..')
const sql = readFileSync(path.join(root, 'supabase/migrations/20261225103000_warehouse_wms_core.sql'), 'utf8')
const receiptSource = readFileSync(path.join(root, 'supabase/migrations/20261225104000_wms_receipt_source_import.sql'), 'utf8')
const receiptInbox = readFileSync(path.join(root, 'supabase/migrations/20261225105000_wms_receipt_inbox_refresh_customer_lookup.sql'), 'utf8')
const receiptCustomerZ = readFileSync(path.join(root, 'supabase/migrations/20261225105500_wms_receipt_customer_column_z.sql'), 'utf8')
const receiptImport = readFileSync(path.join(root, 'src/app/almacen/apt/etiquetado/page.tsx'), 'utf8')
const receiptRobot = readFileSync(path.join(root, 'scripts/wms-auto/cargar-entrada.mjs'), 'utf8')
const labeling = readFileSync(path.join(root, 'src/app/almacen/etiquetado/page.tsx'), 'utf8')
const reconciliation = readFileSync(path.join(root, 'src/app/almacen/conciliacion/page.tsx'), 'utf8')
const apt = readFileSync(path.join(root, 'src/app/almacen/apt/datos/page.tsx'), 'utf8')
const layout = readFileSync(path.join(root, 'src/app/almacen/layout.tsx'), 'utf8')
const task = readFileSync(path.join(root, 'src/app/almacen/tareas/[id]/page.tsx'), 'utf8')
const uuidBootstrap = readFileSync(path.join(root, 'supabase/migrations/00000_supabase_uuid_compat.sql'), 'utf8')
const legacyCarrierAcl = readFileSync(path.join(root, 'supabase/migrations/000162_secure_tracking.sql'), 'utf8')
const legacyDriverRpcAcl = readFileSync(path.join(root, 'supabase/migrations/00055_secure_register_driver.sql'), 'utf8')
const checks = [
  ['fresh Supabase staging exposes the UUID function required by legacy baseline migrations', /CREATE OR REPLACE FUNCTION public\.uuid_generate_v4\(\)[\s\S]*?SELECT gen_random_uuid\(\)/.test(uuidBootstrap)],
  ['fresh TMS schema applies legacy cleanup only when its optional columns and RPCs exist', /CREATE POLICY carriers_public_names[\s\S]*?USING \(status = 'ACTIVE'\)/.test(legacyCarrierAcl) && /information_schema\.columns[\s\S]*?column_name = 'mock_password'[\s\S]*?UPDATE public\.profiles SET mock_password/.test(legacyCarrierAcl) && /column_name = 'pin'[\s\S]*?UPDATE public\.drivers SET pin/.test(legacyCarrierAcl) && /to_regprocedure\('public\.register_driver/.test(legacyCarrierAcl) && /table_name = 'dispatches' AND column_name = 'driver_name'[\s\S]*?UPDATE public\.dispatches d SET driver_id/.test(legacyCarrierAcl) && /ALTER TABLE public\.drivers ADD COLUMN IF NOT EXISTS is_active/.test(legacyCarrierAcl)],
  ['later legacy driver RPC grants cannot reopen anonymous registration', /REVOKE ALL ON FUNCTION public\.register_driver\(uuid,text,text,text,text,text,text,uuid\)[\s\S]*?FROM PUBLIC, anon, authenticated/.test(legacyDriverRpcAcl)],
  ['WMS menu orders the dedicated receipt-source import before IPT labeling', layout.indexOf("label: '01 · Actualizar ingresos WMS'") >= 0 && layout.indexOf("label: '02 · Recepción por IPT'") > layout.indexOf("label: '01 · Actualizar ingresos WMS'") && layout.includes("/almacen/apt/etiquetado")],
  ['IPT selection opens an accessible dialog sized for phone and tablet with Escape dismissal', /role="dialog" aria-modal="true"/.test(labeling) && /max-h-\[100dvh\][\s\S]*?sm:max-h-\[92dvh\]/.test(labeling) && /event.key === 'Escape'[\s\S]*?document.body.style.overflow = 'hidden'/.test(labeling)],
  ['receipts use active ERP APT ingress', /inv_movements m WHERE m\.active AND m\.side='E' AND public\.apt_almacen\(m\.bodega\) IS NOT NULL/.test(sql)],
  ['outbound reconciliation uses active ERP APT egress', /inv_movements m WHERE m\.active AND m\.side='S' AND public\.apt_almacen\(m\.bodega\) IS NOT NULL/.test(sql)],
  ['labels cannot be issued from manually typed source data', /wh_label_package\(p_receipt_key text,p_package_count integer/.test(sql) && !/p_source\s*:/.test(labeling)],
  ['label RPC verifies the current active APT receipt', /IF NOT FOUND OR v_receipt\.quantity<=0 THEN RAISE EXCEPTION 'El ingreso APT no existe o ya no está activo/.test(sql)],
  ['packages preserve ERP and physical dispatch lineage', /source_warehouse text NOT NULL/.test(sql) && /source_contract_code text/.test(sql) && /dispatch_id uuid REFERENCES public\.dispatches/.test(sql)],
  ['ERP outbound reconciliation can be run from the active actualizable', /wh_reconcile_apt_outflows/.test(reconciliation)],
  ['outbound comparison scopes loaded quantities to the same dispatch', /p\.dispatch_id=d\.id AND p\.status='LOADED'/.test(sql)],
  ['dispatch departure is blocked until WMS load or approved exception', /CREATE TRIGGER wh_dispatch_load_guard BEFORE UPDATE OF status ON public\.dispatches/.test(sql) && /load_override_reason/.test(sql)],
  ['duplicate scan retries are idempotent and conflicting IDs are rejected', /duplicate_retry/.test(sql) && /ya se usó para otra operación/.test(sql)],
  ['scan history is immutable', /CREATE TRIGGER wh_scan_immutable BEFORE UPDATE OR DELETE ON public\.wh_scan_events/.test(sql)],
  ['WMS receipt import uses its own source and does not write TMS inventory movements', receiptSource.includes('CREATE TABLE public.wh_receipt_sources') && receiptSource.includes('FROM public.wh_receipt_sources s WHERE s.active') && !receiptSource.includes('INSERT INTO public.inv_movements')],
  ['WMS importer maps IPT, warehouse, date and product from Entrada ALM PT', /entradaalmpt/.test(receiptImport) && /nrodocumento/.test(receiptImport) && /bodega/.test(receiptImport) && /codproducto/.test(receiptImport)],
  ['WMS importer offers manual file selection and a manual refresh action', receiptImport.includes('Actualizar manualmente') && receiptImport.includes('Seleccionar Excel') && receiptImport.includes('el navegador no puede leer')],
  ['receipt inbox defaults to all unprinted or not-yet-labeled entries and refreshes every 30 seconds', /coalesce\(p\.label_count,0\)=0 OR coalesce\(p\.unprinted_count,0\)>0/.test(receiptInbox) && /setInterval[\s\S]*?30000/.test(labeling) && labeling.includes('Actualizar bandeja')],
  ['receipt customer lookup checks the lot OT against inventory and contracts', /inv_ot_cliente\(nullif\(public\.apt_ot_raiz\(r\.lote\),''\)\)/.test(receiptInbox) && /inv_ot_cliente\(nullif\(public\.inv_ot\(r\.contract_code\),''\)\)/.test(receiptInbox)],
  ['unprinted generated LPNs can be resumed and previewed without generating duplicate codes', /PENDING_PRINT/.test(receiptInbox) && labeling.includes('pending_labels') && labeling.includes('Vista previa') && labeling.includes('no se generarán códigos duplicados')],
  ['physical receipt defaults to full packages plus a remainder and derives its balance automatically', labeling.includes("useState<'TOTAL' | 'PACKAGES'>('PACKAGES')") && labeling.includes('Paquetes completos + saldo') && labeling.includes('packageBalance = Number((physicalToValidate - Number(capacity) * Number(completePackages))') && labeling.includes('Unidades en el saldo · automático') && labeling.includes('packageBreakdownValid')],
  ['Windows robot targets only WMS receipt import and is preview-locked', /git-feature-warehouse-wms-portal/.test(receiptRobot) && receiptRobot.includes('/almacen/apt/etiquetado') && !receiptRobot.toLowerCase().includes('salida.xlsx')],
  ['legacy inventory APT upload route cannot overwrite receipt source', apt.includes("redirect('/almacen/apt/etiquetado')") || apt.includes('redirect("/almacen/apt/etiquetado")')],
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
checks.push(
  ['WMS import reads absolute Excel column Z and known customer header aliases', receiptImport.includes('const columnZIndex = 25 - sourceRange.s.c') && receiptImport.includes('text(row[columnZIndex])') && receiptImport.includes("get(row,'cliente')") && receiptImport.includes("get(row,'razonsocial')") && receiptImport.includes('customer_name:customerName')],
  ['WMS importer reports how many Excel clients were detected after upload', receiptImport.includes('Clientes detectados en columna Z') && receiptImport.includes('customerRows')],
  ['WMS import version reprocesses an already-loaded workbook to refresh customer data', receiptImport.includes('customer-column-z-v1') && receiptImport.includes('const fileHash=await sha256(bytes)')],
  ['Excel customer from column Z takes precedence over TMS contract lookup in inbox and validation', receiptCustomerZ.includes("coalesce(nullif(r.customer_name,''),nullif(c.customer_name,'')") && receiptCustomerZ.includes("coalesce(nullif(v_receipt.customer_name,''),v_customer") && receiptCustomerZ.includes("THEN 'EXCEL'")],
)
checks.push(
  ['WMS label preview is an accessible responsive modal with Escape and backdrop dismissal', labeling.includes('id="wms-label-preview" role="dialog" aria-modal="true"') && labeling.includes('fixed inset-0') && labeling.includes('max-h-[96dvh]') && labeling.includes('overflow-y-auto') && labeling.includes("event.key === 'Escape'") && labeling.includes('if (showPreview) setShowPreview(false)') && labeling.includes('onClick={() => setShowPreview(false)}')],
  ['WMS modal preserves individual and batch label printing', labeling.includes('Imprimir etiqueta') && labeling.includes('Imprimir lote') && labeling.includes('print:contents')],
)
checks.push(
  ['same-IPT product lines can be selected in the wide, compact receipt modal', labeling.includes('max-w-7xl') && labeling.includes('selectedIptReceipts.length > 1') && labeling.includes('Ítems recibidos') && labeling.includes('IPT / Código') && labeling.includes('Total ERP: ') && labeling.includes('receipt.document_no === selected.document_no')],
  ['individual print state is tracked per LPN and Zebra uses 4 x 6 inch dimensions', labeling.includes('printedLabelCodes.includes(label.package_code)') && labeling.includes("'Reimprimir etiqueta' : 'Imprimir etiqueta'") && labeling.includes('^PW1218^LL812')],
  ['changing physical quantity displays an audit and variance warning', labeling.includes('role="alert"') && labeling.includes('el ERP conserva su cantidad original') && labeling.includes('el ajuste quedará auditado')],
)
checks.push(
  ['WMS printed label follows the JRM reference with official logo, lot/customer lineage, LPN barcode and quantity/weight', labeling.includes('src="/logo-jrm.png"') && labeling.includes('Cliente:') && labeling.includes('OT:') && labeling.includes('Lote:') && labeling.includes('<Code128Barcode value={label.package_code}') && labeling.includes('wh-label-quantity') && labeling.includes('IPT:') && labeling.includes('Fecha:')],
  ['WMS label print isolates and reveals only labels on standard 4 x 6 in landscape stock after render', labeling.includes('@page{size:152.4mm 101.6mm') && labeling.includes('width:152.4mm!important;height:101.6mm!important') && labeling.includes('.wh-label-barcode{height:22mm') && labeling.includes('#wms-label-preview,#wms-label-preview *{visibility:visible!important}') && labeling.includes('wms-label-list') && labeling.includes('requestAnimationFrame(() => window.requestAnimationFrame(() => window.print()))')],
)
const failures = checks.filter(([, ok]) => !ok)
if (failures.length) {
  for (const [name] of failures) process.stderr.write(`FALLÓ: ${name}\n`)
  process.exitCode = 1
} else {
  process.stdout.write(`WMS acceptance guards OK (${checks.length})\n`)
}
