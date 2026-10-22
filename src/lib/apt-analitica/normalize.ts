import type { RowStatus, Side, SourceType } from './types'

// Lectura y normalización de los reportes de movimientos del ERP (y de las fuentes adicionales). Sin DOM ni red:
// se usa en el navegador y en las pruebas con node. La fila original se conserva tal cual (`raw`) y aparte se genera
// la capa normalizada (`norm`). Nada se descarta en silencio: una fila con problemas queda RECHAZADA o EN REVISIÓN
// con su motivo.

export const PARSER_VERSION = 'apa-1'

/** Celda tal como la entrega SheetJS (modo denso): valor, texto mostrado, tipo y formato */
export interface Cell { v?: unknown; w?: string; t?: string; z?: string | number }
export type CellRow = Array<Cell | null | undefined>

export const MOVEMENT_COLUMNS = ['TipoDocto', 'Bodega', 'Numero', 'Fecha', 'CodLegal', 'RazonSocial', 'Producto', 'GLOSA', 'Cantidad', 'UNIDAD',
  'DocRel', 'NumRel', 'FechaEntrega', 'Contrato', 'RefTipoDocto', 'RefCorrelativo', 'RefNumero', 'RefFecha', 'Lote', 'Color', 'Comentario',
  'PesoUnitario', 'PesoTotalxProducir', 'PesoTotalProduccido', 'CCostoJRM'] as const
export type MovementColumn = typeof MOVEMENT_COLUMNS[number]

export const EXTRA_COLUMNS: Record<'SALDO_INICIAL' | 'COMPROMISOS' | 'RECEPCIONES', Record<string, string[]>> = {
  SALDO_INICIAL: { Bodega: ['bodega', 'almacen'], Producto: ['producto', 'codigo'], Lote: ['lote'], Unidad: ['unidad', 'um'],
    Cantidad: ['cantidad', 'saldo', 'stock', 'existencia'], FechaCorte: ['fechacorte', 'fecha', 'corte'] },
  COMPROMISOS: { Pedido: ['pedido', 'numeropedido', 'ordenventa'], Linea: ['linea', 'item', 'lineapedido'], Producto: ['producto', 'codigo'],
    Unidad: ['unidad', 'um'], Cantidad: ['cantidad', 'cantidadcomprometida'], FechaCompromiso: ['fechacompromiso', 'fechacomprometida', 'fechaentrega'],
    Version: ['version'], Estado: ['estado'] },
  RECEPCIONES: { Despacho: ['despacho', 'documento', 'numero', 'guia'], Producto: ['producto', 'codigo'], Unidad: ['unidad', 'um'],
    CantidadAceptada: ['cantidadaceptada', 'aceptada', 'cantidad'], CantidadRechazada: ['cantidadrechazada', 'rechazada'],
    FechaRecepcion: ['fecharecepcion', 'fecha'], Motivo: ['motivo', 'observacion'], Pedido: ['pedido'], Linea: ['linea', 'item'] },
}
const EXTRA_REQUIRED: Record<string, string[]> = {
  SALDO_INICIAL: ['Bodega', 'Producto', 'Unidad', 'Cantidad'],
  COMPROMISOS: ['Pedido', 'Linea', 'Producto', 'Unidad', 'Cantidad'],
  RECEPCIONES: ['Despacho', 'Producto', 'Unidad', 'CantidadAceptada', 'FechaRecepcion'],
}
const EXTRA_DATES = new Set(['FechaCorte', 'FechaCompromiso', 'FechaRecepcion'])
const EXTRA_NUMS = new Set(['Cantidad', 'CantidadAceptada', 'CantidadRechazada', 'Version'])

export const normKey = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s_./-]+/g, '').toLowerCase()
const MOV_CANON = new Map<string, MovementColumn>(MOVEMENT_COLUMNS.map(c => [normKey(c), c]))
const pad = (n: number) => String(n).padStart(2, '0')

/** Bodega para agrupar: mayúsculas y espacios simples. El nombre original se conserva aparte. */
export const bodegaKey = (s: string) => s.replace(/\s+/g, ' ').trim().toUpperCase()

