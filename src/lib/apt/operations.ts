/** Actions explain evidence; inventory age never establishes permission to dispatch. */
export interface OperationalSourceRow {
  almacen: string
  lote: string
  cliente: string | null
  stock_tn: number
  inferred_opening_tn: number | null
  age_days: number | null
  stock_tn_days: number | null
}
export type OperationalReview = 'ACTUALIZACION' | 'ORIGEN' | 'PERMANENCIA' | 'TRAZABILIDAD'
export interface OperationalDecision {
  review: OperationalReview
  label: string
  reason: string
  nextAction: string
  tone: 'red' | 'amber' | 'slate'
  availability: 'NO_REGISTRADA'
  responsible: null
}
export function operationalDecision(row: OperationalSourceRow, fresh: boolean, alertDays: number | null): OperationalDecision {
  const base = { availability: 'NO_REGISTRADA' as const, responsible: null }
  if (!fresh) return { ...base, review: 'ACTUALIZACION', label: 'Actualizar cifras', reason: 'Los movimientos y el cálculo no corresponden a la misma versión.', nextAction: 'Revisar la última carga y completar el recálculo.', tone: 'red' }
  if (row.inferred_opening_tn === null || row.inferred_opening_tn > 0 || row.age_days === null) return { ...base, review: 'ORIGEN', label: 'Conciliar origen', reason: row.inferred_opening_tn === null ? 'No se conoce la composición del saldo a este corte.' : row.inferred_opening_tn > 0 ? 'El saldo incluye apertura inferida sin fecha de origen confirmada.' : 'No hay una antigüedad verificable del saldo.', nextAction: 'Contrastar la apertura y los movimientos con el ERP.', tone: 'amber' }
  if (alertDays !== null && Number.isFinite(alertDays) && row.age_days > alertDays) return { ...base, review: 'PERMANENCIA', label: 'Revisar permanencia', reason: `La antigüedad ponderada supera el umbral configurado de ${alertDays} días.`, nextAction: 'Consultar la trazabilidad y confirmar el motivo de permanencia.', tone: 'amber' }
  return { ...base, review: 'TRAZABILIDAD', label: 'Revisar servicio', reason: 'El saldo no acredita liberación ni disponibilidad para despacho.', nextAction: 'Consultar el recorrido y verificar las condiciones del servicio.', tone: 'slate' }
}
export function operationalOt(lote: string): string | null {
  return /^([0-9]+)(?:$|[-_])/.exec(lote)?.[1] ?? null
}
export function operationalTraceHref(lote: string, cutoff: string | null): string {
  const qs = new URLSearchParams({ q: lote })
  // Trace RPC uses its own model cutoff. Keep selected historical cut in Gantt instead.
  if (cutoff) return `/apt/gantt?g=${encodeURIComponent(JSON.stringify({ lote_exacto: lote, corte: cutoff }))}`
  return `/apt/flujo/trazabilidad?${qs}`
}

export interface OperationalReadiness {
  almacen: string; lote: string; producto: string
  status: 'NO_EVALUADO' | 'DISPONIBLE' | 'BLOQUEADO'
  reason: string | null; responsible_name: string | null; next_action: string | null
  updated_at: string; updated_by: string | null
}

/** A rebuilt inventory may include new material: an older review cannot release that balance. */
export function operationalReadinessState(record: OperationalReadiness | undefined, rebuiltAt: string | null): { status: OperationalReadiness['status']; needsReview: boolean } {
  if (!record) return { status: 'NO_EVALUADO', needsReview: false }
  const rebuilt = rebuiltAt ? Date.parse(rebuiltAt) : NaN
  const reviewed = Date.parse(record.updated_at)
  const needsReview = !Number.isFinite(rebuilt) || !Number.isFinite(reviewed) || reviewed < rebuilt
  return { status: needsReview ? 'NO_EVALUADO' : record.status, needsReview }
}
