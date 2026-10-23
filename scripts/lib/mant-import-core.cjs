// Núcleo de la importación del historial de mantenimiento (Excel «Mantenimiento_Flota_v5_Analisis_360», hoja CONSOLIDADO).
// Funciones puras: lectura de filas, normalización, clave natural, agrupación de proveedores, validaciones y reporte de cuadre.
// No inventa datos: lo que falta queda vacío y se marca en `faltantes`.
const XLSX = require('xlsx')

const norm = s => {
  if (s === null || s === undefined) return null
  const t = String(s).toUpperCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Z0-9Ñ]+/g, ' ').replace(/Ñ/g, 'N').replace(/\s+/g, ' ').trim()
  return t === '' ? null : t
}
// Igual a public.mant_norm (SQL): sin tildes, Ñ → N, solo letras y números
const keyText = norm

const fnv = s => {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0; h2 = Math.imul(h2 ^ c, 0x01000193 + 0x100) >>> 0 }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

// Encabezados reconocidos (por nombre normalizado). AA–AD son las columnas de calidad del v5.
const COLS = {
  ACTIVO: ['ACTIVO'], CLASE_ACTIVO: ['CLASE ACTIVO'], FECHA: ['FECHA'], PROVEEDOR: ['PROVEEDOR'], FACTURA: ['FACTURA'], RQ: ['RQ', 'REQUERIMIENTO'],
  KM_HRS: ['KM HRS'], PROX_MANTTO: ['PROX MANTTO'], FECHA_INGRESO: ['FECHA INGRESO'], FECHA_SALIDA: ['FECHA SALIDA'], MONTO: ['MONTO'],
  MONEDA: ['MONEDA'], INCLUYE_IGV: ['INCLUYE IGV', 'CON IGV'], COMENTARIOS: ['COMENTARIOS', 'DESCRIPCION'], TIPO_MANTTO: ['TIPO MANTTO'],
  AREA: ['AREA'], CATEGORIA_COSTO: ['CATEGORIA COSTO'], TIPO_ORIGEN: ['TIPO ORIGEN'], ANIO_FAB: ['ANO FABRICACION', 'ANIO FABRICACION'],
  DIAS_FUERA: ['DIAS FUERA SERVICIO', 'DIAS FUERA DE SERVICIO'], INTERVENCION_MAYOR: ['INTERVENCION MAYOR'], AUTORIZADO: ['AUTORIZADO POR', 'AUTORIZO'],
  CRITERIO_TIPO: ['CRITERIO TIPO MANTTO'], OBS_MEDIDOR: ['OBS MEDIDOR'], KM_HRS_VALIDADO: ['KM HRS VALIDADO'], DIA_CON_CORRECTIVO: ['DIA CON CORRECTIVO'],
}
const REQUIRED_V5 = ['TIPO_ORIGEN', 'CRITERIO_TIPO', 'OBS_MEDIDOR', 'KM_HRS_VALIDADO', 'DIA_CON_CORRECTIVO']
const TIPOS = new Set(['PREVENTIVO', 'CORRECTIVO', 'MEJORA'])
const OBS_MEDIDOR = ['OK', 'RETROCESO', 'PICO', 'SALTO ANOMALO', 'SIN AVANCE 120 DIAS', 'REINICIO CAMBIO DE MEDIDOR']

