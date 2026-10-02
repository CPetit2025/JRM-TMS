import * as XLSX from 'xlsx'

// Lectura de los libros del ERP (ENTRADA = P/E Producción, SALIDA = Despacho Ventas) para la carga de APT.
// Sin dependencias del DOM: se usa en el navegador (worker o hilo principal) y en pruebas con node.

export type AptSheetKind = 'ENTRADA' | 'SALIDA'
export type AptRow = Record<string, unknown> & { __row: number }

export interface AptSheetStats {
  filas: number
  validas: number            // con fecha y producto (las demás se guardan como excluidas)
  sinFecha: number
  sinProducto: number
  desde: string | null       // rango de fechas de las filas válidas (el que se reemplaza)
  hasta: string | null
  tn: number                 // Σ |PesoTotalProduccido| / 1000 de las filas válidas
  sinPeso: number
  totalizadoras: number      // filas sin fecha ni producto (fila de totales o vacía)
}

export interface AptParsedSheet {
  kind: AptSheetKind
  fileName: string
  sheetName: string
  detectedBy: 'nombre' | 'encabezados'
  headerRow: number
  headers: string[]
  rows: AptRow[]
  stats: AptSheetStats
}

export interface AptParseResult {
  sheets: AptParsedSheet[]
  ignored: Array<{ fileName: string; sheetName: string; reason: string }>
  warnings: string[]
}

export interface AptInputFile { name: string; data: ArrayBuffer | Uint8Array }

// Columnas que usa SQL (apt_upload_rows): si el encabezado difiere solo en mayúsculas/espacios se usa este nombre
export const APT_CANONICAL = ['TIPODOCTO', 'BODEGA', 'Numero', 'Fecha', 'CodLegal', 'RazonSocial', 'Producto', 'GLOSA', 'Cantidad',
  'UNIDAD', 'DocRel', 'NumRel', 'FechaEntrega', 'Lote', 'Comentario', 'PesoUnitario', 'PesoTotalProduccido'] as const
const REQUIRED = ['Fecha', 'Producto', 'NumRel', 'PesoTotalProduccido']
const HEADER_KEYS = ['producto', 'numrel', 'pesototalproduccido']
// Hojas de análisis que acompañan al libro y nunca son movimientos
const AUX_SHEET = /^(BASE[ _-]|RESUMEN|LOTES|DETALLE|FAMILIAS|MENSUAL|CALIDAD|PARAMETROS|PARÁMETROS)/i

const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s_]+/g, '').toLowerCase()
const CANON_BY_NORM = new Map<string, string>(APT_CANONICAL.map(c => [norm(c), c]))

function kindByName(name: string): AptSheetKind | null {
  const n = norm(name).toUpperCase()
  return n === 'ENTRADA' ? 'ENTRADA' : n === 'SALIDA' ? 'SALIDA' : null
}

// xlsx 0.18 construye las fechas con el desfase horario histórico de 1899 (en algunos husos queda en el día anterior).
// Se reconstruye el número de serie de Excel con la misma fórmula de la librería y se lee la fecha calendario.
const BASE_DATE = new Date(1899, 11, 30, 0, 0, 0)
const DNTHRESH = BASE_DATE.getTime() + (new Date().getTimezoneOffset() - BASE_DATE.getTimezoneOffset()) * 60000
const pad = (n: number) => String(n).padStart(2, '0')
function dateToIso(d: Date, date1904: boolean): string | null {
  if (isNaN(d.getTime())) return null
  let serial = (d.getTime() - DNTHRESH) / 86400000
  if (serial <= 60) serial -= 1
  const p = XLSX.SSF.parse_date_code(serial, { date1904 })
  if (!p || !p.y) return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
  return `${p.y}-${pad(p.m)}-${pad(p.d)}`
}

function cellValue(v: unknown, date1904: boolean): unknown {
  if (v === null || v === undefined) return undefined
  if (v instanceof Date) return dateToIso(v, date1904) ?? undefined
  if (typeof v === 'string') {
    const t = v.trim()
    return t === '' ? undefined : t
  }
  if (typeof v === 'number') return Number.isFinite(v) ? v : undefined
  return v
}

function isoOf(v: unknown): string | null {
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}/.test(v)) return v.slice(0, 10)
  if (typeof v === 'string') {
    const m = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/)
    if (m) return `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`
  }
  if (typeof v === 'number' && v > 0) {
    const p = XLSX.SSF.parse_date_code(v)
    if (p?.y) return `${p.y}-${pad(p.m)}-${pad(p.d)}`
  }
  return null
}

