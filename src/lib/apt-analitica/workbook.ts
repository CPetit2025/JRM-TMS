import * as XLSX from 'xlsx'
import type { SourceType } from './types'
import { parseExtraSheet, parseMovementSheet, type CellRow, type ParsedSheet } from './normalize'

// Lectura de libros Excel/CSV en celdas (modo denso de SheetJS). Límites: 40 MB por archivo y 400.000 filas por hoja.
export const MAX_FILE_BYTES = 40 * 1024 * 1024
export const MAX_ROWS = 400_000

export function readSheets(data: ArrayBuffer | Uint8Array): Array<{ name: string; rows: CellRow[] }> {
  const wb = XLSX.read(data, { type: 'array', cellDates: true, dense: true, cellText: true, cellNF: true })
  const out: Array<{ name: string; rows: CellRow[] }> = []
  for (const name of wb.SheetNames) {
    const ws = wb.Sheets[name] as XLSX.WorkSheet & { '!data'?: CellRow[] }
    // Según la versión de SheetJS, el modo denso guarda las filas en «!data» o en la propia hoja (índices 0, 1, 2…)
    let rows = ws['!data'] as CellRow[] | undefined
    if (!rows) {
      const ref = ws['!ref'] ? XLSX.utils.decode_range(ws['!ref']) : null
      const indexed = ws as unknown as Record<number, CellRow | undefined>
      rows = ref ? Array.from({ length: ref.e.r + 1 }, (_, i) => indexed[i] ?? []) : []
    }
    if (rows.length > MAX_ROWS) throw new Error(`La hoja «${name}» tiene ${rows.length.toLocaleString('es-PE')} filas: el máximo es ${MAX_ROWS.toLocaleString('es-PE')}.`)
    out.push({ name, rows })
  }
  return out
}

export interface WorkbookParse { sheets: ParsedSheet[]; skipped: Array<{ sheet: string; reason: string }> }

export function parseWorkbook(data: ArrayBuffer | Uint8Array, source: SourceType, opt: { today: string; cutoff?: string | null }): WorkbookParse {
  const res: WorkbookParse = { sheets: [], skipped: [] }
  for (const s of readSheets(data)) {
    const p = source === 'SALDO_INICIAL' || source === 'COMPROMISOS' || source === 'RECEPCIONES'
      ? parseExtraSheet(s.rows, s.name, source, opt)
      : parseMovementSheet(s.rows, s.name, { source, today: opt.today })
    if ('skip' in p) res.skipped.push({ sheet: s.name, reason: p.skip }); else res.sheets.push(p)
  }
  return res
}

/** Huella SHA-256 del contenido del archivo (detecta la misma importación aunque cambie el nombre) */
export async function fileHash(data: ArrayBuffer): Promise<string> {
  const d = await crypto.subtle.digest('SHA-256', data)
  return [...new Uint8Array(d)].map(b => b.toString(16).padStart(2, '0')).join('')
}
