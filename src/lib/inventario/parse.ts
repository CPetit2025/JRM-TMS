import * as XLSX from 'xlsx'

// Lectura de los reportes del ERP para el inventario multi-almacén. Sin DOM: se usa en el navegador (worker) y en
// pruebas con node.
//  * Movimientos: hojas con TIPODOCTO, BODEGA, Fecha, Producto y Cantidad (reportes "Entradas" y "Salidas"). Cada fila
//    va al lado que indica el signo de Cantidad: positiva = Entradas, negativa = Salidas (un libro puede traer ambos).
//  * Foto de stock: hojas con BODEGA, Producto y una columna de saldo (Cantidad, Saldo, Stock, Existencia), sin TIPODOCTO.

export type InvSide = 'E' | 'S' | 'STOCK'
export const INV_SIDE_LABEL: Record<InvSide, string> = { E: 'Entradas', S: 'Salidas', STOCK: 'Foto de stock' }

export const INV_COLUMNS = ['TIPODOCTO', 'BODEGA', 'Numero', 'Fecha', 'CodLegal', 'RazonSocial', 'Producto', 'GLOSA', 'Cantidad', 'UNIDAD',
  'DocRel', 'NumRel', 'FechaEntrega', 'Contrato', 'RefTipoDocto', 'RefCorrelativo', 'RefNumero', 'RefFecha', 'Lote', 'Comentario',
  'PesoUnitario', 'PesoTotalProduccido', 'CCostoJRM'] as const
const DATE_COLS = new Set(['Fecha', 'FechaEntrega', 'RefFecha'])
const NUM_COLS = new Set(['Cantidad', 'PesoUnitario', 'PesoTotalProduccido', 'Peso'])
// Sinónimos de la foto de stock
const STOCK_ALIASES: Record<string, string> = {
  bodega: 'BODEGA', almacen: 'BODEGA', producto: 'Producto', codigo: 'Producto', codproducto: 'Producto', lote: 'Lote',
  glosa: 'GLOSA', descripcion: 'GLOSA', unidad: 'UNIDAD', um: 'UNIDAD',
  cantidad: 'Cantidad', saldo: 'Cantidad', stock: 'Cantidad', existencia: 'Cantidad', stockactual: 'Cantidad', saldofinal: 'Cantidad',
  peso: 'Peso', pesokg: 'Peso', pesototal: 'Peso', kg: 'Peso', pesototalproduccido: 'Peso',
}

export type InvRow = Record<string, string | number> & { __row: number }

export interface InvParsedPart {
  side: InvSide
  fileName: string
  sheetName: string
  rows: InvRow[]
  desde: string | null
  hasta: string | null
  kg: number
  bodegas: string[]
  tipos: Record<string, number>
  sinFecha: number
}

export interface InvParseResult {
  parts: InvParsedPart[]
  ignored: Array<{ fileName: string; sheetName: string; reason: string }>
  warnings: string[]
  // Excel del ERP (Actualizable Despacho o Stock Bodega Despacho): se cargan en «ERP: OT, guías y stock»
  erpFiles: string[]
}

export const ERP_SHEET = 'ERP'
// Actualizable (Nro_Documento + Cant_Pendiente) o Stock Bodega Despacho (Stock_Comprometido o Fecha_Actualizacion con
// Bodega, Stock y Lote). El stock del ERP es la foto de hoy, no un saldo inicial: como foto del inventario dejaría
// sin usar todos los movimientos anteriores.
export function isErpExport(aoa: unknown[][]) {
  return aoa.slice(0, 10).some(r => {
    const k = new Set((r || []).map(normKey))
    return (k.has('nrodocumento') && k.has('cantpendiente'))
      || (k.has('codproducto') && k.has('stock') && k.has('lote') && (k.has('stockcomprometido') || k.has('fechaactualizacion')))
  })
}

export interface InvInputFile { name: string; data: ArrayBuffer | Uint8Array }

export const normKey = (s: unknown) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[\s_./-]+/g, '').toLowerCase()
const CANON = new Map<string, string>(INV_COLUMNS.map(c => [normKey(c), c]))
const pad = (n: number) => String(n).padStart(2, '0')