const pad = n => String(n).padStart(2, '0')
function isoDate(v) {
  if (v instanceof Date && !isNaN(v)) return `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
  if (typeof v === 'number' && v > 20000 && v < 80000) { const p = XLSX.SSF.parse_date_code(v); return p ? `${p.y}-${pad(p.m)}-${pad(p.d)}` : null }
  if (typeof v === 'string') {
    let m = v.trim().match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return `${m[1]}-${m[2]}-${m[3]}`
    m = v.trim().match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})/); if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`
  }
  return null
}
// Fecha y hora (si la celda trae hora); sin hora queda 00:00 y se marca
function isoDateTime(v) {
  if (v instanceof Date && !isNaN(v)) {
    const hasTime = v.getHours() || v.getMinutes()
    return { value: `${isoDate(v)}T${pad(v.getHours())}:${pad(v.getMinutes())}:00-05:00`, hasTime: !!hasTime }
  }
  const d = isoDate(v)
  return d ? { value: `${d}T00:00:00-05:00`, hasTime: false } : { value: null, hasTime: false }
}
function num(v) {
  if (v === null || v === undefined || v === '') return { value: null, invalid: false }
  if (typeof v === 'number') return Number.isFinite(v) ? { value: v, invalid: false } : { value: null, invalid: true }
  const t = String(v).trim().replace(/\s/g, '').replace(/^S\/\.?/i, '')
  if (t === '' || t === '-') return { value: null, invalid: false }
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return { value: Number(t.replace(/,/g, '')), invalid: false }
  if (/^-?\d+(\.\d+)?$/.test(t)) return { value: Number(t), invalid: false }
  if (/^-?\d+,\d+$/.test(t)) return { value: Number(t.replace(',', '.')), invalid: false }
  return { value: null, invalid: true }
}
const text = v => v === null || v === undefined ? null : (v instanceof Date ? isoDate(v) : (String(v).trim() || null))
const bool = v => { const t = norm(v); if (!t) return null; if (/^(SI|S|TRUE|1|VERDADERO|X)$/.test(t)) return true; if (/^(NO|N|FALSE|0|FALSO)$/.test(t)) return false; return null }

/** Igual a public.mant_tipo_violacion: una reparación o un cambio de componente nunca es preventivo */
function tipoViolacion(tipo, descripcion) {
  if (!['PREVENTIVO', 'PREVENTIVA'].includes(String(tipo || '').toUpperCase())) return null
  const t = ` ${norm(descripcion) || ''} `
  if (/\s(REPAR\w*|AVERIA\w*|FALLA\w*|OVERHAUL|RECTIFIC\w*|REEMPLAZO DE (MOTOR|CAJA|BOMBA|EMBRAGUE|ALTERNADOR|ARRANCADOR|TURBO|RADIADOR|DIFERENCIAL|COMPRESOR|CILINDRO))/.test(t))
    return 'La descripción indica una reparación: no puede registrarse como preventivo'
  if (/\sCAMBIO (DE |DEL )?(MOTOR|CAJA|BOMBA|EMBRAGUE|ALTERNADOR|ARRANCADOR|MOTOR DE ARRANQUE|TURBO|RADIADOR|DIFERENCIAL|COMPRESOR|CILINDRO|INYECTOR\w*|RODAMIENTO\w*|RODAJE\w*|CREMALLERA|CARDAN|PISTON\w*|CULATA|CONTACTOR\w*|TARJETA|CONTROLADOR|MOTOR ELECTRICO|MOTOR DE TRACCION|MOTOR HIDRAULICO|BATERIA\w*)/.test(t))
    return 'La descripción indica un cambio de componente: no puede registrarse como preventivo'
  return null
}

function findSheet(wb, wanted) {
  const name = wb.SheetNames.find(n => norm(n) === norm(wanted)) ?? wb.SheetNames.find(n => norm(n).includes('CONSOLIDADO'))
  if (!name) throw new Error(`No se encontró la hoja ${wanted}. Hojas: ${wb.SheetNames.join(', ')}`)
  return name
}

/** Lee la hoja y devuelve los registros normalizados con su fila de origen */
function parseWorkbook(buf, opt = {}) {
  const wb = XLSX.read(buf, { type: 'buffer', cellDates: true })
  const sheet = findSheet(wb, opt.sheet || 'CONSOLIDADO')
  const aoa = XLSX.utils.sheet_to_json(wb.Sheets[sheet], { header: 1, raw: true, defval: null, blankrows: false })
  let hr = aoa.findIndex(r => (r || []).some(c => norm(c) === 'ACTIVO') && (r || []).some(c => norm(c) === 'MONTO'))
  if (hr < 0) throw new Error('No se encontró el encabezado (ACTIVO, MONTO…)')
  const head = aoa[hr].map(h => text(h))
  const idx = {}
  head.forEach((h, j) => {
    const k = norm(h)
    if (!k) return
    for (const [col, names] of Object.entries(COLS)) if (idx[col] === undefined && names.includes(k)) idx[col] = j
  })
  const missingV5 = REQUIRED_V5.filter(c => idx[c] === undefined)
  const rows = []
  for (let i = hr + 1; i < aoa.length; i++) {
    const r = aoa[i]
    if (!r || r.every(c => c === null || c === '')) continue
    const raw = {}
    head.forEach((h, j) => { if (h) raw[h] = r[j] instanceof Date ? isoDate(r[j]) : r[j] })
    rows.push(buildRecord(r, idx, raw, i + 1, sheet, missingV5.length === 0))
  }
  markDuplicates(rows)
  return { sheet, headerRow: hr + 1, columns: idx, missingV5, rows, sheets: wb.SheetNames }
}

