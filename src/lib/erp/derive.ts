import * as XLSX from 'xlsx'
import { createClient } from '@/lib/supabase/client'
import { recalcular, uploadPart } from '@/lib/inventario/api'
import { parseInventoryWorkbooks } from '@/lib/inventario/parse'
import { syncLegacyApt } from '@/lib/inventario/legacy'
import { syncAnalitica, syncPesoServicios } from '@/lib/inventario/vinculacion'

// ERP como única fuente: con el Actualizable y el Stock vigentes, el servidor calcula los movimientos del día
// (despachos por guía, traspasos, ingresos y ajustes de 647 · 540 · ST). Aquí se arma con ellos un archivo de Entradas y
// Salidas igual al del ERP y se carga por el mismo camino que el DATA: inventario, APT clásico, Analítica y peso de
// servicios. Al final el día queda guardado como base del siguiente.
const supabase = createClient()

// Mismas columnas y orden que el reporte de Entradas y Salidas del ERP
const COLUMNS = ['TipoDocto', 'Bodega', 'Numero', 'Fecha', 'CodLegal', 'RazonSocial', 'Producto', 'GLOSA', 'Cantidad', 'UNIDAD', 'DocRel', 'NumRel',
  'FechaEntrega', 'Contrato', 'RefTipoDocto', 'RefCorrelativo', 'RefNumero', 'RefFecha', 'Lote', 'Color', 'Comentario', 'PesoUnitario',
  'PesoTotalxProducir', 'PesoTotalProduccido', 'CCostoJRM'] as const

export interface DeriveResumen {
  fecha: string; base_fecha: string; base_fuente: 'DATA' | 'ERP' | 'VACIA'; desde: string; hasta: string; bodegas: string[]; bodegas_sin_stock: string[]
  despachos: number; guias: number; traspasos: number; ingresos: number; ajustes: number
}
type DeriveOut = { success?: boolean; error?: string; retry?: boolean; fallback?: boolean; resumen?: DeriveResumen; filas?: Array<Record<string, unknown>> }

async function derive(commit: boolean, resumen?: DeriveResumen): Promise<DeriveOut> {
  try {
    const res = await fetch('/api/erp/aplicar', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ accion: 'derivar', commit, resumen: resumen ?? null }) })
    const out = await res.json() as DeriveOut
    if (!out.fallback) return out
  } catch { /* sin servidor: desde el navegador */ }
  const { data, error } = await supabase.rpc('erp_derive', { p_commit: commit, p_resumen: resumen ?? null })
  if (error) return { success: false, error: error.message }
  return data as DeriveOut
}

// Archivo de Entradas y Salidas del día (hojas ENTRADA y SALIDA, como el DATA)
export function derivedWorkbook(rows: Array<Record<string, unknown>>, name: string): File {
  const wb = XLSX.utils.book_new()
  for (const [sheet, keep] of [['ENTRADA', (q: number) => q > 0], ['SALIDA', (q: number) => q < 0]] as const) {
    const part = rows.filter(r => keep(Number(r.Cantidad)))
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[...COLUMNS], ...part.map(r => COLUMNS.map(c => r[c] ?? null))]), sheet)
  }
  const data = XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer
  return new File([data], name, { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' })
}

// La Analítica no reemplaza por fecha: si el mismo día se vuelve a derivar, se revierte su importación anterior
async function revertAnalitica(name: string) {
  const { data } = await supabase.rpc('apa_imports_list')
  const prev = ((data ?? []) as Array<{ id: string; file_name: string; status: string }>).filter(i => i.file_name === name && i.status === 'ACTIVA')
  for (const i of prev) await supabase.rpc('apa_import_revert', { p_import: i.id, p_reason: 'Nueva derivación del mismo día desde el ERP' })
}

// null = faltan los dos archivos (aún no hay nada que derivar)
export async function derivarDia(onProgress: (m: string) => void): Promise<{ resumen: DeriveResumen; avisos: string[] } | null> {
  onProgress('Calculando los movimientos del día (despachos, traspasos e ingresos)…')
  let preview = await derive(false)
  // La primera vez la base es el inventario: si se está recalculando, se espera (hasta ~5 min)
  for (let i = 0; !preview.success && preview.retry && i < 20; i++) {
    onProgress(`El inventario se está recalculando; se reintenta en 15 s (${i + 1})…`)
    await new Promise(r => setTimeout(r, 15000))
    preview = await derive(false)
  }
  if (!preview.success) {
    if (/Faltan los dos archivos/.test(preview.error || '')) return null
    throw new Error(preview.error || 'No se pudieron calcular los movimientos del día')
  }
  const resumen = preview.resumen!
  const rows = preview.filas ?? []
  const avisos: string[] = []
  if (rows.length) {
    const name = `ERP_derivado_${resumen.fecha}.xlsx`
    const file = derivedWorkbook(rows, name)
    // Inventario multi-almacén: Entradas y Salidas del rango del día (reemplazan solo esas fechas)
    const parsed = parseInventoryWorkbooks([{ name, data: await file.arrayBuffer() }])
    for (const p of parsed.parts) await uploadPart(p, { force: true, onProgress: m => onProgress(`Inventario: ${m}`) })
    const rb = await recalcular(onProgress)
    if (rb.pending) avisos.push('El recálculo del inventario sigue en el servidor y termina solo en unos minutos.')
    // APT clásico (y peso de servicios, guías, flota) y Analítica, por el mismo archivo
    const legacy = await syncLegacyApt([file], onProgress)
    if (legacy) avisos.push(`APT clásico: ${legacy}`)
    await revertAnalitica(name)
    const analitica = await syncAnalitica([file], onProgress)
    if (analitica) avisos.push(`Analítica: ${analitica}`)
    avisos.push(...await syncPesoServicios(onProgress))
  }
  const done = await derive(true, resumen)
  if (!done.success) throw new Error(done.error || 'No se pudo guardar el día como base del siguiente')
  return { resumen, avisos }
}