export function isoDate(v: unknown): string | null {
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

function numberOf(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null
  if (typeof v === 'string') {
    const t = v.trim().replace(/,/g, '')
    return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null
  }
  return null
}

// Texto: los números enteros de Excel pierden el ".0" (Numero 47727, Lote 2870)
function textOf(v: unknown): string | null {
  if (v === null || v === undefined) return null
  if (v instanceof Date) return isoDate(v)
  if (typeof v === 'number') return Number.isFinite(v) ? String(v) : null
  const t = String(v).trim()
  return t === '' ? null : t
}

function findHeader(aoa: unknown[][]): { row: number; kind: 'MOV' | 'STOCK' } | null {
  for (let i = 0; i < Math.min(15, aoa.length); i++) {
    const cells = new Set((aoa[i] || []).map(normKey))
    if (!['producto', 'codigo', 'codproducto'].some(k => cells.has(k)) || !(cells.has('bodega') || cells.has('almacen'))) continue
    if (cells.has('tipodocto') && cells.has('fecha') && cells.has('cantidad')) return { row: i, kind: 'MOV' }
    if (['cantidad', 'saldo', 'stock', 'existencia', 'stockactual', 'saldofinal'].some(k => cells.has(k))) return { row: i, kind: 'STOCK' }
  }
  return null
}

function emptyPart(side: InvSide, fileName: string, sheetName: string): InvParsedPart {
  return { side, fileName, sheetName, rows: [], desde: null, hasta: null, kg: 0, bodegas: [], tipos: {}, sinFecha: 0 }
}

export function parseInventorySheet(aoa: unknown[][], fileName: string, sheetName: string): { parts: InvParsedPart[] } | { skip: string } {
  if (isErpExport(aoa)) return { skip: ERP_SHEET }
  const h = findHeader(aoa)
  if (!h) return { skip: 'No tiene las columnas BODEGA, Producto y (TIPODOCTO, Fecha, Cantidad) o un saldo de stock' }
  const headers = (aoa[h.row] || []).map(c => {
    const k = normKey(c)
    if (!k) return null
    return h.kind === 'STOCK' ? (STOCK_ALIASES[k] ?? null) : (CANON.get(k) ?? null)
  })
  const parts = new Map<InvSide, InvParsedPart>()
  const bodegas = new Map<InvSide, Set<string>>()
  const part = (side: InvSide) => {
    if (!parts.has(side)) { parts.set(side, emptyPart(side, fileName, sheetName)); bodegas.set(side, new Set()) }
    return parts.get(side)!
  }
  for (let i = h.row + 1; i < aoa.length; i++) {
    const raw = aoa[i] || []
    const row: InvRow = { __row: i + 1 }
    headers.forEach((col, j) => {
      if (!col || col in row) return
      const v = raw[j]
      if (DATE_COLS.has(col)) { const d = isoDate(v); if (d) row[col] = d; else { const t = textOf(v); if (t) row[col] = t } }
      else if (NUM_COLS.has(col)) { const n = numberOf(v); if (n !== null) row[col] = n }
      else { const t = textOf(v); if (t) row[col] = t }
    })
    // Fila totalizadora o vacía: sin producto ni tipo de documento
    if (!row.Producto && !row.TIPODOCTO) continue
    const cant = typeof row.Cantidad === 'number' ? row.Cantidad : 0
    const side: InvSide = h.kind === 'STOCK' ? 'STOCK' : cant < 0 ? 'S' : 'E'
    const p = part(side)
    p.rows.push(row)
    if (row.BODEGA) bodegas.get(side)!.add(String(row.BODEGA).replace(/\s+/g, ' ').trim())
    if (h.kind === 'MOV') {
      const f = typeof row.Fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.Fecha) ? row.Fecha : null
      if (!f) p.sinFecha++
      else {
        if (!p.desde || f < p.desde) p.desde = f
        if (!p.hasta || f > p.hasta) p.hasta = f
      }
      const t = String(row.TIPODOCTO ?? '(sin tipo)')
      p.tipos[t] = (p.tipos[t] ?? 0) + 1
      const pt = typeof row.PesoTotalProduccido === 'number' ? Math.abs(row.PesoTotalProduccido) : 0
      p.kg += pt
    } else {
      p.kg += typeof row.Peso === 'number' ? Math.abs(row.Peso) : 0
    }
  }
  for (const [side, p] of parts) p.bodegas = [...bodegas.get(side)!].sort()
  return { parts: [...parts.values()].filter(p => p.rows.length > 0) }
}