function buildRecord(r, idx, raw, fila, hoja, isV5) {
  const g = c => idx[c] === undefined ? undefined : r[idx[c]]
  const faltantes = [], obs = []
  const activo = text(g('ACTIVO'))
  const fecha = isoDate(g('FECHA'))
  if (g('FECHA') !== null && g('FECHA') !== undefined && !fecha) obs.push(`FECHA no reconocida: «${g('FECHA')}»`)
  const monto = num(g('MONTO')); if (monto.invalid) obs.push(`MONTO no numérico: «${g('MONTO')}»`)
  const km = num(g('KM_HRS')); if (km.invalid) obs.push(`KM_HRS no numérico: «${g('KM_HRS')}» (se conserva en la fila original)`)
  const kmv = num(g('KM_HRS_VALIDADO'))
  const prox = num(g('PROX_MANTTO'))
  const dias = num(g('DIAS_FUERA'))
  const anio = num(g('ANIO_FAB'))
  const ing = isoDateTime(g('FECHA_INGRESO')), sal = isoDateTime(g('FECHA_SALIDA'))
  if ((ing.value && !ing.hasTime) || (sal.value && !sal.hasTime)) obs.push('Ingreso o salida de taller sin hora: se registra la fecha a las 00:00')
  // Tipo: en el v5 TIPO_MANTTO ya está corregido y TIPO_ORIGEN es el original. En el formato anterior TIPO_MANTTO es el original.
  const tipoMantto = norm(g('TIPO_MANTTO')), tipoOrigenCol = text(g('TIPO_ORIGEN'))
  let tipo = null, tipoOrigen
  if (isV5) { tipo = tipoMantto; tipoOrigen = tipoOrigenCol } else { tipoOrigen = text(g('TIPO_MANTTO')) }
  if (tipo && !TIPOS.has(tipo)) { obs.push(`Tipo no reconocido: «${g('TIPO_MANTTO')}»`); tipo = null }
  const moneda = norm(g('MONEDA')) === 'USD' || norm(g('MONEDA')) === 'DOLARES' ? 'USD' : 'PEN'
  const descripcion = text(g('COMENTARIOS'))
  const rec = {
    hoja, fila, fila_original: raw,
    activo_original: activo, clase_activo: text(g('CLASE_ACTIVO')), fecha,
    proveedor_original: text(g('PROVEEDOR')), factura: text(g('FACTURA')), rq: text(g('RQ')),
    monto: monto.value, moneda, incluye_igv: bool(g('INCLUYE_IGV')), tipo_cambio: null, monto_pen: moneda === 'PEN' ? monto.value : null,
    descripcion, tipo, tipo_origen: tipoOrigen, criterio_tipo: text(g('CRITERIO_TIPO')), area: text(g('AREA')), categoria_costo: text(g('CATEGORIA_COSTO')),
    intervencion_mayor: bool(g('INTERVENCION_MAYOR')), ingreso_at: ing.value, salida_at: sal.value,
    dias_fuera: dias.value ?? (ing.value && sal.value ? Math.max(0, Math.round((Date.parse(sal.value) - Date.parse(ing.value)) / 864e5 * 100) / 100) : null),
    autorizado_por: text(g('AUTORIZADO')), km_hrs_original: km.value, km_hrs_validado: kmv.value, obs_medidor: text(g('OBS_MEDIDOR')),
    prox_mantto: prox.value, dia_con_correctivo: bool(g('DIA_CON_CORRECTIVO')), anio_fabricacion: anio.value ? Math.round(anio.value) : null,
    faltantes, observaciones: obs, estado: 'OK', motivos: [],
  }
  for (const [k, label] of [['fecha', 'FECHA'], ['proveedor_original', 'PROVEEDOR'], ['factura', 'FACTURA'], ['monto', 'MONTO'], ['descripcion', 'COMENTARIOS'], ['km_hrs_original', 'KM_HRS'], ['tipo', 'TIPO_MANTTO (corregido)']])
    if (rec[k] === null || rec[k] === undefined) faltantes.push(label)
  if (moneda === 'USD') { faltantes.push('TIPO_CAMBIO'); obs.push('Monto en USD sin tipo de cambio: no suma en soles') }
  // Estado del registro: rechazado (no se carga) o dudoso (se carga y se lista)
  if (!activo) { rec.estado = 'RECHAZADO'; rec.motivos.push('Sin ACTIVO') }
  else if (rec.monto === null && monto.invalid) { rec.estado = 'RECHAZADO'; rec.motivos.push('MONTO no numérico') }
  if (rec.estado === 'OK') {
    if (!fecha) rec.motivos.push('Sin FECHA válida')
    if (rec.monto === null) rec.motivos.push('Sin MONTO')
    if (rec.monto !== null && rec.monto <= 0) rec.motivos.push('MONTO cero o negativo')
    const v = tipoViolacion(tipo, descripcion); if (v) rec.motivos.push(`Tipo PREVENTIVO con ${v.includes('reparación') ? 'reparación' : 'cambio de componente'} en la descripción`)
    if (rec.obs_medidor && norm(rec.obs_medidor) !== 'OK') rec.motivos.push(`Medidor: ${rec.obs_medidor}`)
    if (km.invalid) rec.motivos.push('KM_HRS no numérico')
    if (rec.motivos.length) rec.estado = 'DUDOSO'
  }
  return rec
}

