import * as XLSX from 'xlsx'

import type { AptUploadKind } from './api'

// Lectura de los libros del ERP para la carga de APT. Cada fila se enruta por TIPODOCTO y el signo de Cantidad:
// ENTRADA = P/E Producción, SALIDA = Despacho Ventas, traspasos (lado origen / destino), consumos internos y devoluciones.
// Sin dependencias del DOM: se usa en el navegador (worker o hilo principal) y en pruebas con node.

export type AptSheetKind = AptUploadKind
export const APT_KINDS: readonly AptSheetKind[] = ['ENTRADA', 'SALIDA', 'TRASPASO_SAL', 'TRASPASO_ENT', 'CONSUMO', 'DEVOLUCION']
export const APT_KIND_LABEL: Record<AptSheetKind, string> = {
  ENTRADA: 'ENTRADA producción', SALIDA: 'SALIDA guías', TRASPASO_SAL: 'Traspasos (salidas)',
  TRASPASO_ENT: 'Traspasos (entradas)', CONSUMO: 'Consumos internos', DEVOLUCION: 'Devoluciones',
}
export const MOTIVO_FUERA_APT = 'Bodega fuera de APT'
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
  fueraApt: number           // filas de este tipo descartadas por estar en una bodega que no es 647, 540 ni ST VENTAS
  descartadas: Record<string, number>  // filas de este tipo que no se envían, por motivo
}

export interface AptParsedSheet {
  kind: AptSheetKind
  fileName: string
  sheetName: string
  detectedBy: 'nombre' | 'encabezados' | 'tipodocto'
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
  'UNIDAD', 'DocRel', 'NumRel', 'FechaEntrega', 'Contrato', 'Lote', 'Comentario', 'PesoUnitario', 'PesoTotalProduccido'] as const
const REQUIRED = ['Fecha', 'Producto', 'NumRel', 'PesoTotalProduccido']
const HEADER_KEYS = ['producto', 'numrel', 'pesototalproduccido']
// Hojas de análisis que acompañan al libro y nunca son movimientos
const AUX_SHEET = /^(BASE[ _-]|RESUMEN|LOTES|DETALLE|FAMILIAS|MENSUAL|CALIDAD|PARAMETROS|PARÁMETROS)/i
// Hojas de traspasos o de totales: se leen aunque el libro ya traiga ENTRADA y SALIDA por nombre
const EXTRA_SHEET = /TRASPAS|TRANSF|TRANF|TRAFER|TOTAL|^\s*(ENTRADAS|SALIDAS)\s*$/i

const norm = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s_]+/g, '').toLowerCase()
const CANON_BY_NORM = new Map<string, string>(APT_CANONICAL.map(c => [norm(c), c]))

function kindByName(name: string): AptSheetKind | null {
  const n = norm(name).toUpperCase()
  return n === 'ENTRADA' ? 'ENTRADA' : n === 'SALIDA' ? 'SALIDA' : null
}

