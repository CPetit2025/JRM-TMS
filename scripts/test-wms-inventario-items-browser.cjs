// Inventario: búsqueda por lote/OT con el ítem del contrato, formulario «cantidad por bulto × n° de bultos» con totales
// automáticos, N etiquetas de una vez, LPN de inventario (mismo SKU, lote e ítem) y columna «Ítem» en etiquetas impresas.
// Chromium (o Edge con CHROMIUM_EXECUTABLE) + API local simulada; no toca datos reales. Capturas en SHOT_DIR (o tmp).
const assert = require('node:assert/strict'), fs = require('node:fs'), os = require('node:os'), path = require('node:path'), http = require('node:http')
const { spawn } = require('node:child_process'), { chromium } = require('playwright')
const shots = process.env.SHOT_DIR || os.tmpdir(); fs.mkdirSync(shots, { recursive: true })
const uid = '00000000-0000-4000-8000-000000000001', CAMP = '00000000-0000-4000-8000-0000000000aa'
const user = { id: uid, email: 'qa@example.test', aud: 'authenticated', role: 'authenticated', app_metadata: {}, user_metadata: {} }
const token = [{ alg: 'HS256', typ: 'JWT' }, { sub: uid, role: 'authenticated', aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 }, 'signature']
  .map((x, i) => i < 2 ? Buffer.from(JSON.stringify(x)).toString('base64url') : x).join('.')
const session = { access_token: token, refresh_token: 'qa-refresh', expires_at: Math.floor(Date.now() / 1000) + 3600, expires_in: 3600, token_type: 'bearer', user }
const profile = { id: uid, is_active: true, employee_type: 'STAFF', first_name: 'Carlos', last_name: 'Petit', roles: { name: 'Analista', permissions: ['almacen-etiquetado', 'almacen-inventario'] } }
const now = new Date().toISOString(), today = now.slice(0, 10)
const camp = { id: CAMP, code: 'INV-261112-AB12', bodega: '647-04 ALM PT', zones: [], tipo: 'GENERAL', productos: [], status: 'EN_CONTEO', notes: null, created_at: now, closed_at: null, close_note: null,
  erp_cut_at: now, created_by_name: 'Carlos', closed_by_name: null, expected_lines: 2, expected_qty: 150, counted_lines: 3, labeled: 3, unidentified: 0, recounts: 0 }
const exp = (item, qty) => ({ linea: 1, cod_producto: 'PT-A', producto: 'Plancha LAF 3 mm', lote: '16571-S002', lote_raw: '16571-S002', lote_key: '16571-S002', ot: '16571', unidad: 'UND', stock: 100, counted: 0,
  item_code: '16571-S002-' + item, item, contract_qty: qty, unit_weight_kg: 1.5, weight_source: 'STOCK_ERP' })
const expected = [exp('022', 60), exp('024', 40)]
const line = (id, code, item, extra = {}) => ({ id, round: 1, origin: 'ROTULO', zone: null, cod_producto: 'PT-A', lote_key: '16571-S002', ot: '16571', quantity: 10, weight_kg: 15, note: null, other_bodega: false,
  counted_at: now, counted_by_name: 'Carlos', mine: true, package_code: code, description: 'Plancha LAF 3 mm', unit: 'UND', contract_code: '16571-S002-' + item, lpn_id: null, lpn_code: null, ...extra })
const lines = [line(1, '16571-S002-B-0001', '022'), line(2, '16571-S002-B-0002', '022'), line(3, '16571-S002-B-0003', '024')]
const pkg = (code, n, N) => ({ package_code: code, source_document_no: camp.code, source_contract_code: '16571-S002-022', source_lot: '16571-S002', source_product_code: 'PT-A', source_unit: 'UND',
  source_warehouse: camp.bodega, source_date: today, source_movement_key: 'INV:x:1', description: 'Plancha LAF 3 mm', quantity: 10, unit: 'UND', weight_kg: 15, sequence_no: n, sequence_total: N,
  label_print_count: 1, lpn_id: null, status: 'AVAILABLE', created_at: now, source_system: 'ERP' })
const created = ['16571-S002-B-0004', '16571-S002-B-0005', '16571-S002-B-0006']
const lpn = { id: 'lpn-1', lpn_code: '16571-S002-B-0007', origin: 'INVENTARIO', status: 'CLOSED', task_id: null, print_count: 0, package_count: 2, quantity: 20, weight_kg: 30, void_reason: null, created_at: now, created_by_name: 'Carlos',
  packages: lines.slice(0, 2).map(l => ({ package_code: l.package_code, receipt_key: 'INV:x:1', document: camp.code, contract_code: l.contract_code, product_code: 'PT-A', description: l.description, lot: '16571-S002', quantity: 10, unit: 'UND', weight_kg: 15, warehouse: camp.bodega, date: today, status: 'AVAILABLE' })) }