// ---------------------------------------------------------------------------------------------------------------
// Conversión de celdas
// ---------------------------------------------------------------------------------------------------------------
export function excelSerialToIso(n: number): string | null {
  if (!Number.isFinite(n) || n < 1 || n > 2958465) return null
  // Excel cuenta el 29/02/1900 inexistente: los seriales ≥ 61 se corrigen un día
  const ms = Math.round((n - (n >= 61 ? 25569 : 25568)) * 86400000)
  const d = new Date(ms)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

const validYmd = (y: number, m: number, d: number) => {
  if (m < 1 || m > 12 || d < 1) return false
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return d <= last
}

/** Fecha ISO (AAAA-MM-DD) o null. `invalid` = había un valor pero no es una fecha. */
export function readDate(c: Cell | null | undefined): { value: string | null; invalid: boolean } {
  const v = c?.v
  if (v === null || v === undefined || (typeof v === 'string' && v.trim() === '')) return { value: null, invalid: false }
  if (v instanceof Date) {
    if (isNaN(v.getTime())) return { value: null, invalid: true }
    return { value: `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`, invalid: false }
  }
  if (typeof v === 'number') {
    const iso = excelSerialToIso(v)
    return iso ? { value: iso, invalid: false } : { value: null, invalid: true }
  }
  const t = String(v).trim()
  let m = t.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/)
  if (m && validYmd(+m[1], +m[2], +m[3])) return { value: `${m[1]}-${pad(+m[2])}-${pad(+m[3])}`, invalid: false }
  m = t.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:\s.*)?$/)
  if (m && validYmd(+m[3], +m[2], +m[1])) return { value: `${m[3]}-${pad(+m[2])}-${pad(+m[1])}`, invalid: false }
  if (/^\d+(\.\d+)?$/.test(t)) { const iso = excelSerialToIso(Number(t)); if (iso) return { value: iso, invalid: false } }
  return { value: null, invalid: true }
}

export function readNumber(c: Cell | null | undefined): { value: number | null; invalid: boolean } {
  const v = c?.v
  if (v === null || v === undefined) return { value: null, invalid: false }
  if (typeof v === 'number') return Number.isFinite(v) ? { value: v, invalid: false } : { value: null, invalid: true }
  if (typeof v === 'boolean' || v instanceof Date) return { value: null, invalid: true }
  const t = String(v).trim().replace(/\s/g, '')
  if (t === '') return { value: null, invalid: false }
  if (/^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(t)) return { value: Number(t.replace(/,/g, '')), invalid: false }
  if (/^-?\d+,\d+$/.test(t)) return { value: Number(t.replace(',', '.')), invalid: false }
  if (/^-?\d+(\.\d+)?$/.test(t) || /^-?\.\d+$/.test(t)) return { value: Number(t), invalid: false }
  return { value: null, invalid: true }
}

/** Identificador o texto: se conserva tal cual (ceros, puntos, guiones, sufijos). Solo se recortan los espacios de los extremos. */
export function readText(c: Cell | null | undefined): string | null {
  const v = c?.v
  if (v === null || v === undefined) return null
  if (v instanceof Date) return readDate(c).value
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return null
    // Un formato con ceros (p. ej. «00000») muestra los ceros a la izquierda: se respeta el texto mostrado
    if (typeof c?.z === 'string' && /^0{2,}$/.test(c.z) && c.w) return c.w.trim()
    return String(v)
  }
  const t = String(v).trim()
  return t === '' ? null : t
}

/** Valor JSON de la fila original (para guardar y mostrar «la fila tal como vino») */
export function rawValue(c: Cell | null | undefined): string | number | boolean | null {
  const v = c?.v
  if (v === null || v === undefined) return null
  if (v instanceof Date) return isNaN(v.getTime()) ? null : readDate(c).value
  if (typeof v === 'number' || typeof v === 'boolean') return v
  return String(v)
}

// Huella del contenido: FNV-1a de 64 bits (dos mitades de 32) en hexadecimal
export function fnv64(s: string): string {
  let h1 = 0x811c9dc5, h2 = 0x01000193 ^ 0x5bd1e995
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0
    h2 = Math.imul(h2 ^ c, 0x01000193 + 0x100) >>> 0
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0')
}

// ---------------------------------------------------------------------------------------------------------------
// Movimientos
// ---------------------------------------------------------------------------------------------------------------
export interface NormMovement {
  side: Side
  tipo: string; bodegaRaw: string; bodega: string; numero: string | null; fecha: string
  codLegal: string | null; razonSocial: string | null; producto: string; glosa: string | null
  cantidad: number; unidad: string; docRel: string | null; numRel: string | null; fechaEntrega: string | null
  contrato: string | null; refTipo: string | null; refCorrelativo: string | null; refNumero: string | null; refFecha: string | null
  lote: string | null; color: string | null; comentario: string | null
  pesoUnitario: number | null; pesoXProducir: number | null; pesoProducido: number | null; ccosto: string | null
}