// SheetJS 0.20 resolves the workbook epoch (1900/1904) while creating Date cells.
// Preserve that local calendar date; the old 0.18 offset workaround shifted dates in Peru.
const pad = (n: number) => String(n).padStart(2, '0')
function dateToIso(d: Date): string | null {
  if (isNaN(d.getTime())) return null
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function cellValue(v: unknown): unknown {
  if (v === null || v === undefined) return undefined
  if (v instanceof Date) return dateToIso(v) ?? undefined
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

// Almacén APT de una bodega (mismas reglas que public.apt_almacen): 647-04 ALM PT, 540-04 APT LB / APT.MAT.CONFO, ST-VENTAS-IMD
const normBodega = (v: unknown) => String(v ?? '').replace(/\s+/g, ' ').trim().toUpperCase()
export function aptAlmacen(bodega: unknown): '647' | '540' | 'ST' | null {
  const b = normBodega(bodega)
  if (/^647-04\s/.test(b)) return '647'
  if (/^540-04/.test(b)) return '540'
  if (/^ST-VENTAS/.test(b)) return 'ST'
  return null
}

// Tipo de movimiento de una fila por su TIPODOCTO (sin tildes, mayúsculas) y el signo de Cantidad
export function kindByTipodocto(tipodocto: unknown, cantidad: number | null): AptSheetKind | null {
  const t = String(tipodocto ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim().toUpperCase()
  if (!t) return null
  if (/^P\s*\/\s*E\b/.test(t)) return 'ENTRADA'
  if (t.includes('DESPACHO')) return 'SALIDA'
  if (t.startsWith('TRASPASO')) return cantidad !== null && cantidad < 0 ? 'TRASPASO_SAL' : 'TRASPASO_ENT'
  if (cantidad === null || cantidad === 0) return null
  return cantidad < 0 ? 'CONSUMO' : 'DEVOLUCION'
}

const emptyStats = (): AptSheetStats => ({
  filas: 0, validas: 0, sinFecha: 0, sinProducto: 0, desde: null, hasta: null, tn: 0, sinPeso: 0, totalizadoras: 0, fueraApt: 0, descartadas: {},
})

type SheetOut = { skip: string } | { parts: AptParsedSheet[]; sinTipo: number }

function parseSheet(ws: XLSX.WorkSheet, fileName: string, sheetName: string, byName: AptSheetKind | null): SheetOut {
  const ref = ws['!ref']
  if (!ref) return { skip: 'Hoja vacía' }
  const start = XLSX.utils.decode_range(ref).s.r
  const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: true })
  const h = findHeaderRow(aoa)
  if (h < 0) {
    if (byName) {
      throw new Error(`La hoja ${sheetName} (${fileName}) no tiene en sus primeras 10 filas los encabezados Producto, NumRel y PesoTotalProduccido.`)
    }
    return { skip: 'Sin encabezados de movimientos' }
  }
  const headers = buildHeaders(aoa[h] || [])
  const missing = REQUIRED.filter(c => !headers.includes(c))
  if (missing.length) {
    throw new Error(`La hoja ${sheetName} (${fileName}) no tiene las columnas: ${missing.join(', ')}.`)
  }
  const body = aoa.slice(h + 1)
  const iTipo = headers.indexOf('TIPODOCTO')
  const iBodega = headers.indexOf('BODEGA')
  const iCant = headers.indexOf('Cantidad')
  // Sin columna TIPODOCTO la hoja entera es ENTRADA o SALIDA (por nombre o por columnas); con ella, cada fila se enruta.
  // Las filas sin TIPODOCTO (totalizadoras) quedan en el tipo de la hoja si se conoce.
  const sheetKind = byName ?? (iTipo < 0 ? kindByContent(headers, body) : null)
  if (iTipo < 0 && !sheetKind) return { skip: 'No se pudo determinar si es ENTRADA o SALIDA (TIPODOCTO sin “P/E PRODUCCION” ni “DESPACHO”)' }

  const acc = new Map<AptSheetKind, { rows: AptRow[]; stats: AptSheetStats; kg: number }>()
  const get = (k: AptSheetKind) => {
    let a = acc.get(k)
    if (!a) acc.set(k, a = { rows: [], stats: emptyStats(), kg: 0 })
    return a
  }
  let sinTipo = 0
  body.forEach((r, i) => {
    if (!r || !r.some(v => v !== null && v !== undefined && String(v).trim() !== '')) return
    const cant = iCant >= 0 ? numOf(r[iCant]) : null
    const tipo = iTipo >= 0 ? r[iTipo] : null
    const kind = (iTipo >= 0 ? kindByTipodocto(tipo, cant) : null) ?? (String(tipo ?? '').trim() === '' ? sheetKind : null)
    if (!kind) { sinTipo++; return }
    const a = get(kind)
    // ENTRADA y SALIDA sin bodega se aceptan (reportes clásicos ya filtrados); con bodega, solo 647, 540 y ST VENTAS
    // (el reporte total de entradas trae producción de otras plantas y almacenes; el de salidas, bodegas de terceros como RINTI).
    // El resto de hojas exige bodega APT.
    {
      const bod = iBodega >= 0 ? r[iBodega] : null
      const hasBod = String(bod ?? '').trim() !== ''
      const clasica = kind === 'ENTRADA' || kind === 'SALIDA'
      if ((!clasica || hasBod) && !aptAlmacen(bod)) {
        a.stats.fueraApt++
        a.stats.descartadas[MOTIVO_FUERA_APT] = (a.stats.descartadas[MOTIVO_FUERA_APT] ?? 0) + 1
        return
      }
    }
    const obj: Record<string, unknown> = {}
    for (let c = 0; c < headers.length; c++) {
      const key = headers[c]
      if (!key) continue
      const v = cellValue(r[c])
      if (v === undefined) continue
      obj[key] = v
    }
    const row = obj as AptRow
    row.__row = start + h + 2 + i
    a.rows.push(row)

    const stats = a.stats
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
      else a.kg += Math.abs(peso)
    }
  })

  const parts: AptParsedSheet[] = []
  for (const kind of APT_KINDS) {
    const a = acc.get(kind)
    if (!a) continue
    a.stats.filas = a.rows.length
    a.stats.tn = Math.round(a.kg) / 1000
    parts.push({
      kind, fileName, sheetName, detectedBy: iTipo < 0 ? (byName ? 'nombre' : 'encabezados') : byName === kind ? 'nombre' : 'tipodocto',
      headerRow: start + h + 1, headers: headers.filter((x): x is string => !!x), rows: a.rows, stats: a.stats,
    })
  }
  return { parts, sinTipo }
}