/** Clave natural: activo + fecha + factura + monto + huella de la descripción + n.° de repetición (líneas idénticas legítimas) */
function markDuplicates(rows) {
  const seen = new Map()
  for (const r of rows) {
    if (r.estado === 'RECHAZADO') continue
    const base = [norm(r.activo_original), r.fecha ?? '∅', norm(r.factura) ?? '∅', r.monto === null ? '∅' : r.monto.toFixed(2), fnv(norm(r.descripcion) ?? '')].join('|')
    const n = (seen.get(base) ?? 0) + 1
    seen.set(base, n)
    r.clave_natural = `${base}|${n}`
    if (n > 1) r.observaciones.push(`Línea idéntica n.° ${n} en el Excel (misma clave): se conserva`)
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Proveedores: equivalencias propuestas (se revisan en la pantalla de equivalencias)
// ---------------------------------------------------------------------------------------------------------------
const LEGAL = /\b(S A C|SAC|S A|SA|E I R L|EIRL|S R L|SRL|S A A|SAA|CIA|COMPANIA|SOCIEDAD ANONIMA CERRADA)\b/g
const core = s => (norm(s) || '').replace(LEGAL, ' ').replace(/\s+/g, ' ').trim()
function lev(a, b) {
  if (a === b) return 0
  const m = a.length, n = b.length
  if (Math.abs(m - n) > 3) return 99
  let prev = Array.from({ length: n + 1 }, (_, j) => j)
  for (let i = 1; i <= m; i++) {
    const cur = [i]
    for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1))
    prev = cur
  }
  return prev[n]
}
/** Agrupa nombres equivalentes: mismo nombre sin forma societaria, o diferencia de hasta 2 letras en nombres de 10+ caracteres */
function groupProviders(names, overrides = {}) {
  const counts = new Map()
  for (const n of names) if (norm(n)) counts.set(n, (counts.get(n) ?? 0) + 1)
  const list = [...counts.keys()].sort((a, b) => counts.get(b) - counts.get(a))
  const groups = []
  for (const name of list) {
    const ov = Object.entries(overrides).find(([k]) => norm(k) === norm(name))
    if (ov) { let g = groups.find(x => norm(x.canonico) === norm(ov[1])); if (!g) { g = { canonico: ov[1], miembros: [], fuente: 'equivalencia revisada' }; groups.push(g) } g.miembros.push(name); continue }
    const c = core(name)
    const g = groups.find(x => x.fuente !== 'equivalencia revisada' && (core(x.canonico) === c || (c.length >= 10 && lev(core(x.canonico), c) <= 2)))
    if (g) { g.miembros.push(name); if (core(g.canonico) !== c) g.fuente = 'similitud (revisar)'; else if (g.fuente === 'único') g.fuente = 'forma societaria' }
    else groups.push({ canonico: name, miembros: [name], fuente: 'único' })
  }
  return groups
}