export interface ParsedRow {
  sheet: string
  row: number
  raw: Record<string, string | number | boolean | null>
  norm: Partial<NormMovement> | null
  status: RowStatus
  reasons: string[]
  fingerprint: string | null
  dup: number
}

export interface HeaderInfo {
  headerRow: number
  /** Encabezado original → columna reconocida (o null si se ignora) */
  columns: Array<{ index: number; header: string; canonical: string | null; ignored: 'vacia' | 'desconocida' | null }>
  missing: string[]
}

export interface ParsedSheet {
  sheet: string
  kind: SourceType
  header: HeaderInfo
  rows: ParsedRow[]
  periodFrom: string | null
  periodTo: string | null
  counts: Record<RowStatus, number>
  warnings: string[]
}

function findHeaderRow(rows: CellRow[], wanted: (keys: Set<string>) => boolean): number {
  for (let i = 0; i < Math.min(20, rows.length); i++) {
    const keys = new Set((rows[i] || []).map(c => normKey(readText(c))).filter(Boolean))
    if (wanted(keys)) return i
  }
  return -1
}

const isBlankRow = (r: CellRow | undefined) => !r || r.every(c => c == null || c.v == null || (typeof c.v === 'string' && c.v.trim() === ''))

export interface ParseOptions { source: SourceType; today: string; minDate?: string }

/** Lee una hoja de movimientos (Entradas, Salidas o mixta). `today` limita las fechas futuras. */
export function parseMovementSheet(rows: CellRow[], sheet: string, opt: ParseOptions): ParsedSheet | { skip: string } {
  const hr = findHeaderRow(rows, k => k.has('tipodocto') && k.has('bodega') && k.has('producto') && k.has('cantidad'))
  if (hr < 0) return { skip: 'No se encontró el encabezado (TipoDocto, Bodega, Producto, Cantidad…)' }
  const headerCells = rows[hr] || []
  const width = Math.max(headerCells.length, ...rows.slice(hr + 1, hr + 50).map(r => r?.length ?? 0))
  const columns: HeaderInfo['columns'] = []
  const seen = new Set<string>()
  for (let j = 0; j < width; j++) {
    const header = readText(headerCells[j]) ?? ''
    const canon = header ? MOV_CANON.get(normKey(header)) ?? null : null
    const dupCol = canon !== null && seen.has(canon)
    if (canon && !dupCol) seen.add(canon)
    columns.push({ index: j, header, canonical: dupCol ? null : canon, ignored: !header ? 'vacia' : canon && !dupCol ? null : 'desconocida' })
  }
  const missing = MOVEMENT_COLUMNS.filter(c => !seen.has(c))
  const minDate = opt.minDate ?? '2000-01-01'
  const maxDate = addDays(opt.today, 1)
  const out: ParsedRow[] = []
  const warnings: string[] = []
  const emptyWithData = new Set<number>()
  for (let i = hr + 1; i < rows.length; i++) {
    const r = rows[i]
    if (isBlankRow(r)) continue
    const raw: ParsedRow['raw'] = {}
    const cell = (col: MovementColumn) => { const c = columns.find(x => x.canonical === col); return c ? r![c.index] : undefined }
    for (const c of columns) {
      const v = rawValue(r![c.index])
      if (c.ignored === 'vacia') { if (v !== null) emptyWithData.add(c.index); continue }
      raw[c.header] = v
    }
    const reasons: string[] = []
    let status: RowStatus = 'ACEPTADO'
    const reject = (m: string) => { reasons.push(m); status = 'RECHAZADO' }
    const review = (m: string) => { reasons.push(m); if (status === 'ACEPTADO') status = 'REVISION' }
    const t = (col: MovementColumn) => readText(cell(col))
    const n = (col: MovementColumn) => {
      const x = readNumber(cell(col))
      if (x.invalid) { if (col === 'Cantidad') reject(`Cantidad no numérica: «${rawValue(cell(col))}»`); else reasons.push(`${col} no numérico: se deja sin dato`) }
      return x.value
    }
    const d = (col: MovementColumn) => {
      const x = readDate(cell(col))
      if (x.invalid) { if (col === 'Fecha') reject(`Fecha no válida: «${rawValue(cell(col))}»`); else reasons.push(`${col} no es una fecha: se deja sin dato`) }
      return x.value
    }
    const tipo = t('TipoDocto'), bodegaRaw = t('Bodega'), producto = t('Producto'), unidad = t('UNIDAD')
    const fecha = d('Fecha'), cantidad = n('Cantidad')
    // Fila totalizadora (sin tipo ni producto): se ignora y se informa
    if (!tipo && !producto && !bodegaRaw) { warnings.push(`Fila ${i + 1}: sin tipo, bodega ni producto (posible total); no se importa.`); continue }
    if (!tipo) reject('Falta TipoDocto')
    if (!bodegaRaw) reject('Falta Bodega')
    if (!producto) reject('Falta Producto')
    if (!unidad) reject('Falta UNIDAD')
    if (!fecha && !reasons.some(x => x.startsWith('Fecha'))) reject('Falta Fecha')
    if (cantidad === null && !reasons.some(x => x.startsWith('Cantidad'))) reject('Falta Cantidad')
    if (fecha && (fecha < minDate || fecha > maxDate)) reject(`Fecha fuera de rango (${fecha})`)
    if (cantidad === 0) review('Cantidad cero')
    if (cantidad !== null && cantidad !== 0) {
      if (opt.source === 'ENTRADAS' && cantidad < 0) review('Cantidad negativa en un archivo de Entradas')
      if (opt.source === 'SALIDAS' && cantidad > 0) review('Cantidad positiva en un archivo de Salidas')
    }
    const norm: Partial<NormMovement> = {
      side: (cantidad ?? 0) < 0 ? 'S' : 'E',
      tipo: tipo ?? undefined, bodegaRaw: bodegaRaw ?? undefined, bodega: bodegaRaw ? bodegaKey(bodegaRaw) : undefined,
      numero: t('Numero'), fecha: fecha ?? undefined, codLegal: t('CodLegal'), razonSocial: t('RazonSocial'), producto: producto ?? undefined,
      glosa: t('GLOSA'), cantidad: cantidad ?? undefined, unidad: unidad ? unidad.toUpperCase() : undefined, docRel: t('DocRel'), numRel: t('NumRel'),
      fechaEntrega: d('FechaEntrega'), contrato: t('Contrato'), refTipo: t('RefTipoDocto'), refCorrelativo: t('RefCorrelativo'),
      refNumero: t('RefNumero'), refFecha: d('RefFecha'), lote: t('Lote'), color: t('Color'), comentario: t('Comentario'),
      pesoUnitario: n('PesoUnitario'), pesoXProducir: n('PesoTotalxProducir'), pesoProducido: n('PesoTotalProduccido'), ccosto: t('CCostoJRM'),
    }
    out.push({ sheet, row: i + 1, raw, norm, status, reasons, fingerprint: (status as RowStatus) === 'RECHAZADO' ? null : movementFingerprint(norm), dup: 1 })
  }
  markInFileDuplicates(out)
  if (emptyWithData.size) warnings.push(`Hay ${emptyWithData.size} columna(s) sin encabezado con datos: se ignoran.`)
  if (missing.length) warnings.push(`Faltan columnas: ${missing.join(', ')}. Sus campos quedan sin dato.`)
  return finishSheet(sheet, opt.source, { headerRow: hr + 1, columns, missing }, out, warnings, r => r.norm?.fecha ?? null)
}