const where = (s: AptParsedSheet, ref: AptParsedSheet) => (s.fileName === ref.fileName ? s.sheetName : `${s.sheetName} (${s.fileName})`)

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
    // y, además, las de traspasos o totales si las hubiera
    const named = names.filter(n => kindByName(n))
    const namedKinds = new Set(named.map(kindByName))
    const candidates = namedKinds.size === 2
      ? names.filter(n => kindByName(n) || (EXTRA_SHEET.test(n) && !AUX_SHEET.test(n.trim())))
      : names.filter(n => kindByName(n) || !AUX_SHEET.test(n.trim()))
    names.filter(n => !candidates.includes(n)).forEach(n => ignored.push({ fileName: f.name, sheetName: n, reason: 'Hoja auxiliar de análisis' }))
    if (!candidates.length) continue

    const wb = XLSX.read(data, { type: 'array', cellDates: true, sheets: candidates })
    for (const n of candidates) {
      const ws = wb.Sheets[n]
      if (!ws) continue
      onProgress?.(`Procesando hoja ${n}…`)
      const res = parseSheet(ws, f.name, n, kindByName(n))
      if ('skip' in res) { ignored.push({ fileName: f.name, sheetName: n, reason: res.skip }); continue }
      const kept = res.parts.filter(p => p.rows.length > 0)
      if (!kept.length) {
        const fuera = res.parts.reduce((t, p) => t + p.stats.fueraApt, 0)
        ignored.push({ fileName: f.name, sheetName: n, reason: fuera ? `Ninguna fila de los almacenes APT (${fuera} fila(s) de otras bodegas)` : 'Sin movimientos reconocibles por TIPODOCTO' })
        continue
      }
      // Un tipo que solo tuvo filas de otras bodegas no se carga, pero se informa
      res.parts.filter(p => p.rows.length === 0 && p.stats.fueraApt > 0).forEach(p =>
        ignored.push({ fileName: f.name, sheetName: n, reason: `${n}: ${p.stats.fueraApt} fila(s) de ${APT_KIND_LABEL[p.kind]} en bodegas fuera de APT` }))
      if (res.sinTipo > 0) warnings.push(`La hoja ${n} (${f.name}) tiene ${res.sinTipo} fila(s) sin TIPODOCTO reconocible (o con Cantidad cero); no se cargan.`)
      found.push(...kept)
    }
  }

  // Un origen por tipo: la hoja detectada por nombre manda; si no, la que aporta más filas (evita duplicar
  // cuando dos reportes traen los mismos movimientos, p. ej. “SALIDA TOTAL” dentro de “ENTRADA TOTAL”)
  const sheets: AptParsedSheet[] = []
  for (const kind of APT_KINDS) {
    const all = found.filter(s => s.kind === kind)
    if (!all.length) continue
    const byName = all.filter(s => s.detectedBy === 'nombre')
    if (byName.length > 1) {
      throw new Error(`Hay más de una hoja ${kind}: ${byName.map(s => `${s.sheetName} (${s.fileName})`).join(', ')}. Seleccione un solo archivo por tipo.`)
    }
    const byHeaders = all.filter(s => s.detectedBy === 'encabezados')
    if (!byName.length && byHeaders.length > 1) {
      throw new Error(`Se reconocieron varias hojas como ${kind}: ${byHeaders.map(s => `${s.sheetName} (${s.fileName})`).join(', ')}. Renombre la correcta como “${kind}”.`)
    }
    const pick = byName[0] ?? all.reduce((a, b) => (b.rows.length > a.rows.length ? b : a))
    all.filter(s => s !== pick).forEach(s => ignored.push({
      fileName: s.fileName, sheetName: s.sheetName,
      reason: pick.detectedBy === 'nombre' && s.detectedBy !== 'tipodocto'
        ? `Se usa la hoja ${pick.sheetName} como ${kind}`
        : `${s.sheetName}: sus filas de ${kind} ya vienen en ${where(pick, s)}`,
    }))
    if (pick.stats.validas === 0) warnings.push(`La hoja ${pick.sheetName} (${APT_KIND_LABEL[kind]}) no tiene filas con fecha y producto.`)
    sheets.push(pick)
  }
  if (!sheets.length) {
    throw new Error('No se encontró ninguna hoja de movimientos. Suba el reporte del ERP con las hojas “ENTRADA” y/o “SALIDA”, o los reportes de traspasos de almacén (salidas y entradas), con columnas Producto, NumRel y PesoTotalProduccido.')
  }
  const has = (k: AptSheetKind) => sheets.some(s => s.kind === k)
  const onlyClassic = sheets.every(s => s.kind === 'ENTRADA' || s.kind === 'SALIDA')
  if (onlyClassic) {
    if (!has('ENTRADA')) warnings.push('Solo se cargará SALIDA: no se encontró una hoja de ENTRADA.')
    if (!has('SALIDA')) warnings.push('Solo se cargará ENTRADA: no se encontró una hoja de SALIDA.')
  }
  if (has('TRASPASO_SAL') && !has('TRASPASO_ENT')) {
    warnings.push('Se cargan traspasos (salidas) sin traspasos (entradas): suba también el reporte de Entradas de traspasos para el mismo rango de fechas, o el traspaso quedará sin destino.')
  }
  if (has('TRASPASO_ENT') && !has('TRASPASO_SAL')) {
    warnings.push('Se cargan traspasos (entradas) sin traspasos (salidas): suba también el reporte de Salidas de traspasos para el mismo rango de fechas, o el traspaso quedará sin origen.')
  }
  return { sheets, ignored, warnings }
}