export function parseInventoryWorkbooks(files: InvInputFile[], onProgress?: (m: string) => void): InvParseResult {
  const out: InvParseResult = { parts: [], ignored: [], warnings: [], erpFiles: [] }
  for (const f of files) {
    onProgress?.(`Leyendo ${f.name}…`)
    const wb = XLSX.read(f.data, { type: 'array', cellDates: true, dense: true })
    for (const name of wb.SheetNames) {
      const ws = wb.Sheets[name]
      if (!ws) continue
      onProgress?.(`Procesando ${f.name} · ${name}…`)
      const aoa = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1, raw: true, defval: null, blankrows: false })
      const res = parseInventorySheet(aoa, f.name, name)
      if ('skip' in res && res.skip === ERP_SHEET) { if (!out.erpFiles.includes(f.name)) out.erpFiles.push(f.name); continue }
      if ('skip' in res) { out.ignored.push({ fileName: f.name, sheetName: name, reason: res.skip }); continue }
      // El lado lo decide el signo de Cantidad; si contradice el nombre de la hoja, se avisa antes de aplicar
      const hint: InvSide | null = /ENTRADA|INGRESO/i.test(name) ? 'E' : /SALIDA|EGRESO/i.test(name) ? 'S' : null
      for (const p of res.parts) {
        if (hint && p.side !== 'STOCK' && p.side !== hint) out.warnings.push(`${f.name} · ${name}: la hoja se llama «${name}», pero ${p.rows.length.toLocaleString('es-PE')} fila(s) tienen Cantidad ${p.side === 'S' ? 'negativa' : 'positiva'} y se cargan como ${INV_SIDE_LABEL[p.side]}. Si esperaba ${INV_SIDE_LABEL[hint]}, revise la hoja.`)
      }
      out.parts.push(...res.parts)
    }
  }
  if (!out.parts.length && !out.erpFiles.length) throw new Error('No se encontraron movimientos ni una foto de stock. Suba el Actualizable Despacho y el Stock Bodega Despacho del ERP.')
  out.parts = mergeBySide(out.parts, out.warnings)
  for (const p of out.parts) {
    if (p.sinFecha) out.warnings.push(`${p.fileName} · ${p.sheetName}: ${p.sinFecha} fila(s) sin fecha válida no se cargarán.`)
  }
  const sides = new Set(out.parts.map(p => p.side))
  if (sides.has('E') && !sides.has('S')) out.warnings.push('Solo se cargan Entradas. Suba también las Salidas del mismo rango para que los traspasos queden con origen y destino.')
  if (sides.has('S') && !sides.has('E')) out.warnings.push('Solo se cargan Salidas. Suba también las Entradas del mismo rango para que los traspasos queden con origen y destino.')
  const ranges = out.parts.filter(p => p.side !== 'STOCK')
  if (ranges.length > 1) {
    const e = ranges.filter(p => p.side === 'E'), s = ranges.filter(p => p.side === 'S')
    const span = (xs: InvParsedPart[]) => [xs.map(p => p.desde).filter(Boolean).sort()[0], xs.map(p => p.hasta).filter(Boolean).sort().at(-1)]
    const [ed, eh] = span(e), [sd, sh] = span(s)
    if (e.length && s.length && (ed !== sd || eh !== sh)) out.warnings.push(`Las Entradas (${ed} a ${eh}) y las Salidas (${sd} a ${sh}) cubren fechas distintas.`)
  }
  return out
}

// Una sola parte por lado. Los libros del ERP a veces traen hojas que se contienen (p. ej. «ENTRADA TOTAL» con todos los
// movimientos y «SALIDA TOTAL» con una parte): cada fila idéntica cuenta las veces que más se repite en una misma hoja,
// así no se duplica lo que aparece en dos hojas y se conservan las líneas repetidas legítimas de un documento.
function rowKey(r: InvRow) {
  return Object.keys(r).filter(k => k !== '__row').sort().map(k => `${k}=${r[k]}`).join('\u0001')
}

export function mergeBySide(parts: InvParsedPart[], warnings: string[]): InvParsedPart[] {
  const out: InvParsedPart[] = []
  for (const side of ['E', 'S', 'STOCK'] as InvSide[]) {
    const group = parts.filter(p => p.side === side)
    if (!group.length) continue
    if (group.length === 1) { out.push(group[0]); continue }
    const best = new Map<string, InvRow[]>()
    for (const p of group) {
      const local = new Map<string, InvRow[]>()
      for (const r of p.rows) { const k = rowKey(r); const l = local.get(k); if (l) l.push(r); else local.set(k, [r]) }
      for (const [k, rows] of local) if ((best.get(k)?.length ?? 0) < rows.length) best.set(k, rows)
    }
    const rows = [...best.values()].flat()
    const total = group.reduce((t, p) => t + p.rows.length, 0)
    if (rows.length < total) {
      warnings.push(`${INV_SIDE_LABEL[side]}: se omitieron ${total - rows.length} fila(s) repetidas entre las hojas ${group.map(p => p.sheetName).join(', ')}.`)
    }
    out.push(summarize(side, [...new Set(group.map(p => p.fileName))].join(' + '), group.map(p => p.sheetName).join(' + '), rows))
  }
  return out
}

function summarize(side: InvSide, fileName: string, sheetName: string, rows: InvRow[]): InvParsedPart {
  const p = emptyPart(side, fileName, sheetName)
  const bodegas = new Set<string>()
  p.rows = rows
  for (const row of rows) {
    if (row.BODEGA) bodegas.add(String(row.BODEGA).replace(/\s+/g, ' ').trim())
    if (side === 'STOCK') { p.kg += typeof row.Peso === 'number' ? Math.abs(row.Peso) : 0; continue }
    const f = typeof row.Fecha === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.Fecha) ? row.Fecha : null
    if (!f) p.sinFecha++
    else {
      if (!p.desde || f < p.desde) p.desde = f
      if (!p.hasta || f > p.hasta) p.hasta = f
    }
    const t = String(row.TIPODOCTO ?? '(sin tipo)')
    p.tipos[t] = (p.tipos[t] ?? 0) + 1
    p.kg += typeof row.PesoTotalProduccido === 'number' ? Math.abs(row.PesoTotalProduccido) : 0
  }
  p.bodegas = [...bodegas].sort()
  return p
}
