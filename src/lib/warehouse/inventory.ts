// Inventario por barrido (fases 2 y 3 de docs/plan-wms-inventario-apt.md): tipos y formato compartidos.
export type Campaign = { id: string; code: string; bodega: string; zones: string[]; status: string; notes: string | null; created_at: string; closed_at: string | null; close_note: string | null
  erp_cut_at: string | null; created_by_name: string | null; closed_by_name: string | null; expected_lines: number; expected_qty: number; counted_lines: number; labeled: number; unidentified: number; recounts: number }
export const CAMPAIGN_STATE: Record<string, { label: string; style: string }> = {
  EN_CONTEO: { label: 'En conteo', style: 'bg-blue-100 text-blue-900' },
  EN_REVISION: { label: 'En revisión', style: 'bg-amber-100 text-amber-900' },
  CERRADA: { label: 'Cerrada', style: 'bg-emerald-100 text-emerald-900' },
  ANULADA: { label: 'Anulada', style: 'bg-slate-100 text-slate-600' },
}
export const fmtDate = (v: string | null | undefined) => v ? new Date(v).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' }) : '—'

export type ExpectedLine = { linea: number; cod_producto: string; producto: string | null; lote: string | null; lote_raw: string | null; lote_key: string; ot: string | null; unidad: string | null; stock: number; counted: number }
export type CountLine = { id: number; round: number; origin: 'ETIQUETA' | 'ROTULO' | 'NO_IDENTIFICADO'; zone: string | null; cod_producto: string | null; lote_key: string | null; ot: string | null; quantity: number | null; weight_kg: number | null; note: string | null; other_bodega: boolean; counted_at: string; counted_by_name: string | null; mine: boolean; package_code: string | null; description: string | null; unit: string | null }
export type SummaryRow = { cod_producto: string; lote_key: string; ot: string | null; producto: string | null; unidad: string | null; expected: number; counted: number; bultos: number; diff: number; round: number; result: 'CUADRA' | 'FALTANTE' | 'SOBRANTE' | 'NO_EN_ERP' }
export const RESULT_STYLE: Record<SummaryRow['result'], string> = { CUADRA: 'bg-emerald-100 text-emerald-900', FALTANTE: 'bg-rose-100 text-rose-900', SOBRANTE: 'bg-amber-100 text-amber-900', NO_EN_ERP: 'bg-violet-100 text-violet-900' }
export const fmtN = (n: number | null | undefined, d = 3) => n == null ? '—' : Number(n).toLocaleString('es-PE', { maximumFractionDigits: d })