// ---------------------------------------------------------------------------------------------------------------
// Reporte de cuadre
// ---------------------------------------------------------------------------------------------------------------
const r2 = n => Math.round(n * 100) / 100
function totals(rows) {
  const ok = rows.filter(r => r.estado !== 'RECHAZADO')
  const sum = xs => r2(xs.reduce((s, r) => s + (r.monto_pen ?? 0), 0))
  const by = key => {
    const m = new Map()
    for (const r of ok) { const k = key(r) ?? '(sin dato)'; const v = m.get(k) ?? { registros: 0, monto: 0, activos: new Set() }; v.registros++; v.monto += r.monto_pen ?? 0; v.activos.add(norm(r.activo_original)); m.set(k, v) }
    return Object.fromEntries([...m].sort().map(([k, v]) => [k, { registros: v.registros, monto: r2(v.monto), activos: v.activos.size }]))
  }
  const win = ok.filter(r => r.fecha && r.fecha >= '2024-07-01' && r.fecha <= '2026-06-30')
  const eq = win.filter(r => /MONTACARGA|ELEVACI/.test(norm(r.clase_activo) || ''))
  const eqCorr = eq.filter(r => r.tipo === 'CORRECTIVO')
  const withTipo = ok.some(r => r.tipo)
  return {
    registros: ok.length, monto: sum(ok), activos: new Set(ok.map(r => norm(r.activo_original))).size,
    desde: ok.map(r => r.fecha).filter(Boolean).sort()[0] ?? null, hasta: ok.map(r => r.fecha).filter(Boolean).sort().at(-1) ?? null,
    por_clase: by(r => r.clase_activo), por_anio: by(r => r.fecha?.slice(0, 4)),
    ventana_2024_07_2026_06: { registros: win.length, monto: sum(win) },
    equipos_ventana: { registros: eq.length, monto: sum(eq), pct_correctivo: withTipo && sum(eq) ? r2(sum(eqCorr) / sum(eq) * 100) : null,
      nota: withTipo ? 'Según TIPO_MANTTO corregido' : 'Requiere TIPO_MANTTO corregido (Excel v5)' },
  }
}

/** Controles de aceptación del Excel v5 (Paso 5 del requerimiento) */
const CONTROLES = [
  { id: 'registros', label: 'Registros', esperado: 1903, get: t => t.registros },
  { id: 'monto', label: 'Monto total (S/)', esperado: 1206227.80, get: t => t.monto },
  { id: 'vehicular', label: 'Unidad vehicular: registros / monto', esperado: '1122 / 644171.04', get: t => fmtPair(pick(t.por_clase, 'UNIDAD VEHICULAR')) },
  { id: 'montacarga', label: 'Montacarga: registros / monto', esperado: '674 / 396319.6', get: t => fmtPair(pick(t.por_clase, 'MONTACARGA')) },
  { id: 'elevacion', label: 'Equipo de elevación: registros / monto', esperado: '107 / 165737.16', get: t => fmtPair(pick(t.por_clase, 'EQUIPO DE ELEVACION')) },
  { id: 'ventana', label: 'Ventana jul-2024 a jun-2026', esperado: '598 / 464610.47', get: t => `${t.ventana_2024_07_2026_06.registros} / ${t.ventana_2024_07_2026_06.monto}` },
  { id: 'equipos', label: 'Montacargas + elevación en la ventana', esperado: '250 / 197432', get: t => `${t.equipos_ventana.registros} / ${Math.round(t.equipos_ventana.monto)}` },
  { id: 'equipos_corr', label: '% correctivo (montacargas + elevación, ventana)', esperado: 84, get: t => t.equipos_ventana.pct_correctivo === null ? null : Math.round(t.equipos_ventana.pct_correctivo) },
]
const pick = (o, k) => Object.entries(o).find(([n]) => norm(n) === norm(k))?.[1]
const fmtPair = v => v ? `${v.registros} / ${v.monto}` : '—'
function controles(t) {
  return CONTROLES.map(c => { const obtenido = c.get(t); return { ...c, get: undefined, obtenido, ok: obtenido === null ? null : String(obtenido) === String(c.esperado) } })
}

