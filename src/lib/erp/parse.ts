import * as XLSX from 'xlsx'

// Lectura de los dos Excel conectados al ERP (Power Query sobre FLEXLINE). Sin DOM: se usa en el navegador (worker) y en
// pruebas con node.
//  * Actualizable Despacho (usp_Rpt_ChecklistContratosListado): una fila por línea de OT o subcontrato con cantidades
//    de contrato, despachada y pendiente, y cada despacho en Guia_n / Cant_Guia_n (más «Guias_Adicionales»).
//  * Stock Bodega Despacho (usp_Rpt_StockBodegasListado): stock por bodega, producto y lote (el lote es la OT o el
//    subcontrato).

export type ErpKind = 'CONTRATOS' | 'STOCK'
export const ERP_KIND_LABEL: Record<ErpKind, string> = { CONTRATOS: 'Actualizable Despacho (contratos y guías)', STOCK: 'Stock Bodega Despacho' }

export interface ErpGuia { g: string; c: number; p: number }
export type ErpRow = Record<string, string | number | null | ErpGuia[]>

export interface ErpParsedFile {
  kind: ErpKind
  fileName: string
  sheetName: string
  rows: ErpRow[]
  cutAt: string | null
  stats: Record<string, number>
  warnings: string[]
}

export interface ErpParseResult { files: ErpParsedFile[]; errors: string[] }
export interface ErpInputFile { name: string; data: ArrayBuffer | Uint8Array }

const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s_./-]+/g, '').toLowerCase()
const pad = (n: number) => String(n).padStart(2, '0')