const printed = [pkg('16571-S002-B-0001', 1, 2), pkg('16571-S002-B-0002', 2, 2), { ...pkg('IPT-PKG-1', 1, 1), source_contract_code: '16573', source_lot: '16573', source_product_code: 'PT-Z', source_document_no: 'IPT-9', source_movement_key: 'R9' }]
const format = { id: 'format-1', name: 'Zebra 6 x 4', width_mm: 152.4, height_mm: 101.6, dpi: 203, is_active: true }
const calls = []
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*'); res.setHeader('Access-Control-Allow-Headers', '*'); res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); res.setHeader('Content-Type', 'application/json')
  if (req.method === 'OPTIONS') { res.end(); return }
  let body = ''; for await (const c of req) body += c
  const url = new URL(req.url, 'http://localhost'), p = body ? JSON.parse(body) : null, at = s => url.pathname.endsWith(s)
  calls.push({ path: url.pathname, p })
  let out = []
  if (at('/user')) out = user
  else if (at('/token')) out = session
  else if (at('/profiles')) out = req.headers.accept?.includes('object') ? profile : [profile]
  else if (at('/wh_label_formats')) out = [format]
  else if (at('/wh_label_settings')) out = url.searchParams.get('select') === 'kind,format_id' ? [{ kind: 'PAQUETE', format_id: format.id }] : { format }
  else if (at('/rpc/wh_count_board')) out = [camp]
  else if (at('/rpc/wh_count_lines_list')) out = lines
  else if (at('/rpc/wh_count_summary')) out = []
  else if (at('/rpc/wh_count_expected_search')) out = expected
  else if (at('/rpc/wh_count_label_bultos')) out = { package_codes: created, quantity_total: p.p_qty_per_bulto * p.p_bultos, weight_total_kg: p.p_qty_per_bulto * p.p_bultos * 1.5 }
  else if (at('/wh_packages')) out = url.searchParams.get('package_code')?.startsWith('in.') ? created.map((c, i) => pkg(c, i + 1, 3)) : printed
  else if (at('/rpc/wh_count_consolidate_lpn') || at('/rpc/wh_lpn_detail')) out = lpn
  else if (at('/rpc/wh_print_lpn_label')) out = { lpn_code: lpn.lpn_code, print_count: 1 }
  res.end(JSON.stringify(out))
})
;(async () => {
  await new Promise(r => server.listen(54334, '127.0.0.1', r))
  const log = fs.openSync(path.join(os.tmpdir(), 'wms-inventario-items-dev.log'), 'w')
  const next = spawn(process.execPath, ['node_modules/next/dist/bin/next', 'dev', '--hostname', '127.0.0.1', '--port', '3024'], {
    env: { ...process.env, NEXT_PUBLIC_DEPLOYMENT_SYSTEM: '', NEXT_PUBLIC_SUPABASE_URL: 'http://127.0.0.1:54334', NEXT_PUBLIC_SUPABASE_ANON_KEY: 'qa-public-key' }, stdio: ['ignore', log, log] })
  let browser, page
  try {
    for (let i = 0; i < 240; i++) { try { if ((await fetch('http://127.0.0.1:3024/login')).ok) break } catch {} await new Promise(r => setTimeout(r, 500)) }
    browser = await chromium.launch({ ...(process.env.CHROMIUM_EXECUTABLE ? { executablePath: process.env.CHROMIUM_EXECUTABLE } : fs.existsSync('/usr/bin/chromium') ? { executablePath: '/usr/bin/chromium' } : {}), args: ['--no-sandbox'] })
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Lima' })
    await ctx.addCookies([{ name: 'sb-127-auth-token', value: 'base64-' + Buffer.from(JSON.stringify(session)).toString('base64url'), domain: '127.0.0.1', path: '/' }])
    page = await ctx.newPage()
    const errors = []; page.on('pageerror', e => errors.push(e.message))
    await page.addInitScript(id => { const key = 'wh-label-print:v7:' + id + ':PAQUETE'; if (!localStorage.getItem(key)) localStorage.setItem(key, JSON.stringify({ formatId: '', orientation: 'FORMAT', paper: 'LABEL' })) }, uid)
    await page.addInitScript(() => { window.__printed = []; window.print = () => { window.__printed.push([...document.querySelectorAll('#wh-label-print-root .wh-package-label')].map(n => n.getAttribute('data-package-code'))); setTimeout(() => window.dispatchEvent(new Event('afterprint')), 50) } })
    const style = 'nextjs-portal{display:none}'

    // 1. Búsqueda por lote: una fila por ítem con «Ítem 022» / «Ítem 024»
    await page.goto(`http://127.0.0.1:3024/almacen/inventario/${CAMP}`)
    const searchBox = page.getByPlaceholder('OT, lote o producto del rótulo')
    await searchBox.waitFor({ timeout: 180000 })
    await searchBox.fill('16571'); await page.getByRole('button', { name: 'Buscar', exact: true }).click()
    const results = page.getByRole('button', { name: /Ítem 02[24]/ })
    await results.first().waitFor()
    assert.equal(await results.count(), 2, 'una fila por ítem del contrato')
    assert.match(await results.nth(1).innerText(), /Ítem 024[\s\S]*contrato 40/)
    await page.screenshot({ path: path.join(shots, 'inventario-busqueda-items.png'), fullPage: true, style })

    // 2. Formulario: cantidad por bulto y n° de bultos; totales automáticos de solo lectura; N etiquetas de una vez
    await results.first().click()
    assert.equal(await page.getByLabel('Peso kg').count(), 0, 'el peso ya no se digita')
    await page.getByLabel('Cantidad por bulto*').fill('10'); await page.getByLabel('N° de bultos*').fill('3')
    const totals = page.getByRole('definition')
    assert.deepEqual(await totals.allInnerTexts(), ['30 UND', '1.5 kg · stock ERP del corte', '45 kg'])
    await page.screenshot({ path: path.join(shots, 'inventario-formulario-totales.png'), fullPage: true, style })
    await page.getByRole('button', { name: 'Etiquetar e imprimir 3 bulto(s)' }).click()
    await page.waitForFunction(() => window.__printed.length > 0)
    assert.deepEqual(await page.evaluate(() => window.__printed[0]), created, 'las 3 etiquetas en una sola impresión')
    const labelCall = calls.find(c => c.path.endsWith('/rpc/wh_count_label_bultos')).p
    assert.deepEqual([labelCall.p_item_code, labelCall.p_qty_per_bulto, labelCall.p_bultos], ['16571-S002-022', 10, 3])

    // 3. LPN: solo mismo SKU, lote e ítem; «Marcar todos» y «Consolidar en LPN (N)»; etiqueta del LPN + hoja de contenido
    const box = code => page.getByRole('checkbox', { name: `Agrupar ${code} en el LPN` })
    await box('16571-S002-B-0001').check()
    assert.ok(await box('16571-S002-B-0003').isDisabled(), 'otro ítem no se puede marcar junto al primero')
    const cons = page.getByRole('button', { name: /Consolidar en LPN/ })
    await page.getByRole('checkbox', { name: 'Marcar todos los bultos que se pueden agrupar' }).check()
    assert.equal(await cons.innerText(), 'Consolidar en LPN (2)')
    await page.evaluate(() => { window.__printed = [] })
    await cons.click()
    await page.waitForFunction(() => window.__printed.length > 0)
    assert.deepEqual(await page.evaluate(() => window.__printed[0]), ['16571-S002-B-0007'], 'se imprime la etiqueta del LPN')
    assert.deepEqual(calls.find(c => c.path.endsWith('/rpc/wh_count_consolidate_lpn')).p.p_package_codes, ['16571-S002-B-0001', '16571-S002-B-0002'])
    assert.ok(calls.some(c => c.path.endsWith('/rpc/wh_print_lpn_label')), 'impresión del LPN auditada')

    // 4. Etiquetas impresas: columna «Ítem» (y búsqueda por ítem)
    await page.goto('http://127.0.0.1:3024/almacen/apt/etiquetas-impresas')
    await page.getByRole('columnheader', { name: 'Ítem' }).waitFor({ timeout: 120000 })
    await page.getByText('Plancha LAF 3 mm').first().waitFor()
    const rows = page.locator('tbody tr')
    const cells = await rows.evaluateAll(trs => trs.map(tr => tr.children[2]?.textContent))
    assert.deepEqual(cells.sort(), ['022', '—'])
    await page.getByPlaceholder(/Buscar por lote, IPT, ítem/).fill('022')
    await page.waitForFunction(() => document.querySelectorAll('tbody tr').length === 1)
    await page.getByPlaceholder(/Buscar por lote, IPT, ítem/).fill('')
    await page.screenshot({ path: path.join(shots, 'etiquetas-impresas-item.png'), fullPage: true, style })
    assert.deepEqual(errors, [])
    console.log('PASS browser: búsqueda con Ítem por fila, totales automáticos y N etiquetas de una vez, LPN de inventario por SKU/lote/ítem y columna Ítem en etiquetas impresas.')
  } catch (e) {
    if (page) await page.screenshot({ path: path.join(shots, 'inventario-items-error.png'), fullPage: true }).catch(() => {})
    throw e
  } finally {
    if (browser) await browser.close()
    if (next.exitCode === null && next.signalCode === null) await new Promise(resolve => { const timer = setTimeout(() => next.kill('SIGKILL'), 10000); next.once('exit', () => { clearTimeout(timer); resolve() }); next.kill('SIGTERM') })
    server.close(); fs.closeSync(log)
  }
})().catch(e => { console.error(e); process.exitCode = 1 })