function numOf(v: unknown): number | null {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && /^-?\d+(\.\d+)?$/.test(v.trim())) return Number(v.trim())
  return null
}

function findHeaderRow(aoa: unknown[][]): number {
  for (let i = 0; i < Math.min(10, aoa.length); i++) {
    const cells = new Set((aoa[i] || []).map(norm))
    if (HEADER_KEYS.every(k => cells.has(k))) return i
  }
  return -1
}

// Encabezados de la hoja: originales (trim), canónicos para las columnas de SQL, sin vacíos ni repetidos
function buildHeaders(raw: unknown[]): Array<string | null> {
  const used = new Set<string>()
  return raw.map(h => {
    const t = String(h ?? '').trim()
    if (!t) return null
    let key = CANON_BY_NORM.get(norm(t)) ?? t
    if (used.has(key)) {
      let i = 2
      while (used.has(`${key} (${i})`)) i++
      key = `${key} (${i})`
    }
    used.add(key)
    return key
  })
}

function kindByContent(headers: Array<string | null>, body: unknown[][]): AptSheetKind | null {
  const col = (name: string) => headers.findIndex(h => h !== null && norm(h) === norm(name))
  const iTipo = col('TIPODOCTO')
  const sample = body.slice(0, 200)
  if (iTipo >= 0) {
    for (const r of sample) {
      const t = String(r?.[iTipo] ?? '').toUpperCase()
      if (t.includes('DESPACHO')) return 'SALIDA'
      if (/P\s*\/\s*E\s*PRODUCCION/.test(t.normalize('NFD').replace(/[̀-ͯ]/g, ''))) return 'ENTRADA'
    }
  }
  for (const name of ['Cantidad 2', 'CodLegal']) {
    const i = col(name)
    if (i >= 0 && sample.some(r => r?.[i] !== null && r?.[i] !== undefined && String(r[i]).trim() !== '')) return 'SALIDA'
  }
  return null
}

function parseSheet(ws: XLSX.WorkSheet, date1904: boolean, fileName: string, sheetName: string, byName: AptSheetKind | null) {
  const ref = ws['!ref']
  if (!ref) return { skip: 'Hoja vacía' as const }
  const start = XLSX.utils.decode_range(ref).s.r
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: true })
  const h = findHeaderRow(aoa)
  if (h < 0) {
    if (byName) {
      throw new Error(`La hoja ${sheetName} (${fileName}) no tiene en sus primeras 10 filas los encabezados Producto, NumRel y PesoTotalProduccido.`)
    }
    return { skip: 'Sin encabezados de movimientos' as const }
  }
  const headers = buildHeaders(aoa[h] || [])
  const missing = REQUIRED.filter(c => !headers.includes(c))
  if (missing.length) {
    throw new Error(`La hoja ${sheetName} (${fileName}) no tiene las columnas: ${missing.join(', ')}.`)
  }
  const body = aoa.slice(h + 1)
  const kind = byName ?? kindByContent(headers, body)
  if (!kind) return { skip: 'No se pudo determinar si es ENTRADA o SALIDA (TIPODOCTO sin “P/E PRODUCCION” ni “DESPACHO”)' as const }

  const rows: AptRow[] = []
  const stats: AptSheetStats = { filas: 0, validas: 0, sinFecha: 0, sinProducto: 0, desde: null, hasta: null, tn: 0, sinPeso: 0, totalizadoras: 0 }
  let kg = 0
  body.forEach((r, i) => {
    if (!r) return
    const obj: Record<string, unknown> = {}
    let any = false
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c]
      if (!key) continue
      const v = cellValue(r[c], date1904)
      if (v === undefined) continue
      obj[key] = v
      any = true
    }
    if (!any) return
    const row = obj as AptRow
    row.__row = start + h + 2 + i
    rows.push(row)

    const fecha = isoOf(row.Fecha)
    const producto = row.Producto !== undefined && String(row.Producto).trim() !== ''
    if (!fecha) stats.sinFecha++
    if (!producto) stats.sinProducto++
    if (!fecha && !producto) stats.totalizadoras++
    if (fecha && producto) {
      stats.validas++
      if (!stats.desde || fecha < stats.desde) stats.desde = fecha
      if (!stats.hasta || fecha > stats.hasta) stats.hasta = fecha
      const peso = numOf(row.PesoTotalProduccido)
      if (peso === null || peso === 0) stats.sinPeso++
      else kg += Math.abs(peso)
    }
  })
  stats.filas = rows.length
  stats.tn = Math.round(kg) / 1000
  const sheet: AptParsedSheet = {
    kind, fileName, sheetName, detectedBy: byName ? 'nombre' : 'encabezados', headerRow: start + h + 1,
    headers: headers.filter((x): x is string => !!x), rows, stats,
  }
  return { sheet }
}