function isoDate(v: unknown): string | null {
  if (v instanceof Date) return isNaN(v.getTime()) ? null : `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`
  if (typeof v === 'string') {
    const t = v.trim()
    if (/^\d{4}-\d{2}-\d{2}/.test(t)) return t.slice(0, 10)
    const m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
    if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`
  }
  if (typeof v === 'number' && v > 0) {
    const p = XLSX.SSF.parse_date_code(v)
    if (p?.y) return `${p.y}-${pad(p.m)}-${pad(p.d)}`
  }
  return null
}

// Hora de actualización del ERP (hora de Lima)
function isoStamp(v: unknown): string | null {
  if (v instanceof Date && !isNaN(v.getTime())) {
    return `${isoDate(v)}T${pad(v.getHours())}:${pad(v.getMinutes())}:${pad(v.getSeconds())}-05:00`
  }
  const d = isoDate(v)
  return d ? `${d}T00:00:00-05:00` : null
}

function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const t = v.trim().replace(/,/g, '')
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null
  }
  return null
}

// Texto: los enteros de Excel pierden el «.0» (Lote 15617, RUC 20100617332)
function text(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return isoDate(v)
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null
  const t = String(v).trim()
  return t ? t : null
}

const CONTRATO_COLS = {
  nro_contrato: 'nrocontrato', nro_documento: 'nrodocumento', tipo_documento: 'tipodocumento', correlativo: 'correlativo', secuencia: 'secuencia',
  fecha_contrato: 'fechacontrato', fecha_vcto: 'fechavcto', vigencia: 'vigenciacontrato', ruc: 'ruccliente', cliente: 'cliente',
  cod_producto: 'codproducto', producto: 'producto', color: 'color', unidad: 'unidad', cant_contrato: 'cantcontrato',
  cant_despachada: 'cantdespachada', cant_reemplazada: 'cantreemplazada', cant_pendiente: 'cantpendiente', estado: 'estado',
  nro_guias: 'nroguias', fecha_ult_despacho: 'fechaultdespacho', tipo_producto: 'tipoproducto', tipo: 'tipo', familia: 'familia',
  subfamilia: 'subfamilia', guias_adicionales: 'guiasadicionales', fecha_actualizacion: 'fechaactualizacion',
} as const
const STOCK_COLS = {
  bodega: 'bodega', cod_producto: 'codproducto', producto: 'producto', tipo_producto: 'tipoproducto', unidad: 'unidad', lote: 'lote',
  stock: 'stock', stock_falla: 'stockfalla', stock_comprometido: 'stockcomprometido', requerimiento: 'requerimiento',
  orden_compra: 'ordencompra', peso_unitario: 'pesounitario', peso_total: 'pesototal', familia: 'familia', subfamilia: 'subfamilia',
  fecha_actualizacion: 'fechaactualizacion',
} as const
const CONTRATO_DATES = new Set(['fecha_contrato', 'fecha_vcto', 'fecha_ult_despacho'])
const CONTRATO_NUMS = new Set(['secuencia', 'correlativo', 'cant_contrato', 'cant_despachada', 'cant_reemplazada', 'cant_pendiente', 'nro_guias'])
const STOCK_NUMS = new Set(['stock', 'stock_falla', 'stock_comprometido', 'requerimiento', 'orden_compra', 'peso_unitario', 'peso_total'])

// «T001-00001564 (1280.00), T001-00001573 (1248.00)»
export function parseGuiasAdicionales(v: unknown): Array<{ g: string; c: number }> {
  const t = text(v)
  if (!t) return []
  return [...t.matchAll(/([A-Za-z0-9]+-\d+)\s*\(\s*(-?[\d.,]+)\s*\)/g)].map(m => ({ g: m[1].toUpperCase(), c: Number(m[2].replace(/,/g, '')) }))
}

const near = (a: number, b: number) => Math.abs(a - b) < 1e-4 * Math.max(1, Math.abs(a), Math.abs(b))

function headerIndex(head: unknown[]) {
  const idx = new Map<string, number>()
  head.forEach((h, i) => { const k = norm(h); if (k && !idx.has(k)) idx.set(k, i) })
  return idx
}

function detect(idx: Map<string, number>): ErpKind | null {
  if (idx.has('nrodocumento') && idx.has('cantpendiente') && idx.has('codproducto')) return 'CONTRATOS'
  if (idx.has('bodega') && idx.has('stock') && idx.has('lote') && idx.has('codproducto')) return 'STOCK'
  return null
}

function guiaCols(idx: Map<string, number>) {
  const out: Array<{ g: number; c: number; p: number }> = []
  for (let n = 1; n <= 50; n++) {
    const g = idx.get(`guia${n}`), c = idx.get(`cantguia${n}`)
    if (g !== undefined && c !== undefined) out.push({ g, c, p: n })
  }
  return out
}

export function parseErpSheet(fileName: string, sheetName: string, aoa: unknown[][]): ErpParsedFile | null {
  const hi = aoa.findIndex(r => r && detect(headerIndex(r)))
  if (hi < 0) return null
  const idx = headerIndex(aoa[hi])
  const kind = detect(idx)!
  const cols = kind === 'CONTRATOS' ? CONTRATO_COLS : STOCK_COLS
  const at = (r: unknown[], key: string) => { const i = idx.get((cols as Record<string, string>)[key]); return i === undefined ? null : r[i] }
  const rows: ErpRow[] = []
  const warnings: string[] = []
  const stats: Record<string, number> = {}
  const bump = (k: string, n = 1) => { stats[k] = (stats[k] || 0) + n }
  let cutAt: string | null = null
  const gcols = kind === 'CONTRATOS' ? guiaCols(idx) : []
  const seen = new Set<string>()

  for (let i = hi + 1; i < aoa.length; i++) {
    const r = aoa[i]
    if (!r || r.every(v => v === null || v === '')) continue
    const stamp = isoStamp(at(r, 'fecha_actualizacion'))
    if (stamp && (!cutAt || stamp > cutAt)) cutAt = stamp
    if (kind === 'CONTRATOS') {
      // linea = fila del Excel (trazabilidad hasta el origen)
      const row: ErpRow = { linea: i + 1 }
      for (const key of Object.keys(CONTRATO_COLS) as Array<keyof typeof CONTRATO_COLS>) {
        if (key === 'guias_adicionales' || key === 'fecha_actualizacion') continue
        const v = at(r, key)
        row[key] = CONTRATO_DATES.has(key) ? isoDate(v) : CONTRATO_NUMS.has(key) ? num(v) : text(v)
      }
      if (!row.nro_documento || row.secuencia === null || !row.cod_producto) { bump('descartadas'); continue }
      const key = `${row.nro_documento}|${row.secuencia}`
      if (seen.has(key)) { bump('duplicadas'); continue }
      seen.add(key)
      const guias: ErpGuia[] = []
      for (const c of gcols) {
        const g = text(r[c.g]), q = num(r[c.c])
        if (g && q !== null) guias.push({ g: g.toUpperCase(), c: q, p: c.p })
      }
      parseGuiasAdicionales(at(r, 'guias_adicionales')).forEach((g, j) => guias.push({ ...g, p: 100 + j }))
      // Una guía repetida en la misma línea se suma (no debería ocurrir)
      const merged = new Map<string, ErpGuia>()
      for (const g of guias) { const m = merged.get(g.g); if (m) m.c += g.c; else merged.set(g.g, { ...g }) }
      row.guias = [...merged.values()]
      const total = row.guias.reduce((s, g) => s + g.c, 0)
      if (row.nro_guias !== null && row.nro_guias !== row.guias.length) bump('nro_guias_distinto')
      if (!near(total, Number(row.cant_despachada || 0))) bump('guias_no_cuadran')
      if (Number(row.cant_pendiente) < 0) bump('sobredespacho')
      // Dato ausente ≠ cero: la base guarda 0, pero se cuenta y se marca la línea
      if (['cant_contrato', 'cant_despachada', 'cant_reemplazada', 'cant_pendiente'].some(k => row[k] === null)) { bump('cantidades_ausentes'); row.cantidades_ausentes = 1 }
      bump('lineas'); bump('despachos', row.guias.length)
      rows.push(row)
    } else {
      const row: ErpRow = { linea: i + 1 }
      for (const key of Object.keys(STOCK_COLS) as Array<keyof typeof STOCK_COLS>) {
        if (key === 'fecha_actualizacion') continue
        const v = at(r, key)
        row[key] = STOCK_NUMS.has(key) ? num(v) : text(v)
      }
      if (!row.bodega || !row.cod_producto) { bump('descartadas'); continue }
      if (!row.lote) bump('sin_lote')
      if (Number(row.stock) < 0) bump('stock_negativo')
      bump('lotes'); bump('kg', Number(row.peso_total || 0))
      rows.push(row)
    }
  }
  if (stats.duplicadas) warnings.push(`${stats.duplicadas} línea(s) repetidas (mismo documento y secuencia) se omitieron.`)
  if (stats.descartadas) warnings.push(`${stats.descartadas} fila(s) sin documento, secuencia, bodega o producto se omitieron.`)
  if (stats.nro_guias_distinto) warnings.push(`${stats.nro_guias_distinto} línea(s) donde «Nro_Guias» no coincide con las guías escritas.`)
  if (stats.guias_no_cuadran) warnings.push(`${stats.guias_no_cuadran} línea(s) donde la suma de las guías no cuadra con la cantidad despachada.`)
  if (stats.cantidades_ausentes) warnings.push(`${stats.cantidades_ausentes} línea(s) sin alguna cantidad (contratada, despachada, reemplazada o pendiente): quedan marcadas como dato ausente.`)
  if (stats.sobredespacho) warnings.push(`${stats.sobredespacho} línea(s) con más despachado que contratado (pendiente negativo).`)
  if (stats.stock_negativo) warnings.push(`${stats.stock_negativo} lote(s) con stock negativo.`)
  if (stats.sin_lote) warnings.push(`${stats.sin_lote} fila(s) de stock sin lote: no se pueden asociar a una OT.`)
  if (!cutAt) warnings.push('El archivo no trae «Fecha_Actualizacion»: se usará la hora de la carga.')
  return { kind, fileName, sheetName, rows, cutAt, stats, warnings }
}

export function parseErpWorkbooks(files: ErpInputFile[], onProgress?: (m: string) => void): ErpParseResult {
  const out: ErpParsedFile[] = []
  const errors: string[] = []
  for (const f of files) {
    onProgress?.(`Leyendo ${f.name}…`)
    const wb = XLSX.read(f.data, { type: 'array', cellDates: true, dense: true })
    let found = false
    for (const sheetName of wb.SheetNames) {
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheetName], { header: 1, raw: true, defval: null, blankrows: false })
      const part = parseErpSheet(f.name, sheetName, aoa)
      if (part) { out.push(part); found = true }
    }
    if (!found) errors.push(`${f.name}: no se reconoce como Actualizable Despacho ni como Stock Bodega Despacho (faltan columnas Nro_Documento/Cant_Pendiente o Bodega/Stock/Lote).`)
  }
  for (const kind of ['CONTRATOS', 'STOCK'] as const) {
    if (out.filter(p => p.kind === kind).length > 1) errors.push(`Se seleccionó más de un archivo de ${ERP_KIND_LABEL[kind]}: elija solo el más reciente.`)
  }
  return { files: out, errors }
}