function markdownReport(res, extra = {}) {
  const { parsed, totales, grupos } = res
  const L = []
  L.push(`# Importación de mantenimiento — ${extra.modo === 'APLICAR' ? 'aplicada' : 'simulación (dry run)'}`, '')
  L.push(`Archivo: ${extra.archivo ?? '—'} · hoja ${parsed.sheet} (encabezado en la fila ${parsed.headerRow}) · ${new Date().toISOString()}`, '')
  if (parsed.missingV5.length) L.push(`> Formato anterior al v5: faltan ${parsed.missingV5.join(', ')}. TIPO_MANTTO se toma como TIPO_ORIGEN y el tipo corregido queda vacío.`, '')
  const est = s => parsed.rows.filter(r => r.estado === s).length
  L.push(`Filas leídas: ${parsed.rows.length} · aceptadas: ${est('OK')} · dudosas (se cargan): ${est('DUDOSO')} · rechazadas: ${est('RECHAZADO')}`, '')
  if (extra.db) L.push(`Base: insertados ${extra.db.insertados}, actualizados ${extra.db.actualizados}, sin cambio ${extra.db.sin_cambio}`, '')
  L.push('## Controles de aceptación', '', '| Control | Esperado | Obtenido | Estado |', '|---|---|---|---|')
  for (const c of controles(totales)) L.push(`| ${c.label} | ${c.esperado} | ${c.obtenido ?? 'no disponible'} | ${c.ok === null ? 'pendiente' : c.ok ? 'OK' : 'DIFERENCIA'} |`)
  if (extra.cuadreBase) {
    L.push('', '## Cuadre contra la base', '', '| Concepto | Excel | Base | Estado |', '|---|---|---|---|')
    for (const c of extra.cuadreBase) L.push(`| ${c.concepto} | ${c.excel} | ${c.base} | ${c.ok ? 'OK' : 'DIFERENCIA'} |`)
  }
  L.push('', '## Por clase de activo', '', '| Clase | Activos | Registros | Monto |', '|---|---|---|---|')
  for (const [k, v] of Object.entries(totales.por_clase)) L.push(`| ${k} | ${v.activos} | ${v.registros} | ${v.monto.toFixed(2)} |`)
  L.push('', '## Por año', '', '| Año | Registros | Monto |', '|---|---|---|')
  for (const [k, v] of Object.entries(totales.por_anio)) L.push(`| ${k} | ${v.registros} | ${v.monto.toFixed(2)} |`)
  L.push('', '## Proveedores agrupados (revisar)', '')
  for (const g of grupos.filter(x => x.miembros.length > 1)) L.push(`- **${g.canonico}** ← ${g.miembros.filter(m => m !== g.canonico).join(' · ')} (${g.fuente})`)
  L.push('', '## Registros rechazados y dudosos', '', '| Fila | Activo | Fecha | Monto | Estado | Motivo |', '|---|---|---|---|---|---|')
  for (const r of parsed.rows.filter(x => x.estado !== 'OK')) L.push(`| ${r.fila} | ${r.activo_original ?? '—'} | ${r.fecha ?? '—'} | ${r.monto ?? '—'} | ${r.estado} | ${r.motivos.join('; ')} |`)
  const faltan = {}
  for (const r of parsed.rows) for (const f of r.faltantes) faltan[f] = (faltan[f] ?? 0) + 1
  L.push('', '## Datos faltantes (se dejan vacíos)', '', ...Object.entries(faltan).map(([k, v]) => `- ${k}: ${v} registro(s)`))
  L.push('', '- IGV: el Excel no indica si los montos incluyen IGV; queda «desconocido» en todos los registros.')
  return L.join('\n')
}

function analyze(buf, opt = {}) {
  const parsed = parseWorkbook(buf, opt)
  const grupos = groupProviders(parsed.rows.map(r => r.proveedor_original), opt.equivalencias?.proveedores ?? {})
  return { parsed, totales: totals(parsed.rows), grupos }
}

module.exports = { norm, keyText, fnv, parseWorkbook, buildRecord, markDuplicates, tipoViolacion, groupProviders, totals, controles, markdownReport, analyze, OBS_MEDIDOR, COLS }