export function parseWorkbooks(files: AptInputFile[], onProgress?: (msg: string) => void): AptParseResult {
  const found: AptParsedSheet[] = []
  const ignored: AptParseResult['ignored'] = []
  const warnings: string[] = []

  for (const f of files) {
    const data = f.data instanceof Uint8Array ? f.data : new Uint8Array(f.data)
    onProgress?.(`Leyendo ${f.name}…`)
    let names: string[]
    try {
      names = XLSX.read(data, { type: 'array', bookSheets: true }).SheetNames
    } catch {
      throw new Error(`No se pudo abrir ${f.name}: no parece un libro de Excel válido.`)
    }
    // Si el libro trae ENTRADA y SALIDA por nombre, solo se leen esas dos (las hojas de análisis pesan mucho)
    const named = names.filter(n => kindByName(n))
    const namedKinds = new Set(named.map(kindByName))
    const candidates = namedKinds.size === 2 ? named : names.filter(n => kindByName(n) || !AUX_SHEET.test(n.trim()))
    names.filter(n => !candidates.includes(n)).forEach(n => ignored.push({ fileName: f.name, sheetName: n, reason: 'Hoja auxiliar de análisis' }))
    if (!candidates.length) continue

    const wb = XLSX.read(data, { type: 'array', cellDates: true, sheets: candidates })
    const date1904 = !!wb.Workbook?.WBProps?.date1904
    for (const n of candidates) {
      const ws = wb.Sheets[n]
      if (!ws) continue
      onProgress?.(`Procesando hoja ${n}…`)
      const res = parseSheet(ws, date1904, f.name, n, kindByName(n))
      if ('skip' in res && res.skip) ignored.push({ fileName: f.name, sheetName: n, reason: res.skip })
      else if (res.sheet) found.push(res.sheet)
    }
  }

  // Una hoja por tipo: la detectada por nombre manda sobre la detectada por encabezados
  const sheets: AptParsedSheet[] = []
  for (const kind of ['ENTRADA', 'SALIDA'] as const) {
    const all = found.filter(s => s.kind === kind)
    const byName = all.filter(s => s.detectedBy === 'nombre')
    if (byName.length > 1) {
      throw new Error(`Hay más de una hoja ${kind}: ${byName.map(s => `${s.sheetName} (${s.fileName})`).join(', ')}. Seleccione un solo archivo por tipo.`)
    }
    const pick = byName[0] ?? all[0]
    if (!pick) continue
    if (!byName.length && all.length > 1) {
      throw new Error(`Se reconocieron varias hojas como ${kind}: ${all.map(s => `${s.sheetName} (${s.fileName})`).join(', ')}. Renombre la correcta como “${kind}”.`)
    }
    all.filter(s => s !== pick).forEach(s => ignored.push({ fileName: s.fileName, sheetName: s.sheetName, reason: `Se usa la hoja ${pick.sheetName} como ${kind}` }))
    if (pick.stats.validas === 0) warnings.push(`La hoja ${pick.sheetName} (${kind}) no tiene filas con fecha y producto.`)
    sheets.push(pick)
  }
  if (!sheets.length) {
    throw new Error('No se encontró ninguna hoja ENTRADA ni SALIDA. El archivo debe tener las hojas “ENTRADA” y/o “SALIDA” del ERP, o columnas Producto, NumRel y PesoTotalProduccido.')
  }
  if (!sheets.some(s => s.kind === 'ENTRADA')) warnings.push('Solo se cargará SALIDA: no se encontró una hoja de ENTRADA.')
  if (!sheets.some(s => s.kind === 'SALIDA')) warnings.push('Solo se cargará ENTRADA: no se encontró una hoja de SALIDA.')
  return { sheets, ignored, warnings }
}
