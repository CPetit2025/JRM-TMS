// Recepción APT: consolidar líneas validadas en un LPN e imprimir solo su etiqueta + hoja de contenido.
// Chromium (o Edge con CHROMIUM_EXECUTABLE) + API local simulada; no toca datos reales.
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const { spawn } = require('node:child_process'), { chromium } = require('playwright')
const uid = '00000000-0000-4000-8000-000000000001'
const user = { id: uid, email: 'qa@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} }
const token = [{ alg: 'HS256', typ: 'JWT' }, { sub: uid, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }, 'signature']
  .map((x, i) => i < 2 ? Buffer.from(JSON.stringify(x)).toString('base64url') : x).join('.')
const session = { access_token: token, refresh_token: 'qa-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user }
const profile = { id: uid, is_active: true, employee_type: 'STAFF', first_name: 'Carlos', last_name: 'Petit', roles: { name: 'Etiquetado', permissions: ['almacen-etiquetado'] } }
const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
const line = (key, product, lot, ot, qty, extra = {}) => ({ receipt_key: key, document_no: 'IPT-9', fecha: today, document_type: 'IPT', color: null, source_updated_at: null, bodega: 'APT', lote: lot,
  product_code: product, description: 'Producto ' + product, unit: 'UND', contract_code: ot, quantity: qty, weight_kg: qty * 10, customer_name: 'Fargoline SAC', customer_source: 'EXCEL',
  physical_quantity: qty, variance: 0, variance_reason: null, validation_status: 'VALIDATED', label_count: 0, labeled_qty: 0, unprinted_count: 0, pending_labels: [], label_status: 'NOT_LABELED', ...extra })
const receipts = [line('R1', 'P-A', '16573', '16573', 10), line('R2', 'P-B', '16574', 'OT-16573', 5), line('R3', 'P-C', '99999', '99999', 3), line('R4', 'P-D', '16573', '16573', 2, { validation_status: 'PENDING', physical_quantity: null })]
const pkgOf = (r, code) => ({ package_code: code, receipt_key: r.receipt_key, document: r.document_no, contract_code: r.contract_code, product_code: r.product_code, description: r.description, lot: r.lote, quantity: r.quantity, unit: r.unit, weight_kg: r.weight_kg, warehouse: r.bodega, date: r.fecha, status: 'AVAILABLE' })
const lpn = { id: 'lpn-1', lpn_code: '16573-B-0002', origin: 'RECEPCION', status: 'CLOSED', task_id: null, print_count: 0, package_count: 2, quantity: 15, weight_kg: 150, void_reason: null,
  created_at: new Date().toISOString(), created_by_name: 'Carlos Petit', packages: [pkgOf(receipts[0], '16573-B-0003'), pkgOf(receipts[1], '16574-B-0001')] }
const format = { id: 'format-1', name: 'Zebra 6 x 4', width_mm: 152.4, height_mm: 101.6, dpi: 203, is_active: true }
const calls = []
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.setHeader('Content-Type', 'application/json')
  if (req.method === 'OPTIONS') { res.end(); return }
  let body = ''; for await (const c of req) body += c
  const url = new URL(req.url, 'http://localhost'), p = body ? JSON.parse(body) : null
  calls.push({ path: url.pathname, p })
  let out = []
  if (url.pathname.endsWith('/user')) out = user
  else if (url.pathname.endsWith('/token')) out = session
  else if (url.pathname.endsWith('/profiles')) out = req.headers.accept?.includes('object') ? profile : [profile]
  else if (url.pathname.endsWith('/wh_label_formats')) out = [format]
  else if (url.pathname.endsWith('/wh_label_settings')) out = url.searchParams.get('select') === 'kind,format_id' ? [{ kind: 'PAQUETE', format_id: format.id }] : { format }
  else if (url.pathname.endsWith('/rpc/wh_receipt_candidates')) out = receipts
  else if (url.pathname.endsWith('/rpc/wh_receipt_consolidate_lpn')) out = lpn
  else if (url.pathname.endsWith('/rpc/wh_lpn_detail')) out = lpn
  else if (url.pathname.endsWith('/rpc/wh_receipt_control_customers')) out = p.p_source_movement_keys.map(k => ({ source_movement_key: k, customer_name: 'Fargoline SAC' }))
  else if (url.pathname.endsWith('/rpc/wh_print_lpn_label')) out = { lpn_code: lpn.lpn_code, print_count: 1 }
  res.end(JSON.stringify(out))
})
;(async () => {
  await new Promise(r => server.listen(54333, '127.0.0.1', r))
  const log = fs.openSync(path.join(os.tmpdir(), 'wms-lpn-recepcion-dev.log'), 'w')
  const next = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3023'], {
    env: { ...process.env, NEXT_PUBLIC_DEPLOYMENT_SYSTEM: '', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54333', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'qa-public-key' }, stdio: ['ignore', log, log] })
  let browser, page
  try {
    for (let i = 0; i < 240; i++) { try { if ((await fetch('http://127.0.0.1:3023/login')).ok) break } catch {} await new Promise(r => setTimeout(r, 500)) }
    browser = await chromium.launch({ ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : fs.existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {}), args: ['--no-sandbox'] })
    const ctx = await browser.newContext({ viewport: { width: 1536, height: 1000 }, timezoneId: 'America/Lima' })
    await ctx.addCookies([{ name: 'sb-127-auth-token', value: 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url'), domain: '127.0.0.1', path: '/' }])
    page = await ctx.newPage()
    const errors = []; page.on('pageerror', e => errors.push(e.message))
    await page.addInitScript(id => { const key = 'wh-label-print:v7:' + id + ':PAQUETE'; if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ formatId: '', orientation: 'FORMAT', paper: 'LABEL' })) }, uid)
    await page.addInitScript(() => { window.__printed = []; window.print = () => { window.__printed.push(document.querySelector('#wh-label-print-root .wh-package-label').outerHTML) } })
    await page.goto('http://127.0.0.1:3023/almacen/etiquetado')
    await page.getByRole('button', { name: 'Recibir', exact: true }).first().waitFor({ timeout: 180000 })
    await page.getByRole('button', { name: 'Recibir', exact: true }).first().click()
    const dialog = page.getByRole('dialog', { name: 'WMS · Recepción APT' })
    const box = product => dialog.getByRole('checkbox', { name: `Consolidar ${product} en el LPN` })
    const consolidateButton = dialog.getByRole('button', { name: /Consolidar en LPN/ })
    assert.ok(await consolidateButton.isDisabled(), 'sin dos líneas marcadas no se consolida')
    assert.ok(await box('P-D').isDisabled(), 'una línea sin validar no se puede marcar')
    await box('P-A').check()
    assert.ok(await box('P-C').isDisabled(), 'otra OT no se puede marcar junto a la primera')
    assert.ok(await box('P-B').isEnabled(), 'misma OT (con o sin prefijo OT) y mismo cliente se puede marcar')
    await box('P-B').check()
    assert.equal(await consolidateButton.innerText(), 'Consolidar en LPN (2)')
    // «Marcar todas» desmarca y vuelve a marcar de un clic las líneas consolidables (misma OT y cliente)
    const all = dialog.getByRole('checkbox', { name: 'Marcar todas las líneas que se pueden consolidar' })
    await all.uncheck(); assert.equal(await consolidateButton.innerText(), 'Consolidar en LPN (0)')
    await all.check(); assert.equal(await consolidateButton.innerText(), 'Consolidar en LPN (2)'); assert.ok(!(await box('P-C').isChecked()), 'otra OT no entra en marcar todas')
    await consolidateButton.click()
    const preview = page.getByRole('dialog', { name: /Vista previa · LPN 16573-B-0002/ })
    await preview.waitFor()
    const consolidateCall = calls.find(c => c.path.endsWith('/rpc/wh_receipt_consolidate_lpn'))
    assert.deepEqual(consolidateCall.p.p_receipt_keys, ['R1', 'R2'], 'envía las líneas en el orden en que se marcaron')
    const label = preview.locator('.wh-package-label')
    assert.equal(await label.count(), 1, 'solo una etiqueta: la del LPN')
    assert.equal(await label.getAttribute('data-package-code'), '16573-B-0002')
    const text = await label.innerText()
    assert.match(text, /Contenido: 2 líneas/); assert.match(text, /LPN\s*B-0002/); assert.match(text, /15 UND/); assert.match(text, /150 kg/); assert.match(text, /Fargoline SAC/)
    assert.equal(await preview.locator('table tbody tr').count(), 2, 'hoja de contenido con una fila por línea')
    const previewHtml = await label.evaluate(n => n.outerHTML)
    await page.screenshot({ path: path.join(os.tmpdir(), 'wms-lpn-recepcion-preview.png'), fullPage: true, style: 'nextjs-portal{display:none}' })
    await preview.getByRole('button', { name: 'Imprimir etiqueta LPN', exact: true }).click()
    await page.waitForFunction(() => window.__printed.length > 0)
    assert.equal(await page.evaluate(() => window.__printed.length), 1, 'se imprime una sola etiqueta')
    assert.equal(await page.evaluate(() => window.__printed[0]), previewHtml, 'la impresión es la misma etiqueta de la vista previa')
    assert.ok(calls.some(c => c.path.endsWith('/rpc/wh_print_lpn_label') && c.p.p_lpn_id === 'lpn-1'), 'se audita la impresión del LPN')
    assert.ok(!calls.some(c => /wh_(print_labels|label_package)$/.test(c.path)), 'no se generan ni imprimen etiquetas individuales')
    const download = page.waitForEvent('download')
    await preview.getByRole('button', { name: 'Hoja de contenido', exact: true }).click()
    assert.equal((await download).suggestedFilename(), 'contenido-16573-B-0002.pdf')
    assert.deepEqual(errors, [])
    console.log('PASS browser: casillas solo para líneas validadas del mismo cliente y OT; Consolidar en LPN (N); vista previa con una etiqueta del LPN (Contenido: N líneas, totales) y su hoja de contenido; imprime solo el LPN y descarga la hoja.')
  } catch (e) {
    if (page) await page.screenshot({ path: path.join(os.tmpdir(), 'wms-lpn-recepcion-error.png'), fullPage: true }).catch(() => {})
    throw e
  } finally {
    if (browser) await browser.close()
    if (next.exitCode === null && next.signalCode === null) await new Promise(resolve => { const timer = setTimeout(() => next.kill('SIGKILL'), 10000); next.once('exit', () => { clearTimeout(timer); resolve() }); next.kill('SIGTERM') })
    server.close(); fs.closeSync(log)
  }
})().catch(e => { console.error(e); process.exitCode = 1 })
