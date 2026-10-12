import type { SupabaseClient } from '@supabase/supabase-js'

export type AptAnalysisFilters = {
  desde?: string; hasta?: string; cutoff?: string; almacen?: string; lote?: string; ot?: string
  clientes?: string[]; limit?: number; offset?: number
}
const DATE_KEYS = ['desde', 'hasta', 'cutoff']
const TEXT_KEYS = ['almacen', 'lote', 'ot']
const ALLOWED = new Set([...DATE_KEYS, ...TEXT_KEYS, 'clientes', 'limit', 'offset'])

/** Reject unsupported filters: an analysis must never quietly broaden the user's scope. */
export function validateAptAnalysisFilters(value: unknown): AptAnalysisFilters {
  if (value == null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Los filtros APT deben ser un objeto.')
  const output: Record<string, unknown> = {}
  for (const [key, item] of Object.entries(value)) {
    if (!ALLOWED.has(key)) throw new Error(`El filtro ${key} no está disponible en el análisis operativo. Abre /apt/operacion para elegir el alcance.`)
    if (item == null || item === '') continue
    if (DATE_KEYS.includes(key)) {
      if (typeof item !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(item) || new Date(`${item}T00:00:00Z`).toISOString().slice(0, 10) !== item) throw new Error('Fecha APT inválida; usa YYYY-MM-DD.')
      output[key] = item
    } else if (TEXT_KEYS.includes(key)) {
      if (typeof item !== 'string' || item.trim().length > 100 || !item.trim()) throw new Error('Filtro APT inválido.')
      if (key === 'almacen' && !['647', '540', 'ST'].includes(item.trim())) throw new Error('Almacén APT inválido.')
      output[key] = item.trim()
    } else if (key === 'clientes') {
      if (!Array.isArray(item) || item.length > 25 || item.some(x => typeof x !== 'string' || !x.trim() || x.length > 180)) throw new Error('Clientes APT inválidos.')
      output[key] = [...new Set(item.map(x => (x as string).trim()))]
    } else {
      if (typeof item !== 'number' || !Number.isInteger(item) || item < (key === 'limit' ? 1 : 0) || item > (key === 'limit' ? 100 : 100000)) throw new Error('Paginación APT inválida.')
      output[key] = item
    }
  }
  const filters = output as AptAnalysisFilters
  if (filters.desde && filters.hasta) {
    const span = (Date.parse(filters.hasta) - Date.parse(filters.desde)) / 86400000
    if (span < 0 || span > 365) throw new Error('El período APT debe ser ordenado y no exceder 366 días.')
  }
  return filters
}

type Summary = Record<string, unknown> & {
  success?: boolean; error?: string; meta?: Record<string, unknown>; kpis?: Record<string, unknown>
  quality?: Record<string, unknown>; rows?: unknown[]; total?: number
}

async function readSummary(supabase: SupabaseClient, filters: AptAnalysisFilters): Promise<Summary> {
  const { data, error } = await supabase.rpc('apt_operational_summary', { p: filters })
  if (error || !data || data.success === false || data.error) throw new Error('El resumen operativo APT no está disponible. Revisa el acceso o la actualización de datos en /apt/operacion.')
  return data as Summary
}

type LotKey = { almacen: string; lote: string }
function summaryLotKeys(summary: Summary): LotKey[] {
  const keys = new Map<string, LotKey>()
  for (const value of summary.rows || []) {
    if (!value || typeof value !== 'object') continue
    const row = value as Record<string, unknown>
    if (typeof row.almacen !== 'string' || typeof row.lote !== 'string') continue
    const key = { almacen: row.almacen, lote: row.lote }
    keys.set(JSON.stringify(key), key)
  }
  return [...keys.values()].slice(0, 100)
}

/** Optional evidence uses only the authorized, paginated summary's exact lot/warehouse keys. */
async function operationalEvidence(supabase: SupabaseClient, summary: Summary) {
  const keys = summaryLotKeys(summary)
  const scope = 'FILAS_PAGINADAS_DEL_RESUMEN'
  const base = { scope, summaryRows: keys.length, certifies_full_inventory: false }
  if (!keys.length) return { readiness: { ...base, available: false, reason: 'SIN_FILAS_EN_EL_ALCANCE', rows: [] }, reconciliation: { ...base, available: false, reason: 'SIN_FILAS_EN_EL_ALCANCE', rows: [] } }
  let readiness: Record<string, unknown> = { ...base, available: false, reason: 'CORTE_HISTORICO_SIN_REVISION_HISTORICA', rows: [] }
  if (summary.meta?.composition_available === true) {
    try {
      const { data, error } = await supabase.rpc('apt_readiness_list', { p_keys: keys.map(key => ({ ...key, producto: '*' })) })
      if (error || !data?.success || !Array.isArray(data.rows)) throw new Error('Unavailable')
      const rebuild = Date.parse(String(summary.meta.flow_rebuilt_at || ''))
      const rows = keys.map(key => {
        const stored = (data.rows as Record<string, unknown>[]).find(row => row.almacen === key.almacen && row.lote === key.lote && row.producto === '*')
        const updated = Date.parse(String(stored?.updated_at || ''))
        const current = Boolean(stored && summary.meta?.model_fresh === true && Number.isFinite(rebuild) && Number.isFinite(updated) && updated >= rebuild)
        return { ...key, producto: '*', status: current ? stored?.status : 'NO_EVALUADO', registered_status: stored?.status || null,
          reason: stored?.reason || null, responsible_name: stored?.responsible_name || null, next_action: stored?.next_action || null,
          updated_at: stored?.updated_at || null, source: 'apt_readiness_list', review_current: current,
          qualification: current ? 'REVISION_REGISTRADA_VIGENTE' : stored ? 'REVISION_ANTERIOR_O_MODELO_PENDIENTE_REQUIERE_REVALIDACION' : 'SIN_REVISION_REGISTRADA' }
      })
      readiness = { ...base, available: true, rows }
    } catch { readiness = { ...base, available: false, reason: 'CONSULTA_DE_REVISION_NO_DISPONIBLE', rows: [] } }
  }
  // The observation RPC does not accept OT/client filters: never call it globally. Exact summary
  // keys restrict every query, and post-filtering excludes siblings matched by its substring search.
  const selected = keys.slice(0, 10)
  const cutoff = summary.meta?.cutoff
  if (typeof cutoff !== 'string') return { readiness, reconciliation: { ...base, available: false, reason: 'SIN_CORTE', rows: [] } }
  const responses = await Promise.allSettled(selected.map(async key => {
    const { data, error } = await supabase.rpc('apt_stock_reconciliation', { p: { cutoff, almacen: key.almacen, lote: key.lote, limit: 100, offset: 0 } })
    if (error || !data?.success || !Array.isArray(data.rows)) throw new Error('Unavailable')
    const rows = (data.rows as Record<string, unknown>[]).filter(row => row.almacen === key.almacen && row.lote === key.lote && row.cutoff === cutoff)
    return { key, rows, model_fresh: data.model_fresh, documentary_available: data.documentary_available,
      sampled: typeof data.total === 'number' && data.total > data.rows.length }
  }))
  const successful = responses.flatMap(response => response.status === 'fulfilled' ? [response.value] : [])
  return { readiness, reconciliation: { ...base, available: successful.length > 0,
    reason: successful.length === responses.length ? null : 'ALGUNAS_CONSULTAS_NO_DISPONIBLES',
    keysRequested: selected.length, keysExcludedByLimit: keys.length - selected.length,
    sampleTruncated: keys.length > selected.length || successful.some(item => item.sampled),
    rows: successful.flatMap(item => item.rows), consultations: successful.map(({ rows: _rows, ...meta }) => meta),
    source: 'apt_stock_reconciliation', note: 'Comparación de observaciones registradas por producto; no certifica el inventario completo ni extiende la conciliación a otras OT o clientes.' } }
}

export async function getAptOperationalAnalysis(supabase: SupabaseClient, filtersValue: unknown, compareValue?: unknown) {
  const filters = validateAptAnalysisFilters(filtersValue)
  const comparisonFilters = compareValue == null ? null : validateAptAnalysisFilters(compareValue)
  // Comparison changes dates only; entity scope is conserved exactly.
  if (comparisonFilters && Object.keys(comparisonFilters).some(key => !DATE_KEYS.includes(key))) throw new Error('La comparación solo admite desde, hasta y cutoff; conserva las mismas OT, clientes y almacén.')
  const summary = await readSummary(supabase, filters)
  const comparison = comparisonFilters ? await readSummary(supabase, { ...filters, ...comparisonFilters }) : null
  const versionMatches = !comparison || Boolean(summary.meta?.version && comparison.meta?.version && summary.meta.version === comparison.meta.version)
  const deltas: Record<string, { current: number; previous: number; difference: number; percent: number | null }> = {}
  if (comparison && versionMatches && summary.meta?.model_fresh !== false && comparison.meta?.model_fresh !== false) {
    for (const key of ['stock_tn', 'production_tn', 'dispatch_tn', 'consumption_tn', 'returns_tn', 'weighted_age_days', 'turnover']) {
      const current = summary.kpis?.[key], previous = comparison.kpis?.[key]
      if (typeof current === 'number' && typeof previous === 'number' && Number.isFinite(current) && Number.isFinite(previous)) {
        deltas[key] = { current, previous, difference: current - previous, percent: previous === 0 ? null : (current - previous) / Math.abs(previous) * 100 }
      }
    }
  }
  const effectiveFilters = { ...filters }
  for (const key of DATE_KEYS) if (typeof summary.meta?.[key] === 'string') Object.assign(effectiveFilters, { [key]: summary.meta[key] })
  const registeredEvidence = await operationalEvidence(supabase, summary)
  return {
    registeredEvidence,
    asOf: new Date().toISOString(), source: 'apt_operational_summary', filters: effectiveFilters, summary,
    comparison: comparison ? { filters: { ...filters, ...comparisonFilters }, summary: comparison, deltas, versionMatches } : null,
    sampleTruncated: typeof summary.total === 'number' && summary.total > (summary.rows?.length || 0),
    url: '/apt/operacion',
    limitations: [
      'Inventario documental reconstruido; no constituye conciliación física.',
      'El origen y la apertura inferidos no equivalen a saldo inicial confirmado.',
      'Salida ERP no demuestra entrega conforme al cliente.',
      'No inferir causas de demora, disponibilidad para despacho ni responsables sin evidencia registrada. Las revisiones anteriores al recálculo requieren revalidación.',
      'Las filas son una muestra paginada; los KPI provienen del conjunto filtrado completo.',
      ...(summary.meta?.model_fresh === false ? ['Modelo pendiente de recálculo: cifras provisionales.'] : []),
      ...(!versionMatches ? ['La versión cambió durante la comparación; no se calculan diferencias.'] : []),
    ],
  }
}

export function formatAptAnalysisReport(result: Awaited<ReturnType<typeof getAptOperationalAnalysis>>) {
  const metrics = result.summary.kpis || {}, meta = result.summary.meta || {}
  const number = (value: unknown, unit: string) => typeof value === 'number' && Number.isFinite(value) ? `${value.toLocaleString('es-PE', { maximumFractionDigits: 2 })} ${unit}` : 'No evaluable'
  const lines = [
    'Informe operativo APT · análisis calculado por el sistema',
    `Corte: ${String(meta.cutoff || 'no informado')}. Fuente: ${result.source}.`,
    `Período: ${String(meta.desde || 'no informado')} a ${String(meta.hasta || 'no informado')}. Versión: ${String(meta.version || 'no informada')}. Base: ${String(meta.calculation_basis || 'DOCUMENTAL_RECONSTRUIDO')}; antigüedad: ${String(meta.age_basis || 'no disponible')}.`,
    `Recálculo: ${String(meta.flow_rebuilt_at || 'no informado')}. Frescura: ${meta.model_fresh === true ? 'actualizada' : 'no confirmada o pendiente'}.`,
    `Alcance solicitado: ${JSON.stringify(result.filters)}.`,
    `Stock documental: ${number(metrics.stock_tn, 'TN')}.`,
    `Producción: ${number(metrics.production_tn, 'TN')}. Salida ERP: ${number(metrics.dispatch_tn, 'TN')}.`,
    `Antigüedad ponderada: ${number(metrics.weighted_age_days, 'días')}. Rotación: ${number(metrics.turnover, 'veces')}.`,
    `Stock con origen desconocido: ${number(metrics.unknown_origin_stock_tn, 'TN')}. Saldo procedente de apertura inferida: ${number(metrics.inferred_opening_tn, 'TN')}.`,
    `Calidad de datos: ${JSON.stringify(result.summary.quality || {})}.`,
  ]
  if (result.comparison) for (const [key, delta] of Object.entries(result.comparison.deltas)) lines.push(`Comparación ${key}: actual ${delta.current}; anterior ${delta.previous}; diferencia ${delta.difference.toFixed(2)}${delta.percent === null ? '; variación porcentual no evaluable (base cero)' : `; variación ${delta.percent.toFixed(2)}%`}.`)
  const readinessRows = result.registeredEvidence.readiness.rows as Array<Record<string, unknown>>
  lines.push('Revisiones operativas registradas (solo filas de la página):')
  if (!readinessRows.length) lines.push(`No evaluable: ${String(result.registeredEvidence.readiness.reason || 'sin registros')}.`)
  for (const row of readinessRows) lines.push(`${row.almacen} / ${row.lote}: ${row.status}. Motivo registrado: ${String(row.reason || 'no registrado')}; responsable: ${String(row.responsible_name || 'no registrado')}; próxima acción: ${String(row.next_action || 'no registrada')}. ${row.review_current ? '' : 'Requiere revisión; los datos anteriores no acreditan la situación actual.'}`)
  lines.push(`Observaciones ERP/físicas registradas: ${result.registeredEvidence.reconciliation.available ? 'disponibles para la muestra consultada' : 'no disponibles'}. No certifican todo el inventario.`)
  lines.push('Límites y acciones de revisión:', ...result.limitations.map(item => `• ${item}`), 'Consultar detalle y exportar el reporte: /apt/operacion.', 'Modo de análisis calculado: se resume el alcance de la pantalla; esta modalidad no interpreta preguntas libres ni determina causas. No se utilizó un modelo generativo para esta respuesta.')
  return lines.join('\n')
}