export function movementFingerprint(n: Partial<NormMovement>): string {
  const keys: Array<keyof NormMovement> = ['tipo', 'bodega', 'numero', 'fecha', 'codLegal', 'razonSocial', 'producto', 'glosa', 'cantidad', 'unidad',
    'docRel', 'numRel', 'fechaEntrega', 'contrato', 'refTipo', 'refCorrelativo', 'refNumero', 'refFecha', 'lote', 'color', 'comentario',
    'pesoUnitario', 'pesoXProducir', 'pesoProducido', 'ccosto']
  return fnv64(keys.map(k => n[k] ?? '∅').join('\u0001'))
}

/** Líneas idénticas dentro del mismo archivo: se numeran (1, 2, 3…) y se conservan todas */
export function markInFileDuplicates(rows: ParsedRow[]) {
  const count = new Map<string, number>()
  for (const r of rows) {
    if (!r.fingerprint) continue
    const k = (count.get(r.fingerprint) ?? 0) + 1
    count.set(r.fingerprint, k)
    r.dup = k
    if (k > 1) r.reasons.push(`Línea idéntica n.° ${k} dentro del archivo (se conserva: no hay identificador que confirme duplicación)`)
  }
}

function finishSheet(sheet: string, kind: SourceType, header: HeaderInfo, rows: ParsedRow[], warnings: string[], dateOf: (r: ParsedRow) => string | null): ParsedSheet {
  const counts: Record<RowStatus, number> = { ACEPTADO: 0, RECHAZADO: 0, REVISION: 0, DESCARTADO: 0 }
  let from: string | null = null, to: string | null = null
  for (const r of rows) {
    counts[r.status]++
    const f = r.status === 'RECHAZADO' ? null : dateOf(r)
    if (f) { if (!from || f < from) from = f; if (!to || f > to) to = f }
  }
  return { sheet, kind, header, rows, periodFrom: from, periodTo: to, counts, warnings }
}

