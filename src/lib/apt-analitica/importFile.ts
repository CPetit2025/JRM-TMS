import type { SupabaseClient } from '@supabase/supabase-js'
import { PARSER_VERSION } from './normalize'
import type { WorkbookParse } from './workbook'
import type { SourceType } from './types'

// Importa un archivo ya leído a la Analítica APT y Distribución: inicio, filas por bloques (con reintentos) y cierre
// con detección de repetidos. La usan el asistente de carga de la analítica y la carga única de «Cargar datos del ERP».
export interface AnaliticaFile { file: File; hash: string; parse: WorkbookParse }

const fmt = (n: number) => Number(n || 0).toLocaleString('es-PE')

export function filePeriod(parse: WorkbookParse) {
  const from = parse.sheets.map(s => s.periodFrom).filter(Boolean).sort()[0] ?? null
  const to = parse.sheets.map(s => s.periodTo).filter(Boolean).sort().at(-1) ?? null
  return { from, to }
}

export async function importAnaliticaFile(supabase: SupabaseClient, p: AnaliticaFile, source: SourceType, cutoff: string | null,
  onProgress: (m: string) => void): Promise<{ ok: boolean; text: string }> {
  const rows = p.parse.sheets.flatMap(s => s.rows)
  const { from, to } = filePeriod(p.parse)
  onProgress(`${p.file.name}: preparando…`)
  const { data: b, error: e1 } = await supabase.rpc('apa_import_begin', { p: {
    source_type: source, file_name: p.file.name, file_hash: p.hash, file_size: p.file.size, period_from: from, period_to: to, cutoff,
    parser_version: PARSER_VERSION, sheets: p.parse.sheets.map(s => ({ sheet: s.sheet, header_row: s.header.headerRow, rows: s.rows.length, counts: s.counts,
      ignored: s.header.columns.filter(c => c.ignored).map(c => c.header || `(columna ${c.index + 1} sin encabezado)`) })),
    warnings: [...p.parse.sheets.flatMap(s => s.warnings.slice(0, 20)), ...p.parse.skipped.map(s => `Hoja ${s.sheet} ignorada: ${s.reason}`)] } })
  if (e1 || !b?.success) return { ok: false, text: e1?.message ?? b?.error ?? 'No se pudo iniciar' }
  const id = b.id as string
  let failed: string | null = null
  for (let i = 0; i < rows.length; i += 1000) {
    onProgress(`${p.file.name}: ${fmt(Math.min(rows.length, i + 1000))} de ${fmt(rows.length)} filas`)
    const chunk = rows.slice(i, i + 1000).map(r => ({ sheet: r.sheet, row: r.row, raw: r.raw, status: r.status, reasons: r.reasons, fingerprint: r.fingerprint, dup: r.dup, norm: r.norm }))
    let ok = false
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      const { error } = await supabase.rpc('apa_import_rows', { p_import: id, p_rows: chunk })
      if (!error) ok = true; else if (attempt === 2) failed = error.message; else await new Promise(r => setTimeout(r, 1500 * (attempt + 1)))
    }
    if (failed) break
  }
  if (failed) return { ok: false, text: `Envío interrumpido: ${failed}. La carga quedó en preparación y no cuenta; vuelva a intentarlo.` }
  onProgress(`${p.file.name}: cerrando y buscando repetidos…`)
  const { data: f, error: e3 } = await supabase.rpc('apa_import_finish', { p_import: id, p_expected: rows.length })
  if (e3) return { ok: false, text: e3.message }
  return { ok: true, text: `${fmt(f.rows_accepted)} aceptadas, ${fmt(f.rows_rejected)} rechazadas y ${fmt(f.rows_review)} en revisión${f.repeated ? ` (${fmt(f.repeated)} posibles repetidos de otra carga)` : ''}.` }
}