// ---------------------------------------------------------------------------------------------------------------
// Fuentes adicionales: saldo inicial, compromisos comerciales y recepciones
// ---------------------------------------------------------------------------------------------------------------
export function parseExtraSheet(rows: CellRow[], sheet: string, kind: 'SALDO_INICIAL' | 'COMPROMISOS' | 'RECEPCIONES', opt: { today: string; cutoff?: string | null }): ParsedSheet | { skip: string } {
  const spec = EXTRA_COLUMNS[kind]
  const aliasToCol = new Map<string, string>()
  for (const [col, aliases] of Object.entries(spec)) for (const a of aliases) if (!aliasToCol.has(a)) aliasToCol.set(a, col)
  const required = EXTRA_REQUIRED[kind]
  const hr = findHeaderRow(rows, k => required.filter(c => [...k].some(x => aliasToCol.get(x) === c)).length >= Math.min(3, required.length))
  if (hr < 0) return { skip: `No se encontró el encabezado (${required.join(', ')})` }
  const headerCells = rows[hr] || []
  const columns: HeaderInfo['columns'] = []
  const seen = new Set<string>()
  headerCells.forEach((c, j) => {
    const header = readText(c) ?? ''
    const canon = header ? aliasToCol.get(normKey(header)) ?? null : null
    const ok = canon && !seen.has(canon)
    if (ok) seen.add(canon!)
    columns.push({ index: j, header, canonical: ok ? canon : null, ignored: !header ? 'vacia' : ok ? null : 'desconocida' })
  })
  const missing = required.filter(c => !seen.has(c))
  if (missing.length) return { skip: `Faltan columnas obligatorias: ${missing.join(', ')}` }
  const out: ParsedRow[] = []
  for (let i = hr + 1; i < rows.length; i++) {
    const r = rows[i]
    if (isBlankRow(r)) continue
    const raw: ParsedRow['raw'] = {}
    const norm: Record<string, string | number | null> = {}
    const reasons: string[] = []
    let status: RowStatus = 'ACEPTADO'
    for (const c of columns) {
      if (c.ignored === 'vacia') continue
      raw[c.header] = rawValue(r![c.index])
      if (!c.canonical) continue
      const cell = r![c.index]
      if (EXTRA_DATES.has(c.canonical)) { const x = readDate(cell); if (x.invalid) { reasons.push(`${c.header} no es una fecha`); status = 'RECHAZADO' } norm[c.canonical] = x.value }
      else if (EXTRA_NUMS.has(c.canonical)) { const x = readNumber(cell); if (x.invalid) { reasons.push(`${c.header} no numérico`); status = 'RECHAZADO' } norm[c.canonical] = x.value }
      else norm[c.canonical] = c.canonical === 'Unidad' ? readText(cell)?.toUpperCase() ?? null : readText(cell)
    }
    if (kind === 'SALDO_INICIAL' && !norm.FechaCorte && opt.cutoff) norm.FechaCorte = opt.cutoff
    for (const c of required) if (norm[c] === null || norm[c] === undefined) { reasons.push(`Falta ${c}`); status = 'RECHAZADO' }
    if (kind === 'SALDO_INICIAL' && !norm.FechaCorte) { reasons.push('Falta la fecha de corte del saldo'); status = 'RECHAZADO' }
    const fp = status === 'RECHAZADO' ? null : fnv64(Object.keys(norm).sort().map(k => `${k}=${norm[k] ?? '∅'}`).join('\u0001'))
    out.push({ sheet, row: i + 1, raw, norm: norm as Partial<NormMovement>, status, reasons, fingerprint: fp, dup: 1 })
  }
  markInFileDuplicates(out)
  const dateKey = kind === 'SALDO_INICIAL' ? 'FechaCorte' : kind === 'COMPROMISOS' ? 'FechaCompromiso' : 'FechaRecepcion'
  return finishSheet(sheet, kind, { headerRow: hr + 1, columns, missing: [] }, out, [], r => (r.norm as Record<string, string | null> | null)?.[dateKey] ?? null)
}

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}
export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000)
}
