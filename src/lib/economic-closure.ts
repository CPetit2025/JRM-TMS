// Cierre económico: tipos de la bandeja y del panel, etiquetas de negocio y cálculos compartidos (variación,
// desviación según el umbral configurable de economic_settings, pendientes y proveedor principal).

export type EconSettings = { deviation_pct: number; deviation_pen: number }
export type EconItem = {
  key: string; kind: 'FLETE' | 'SERVICIO'; id: string | null; concept: string; request_number: string | null
  contract_id: string | null; contract_code: string | null; origin: string | null; supplier: string | null
  referential_pen: number; agreed_pen: number; final_pen: number | null; extras_pen: number | null
  billing_unit: string | null; executed_qty: number | null; billable_qty: number | null; reason: string | null
  validated_at: string | null; validated_by: string | null; status: string
  applied_pen?: number | null; caja_pen?: number | null; observation?: string | null; approved_at?: string | null; approved_by?: string | null
}
export type EconState = { status: string; route_status: string; pending: string[]; referential_pen: number; agreed_pen: number; final_pen: number | null; extras_pen: number }
export type EconRoute = {
  dispatch_id: string; dispatch_number: string; status: string; departure: string | null; plate: string | null
  contracts: string | null; requests: string | null; state: EconState; items: EconItem[]; doc_status: string
  last: { at: string | null; by: string | null }
  // Datos de la bandeja (economic_closure_queue)
  modalidad?: string | null; carrier?: string | null; ready_at?: string | null; clients?: string | null; references?: string | null
  services?: { request_type: string | null; attention_mode: string | null }[] | null
}

export const DEFAULT_SETTINGS: EconSettings = { deviation_pct: 10, deviation_pen: 100 }
export const ITEM_LABEL: Record<string, string> = { FLETE: 'Transporte', MONTACARGAS: 'Montacarga', GRUA: 'Grúa', ESTIBA: 'Estiba', OTROS: 'Otros' }
export const ECON_STATUS: Record<string, { label: string; cls: string }> = {
  PENDIENTE: { label: 'Pendiente', cls: 'bg-amber-100 text-amber-800' },
  EN_REVISION: { label: 'En revisión', cls: 'bg-blue-100 text-blue-800' },
  OBSERVADO: { label: 'Observado', cls: 'bg-red-100 text-red-700' },
  CIERRE_PARCIAL: { label: 'Cierre parcial', cls: 'bg-violet-100 text-violet-800' },
  CERRADO: { label: 'Cerrado', cls: 'bg-emerald-100 text-emerald-800' },
  NO_APLICA: { label: 'No aplica (sin costos)', cls: 'bg-slate-100 text-slate-600' },
  RUTA_ABIERTA: { label: 'Sin cerrar en Torre', cls: 'bg-orange-100 text-orange-800' },
}
export const DOC_STATUS: Record<string, { label: string; cls: string }> = {
  COMPLETO: { label: 'Completo', cls: 'bg-emerald-100 text-emerald-800' },
  PENDIENTE: { label: 'Pendiente', cls: 'bg-amber-100 text-amber-800' },
  EN_VALIDACION: { label: 'En validación', cls: 'bg-blue-100 text-blue-800' },
  OBSERVADO: { label: 'Observado', cls: 'bg-red-100 text-red-700' },
}
export const ITEM_STATUS: Record<string, { label: string; cls: string }> = {
  POR_VALIDAR: { label: 'Por validar', cls: 'bg-amber-100 text-amber-800' },
  VALIDADO: { label: 'Validado', cls: 'bg-sky-100 text-sky-800' },
  EN_REVISION: { label: 'Enviado', cls: 'bg-blue-100 text-blue-800' },
  OBSERVADO: { label: 'Observado', cls: 'bg-red-100 text-red-700' },
  APROBADO: { label: 'Aprobado', cls: 'bg-emerald-100 text-emerald-800' },
}
export const ORIGIN_TEXT: Record<string, string> = { SOLICITUD: 'Solicitud', PROGRAMACION: 'Programación', CAJA: 'Caja', CIERRE: 'Cierre' }

/** Estado económico mostrado: una ruta sin cerrar en Torre de Control aún no entra al cierre. */
export const econKey = (r: { status: string; state: EconState }) => (['LIQUIDADO', 'CERRADO'].includes(r.status) ? r.state.status : 'RUTA_ABIERTA')

const round2 = (n: number) => Math.round(n * 100) / 100

/** Desviación acordado → final: supera el monto o el porcentaje del umbral (sin acordado, todo el final es desviación). */
export function isDeviation(agreed: number, final: number | null, s: EconSettings) {
  if (final == null) return false
  const d = Math.abs(round2(Number(final) - Number(agreed)))
  if (d < 0.01) return false
  if (d > Number(s.deviation_pen)) return true
  return Number(agreed) > 0 ? d / Number(agreed) * 100 > Number(s.deviation_pct) : true
}

export function routeSummary(r: EconRoute) {
  const items = r.items || []
  const withFinal = items.filter(i => i.final_pen != null)
  const agreed = items.reduce((a, i) => a + Number(i.agreed_pen || 0), 0)
  const agreedWithFinal = withFinal.reduce((a, i) => a + Number(i.agreed_pen || 0), 0)
  const final = withFinal.reduce((a, i) => a + Number(i.final_pen || 0), 0)
  const referential = items.reduce((a, i) => a + Number(i.referential_pen || 0), 0)
  const variation = round2(final - agreedWithFinal)
  const pending = items.filter(i => i.final_pen == null)
  const bySupplier = new Map<string, number>()
  for (const i of items) if (i.supplier) bySupplier.set(i.supplier, (bySupplier.get(i.supplier) || 0) + Number(i.final_pen ?? i.agreed_pen ?? 0))
  const suppliers = [...bySupplier.entries()].sort((a, b) => b[1] - a[1]).map(([name]) => name)
  return {
    referential: round2(referential), agreed: round2(agreed), final: withFinal.length ? round2(final) : null, agreedWithFinal: round2(agreedWithFinal),
    variation, variationPct: agreedWithFinal ? Math.round(variation / agreedWithFinal * 1000) / 10 : null,
    pending, pendingAgreed: round2(pending.reduce((a, i) => a + Number(i.agreed_pen || 0), 0)),
    approved: items.filter(i => i.status === 'APROBADO').length, validated: withFinal.length, total: items.length, suppliers,
  }
}

export const pendingText = (pending: EconItem[]) => pending.length
  ? `${pending.length} pendiente${pending.length > 1 ? 's' : ''}: ${[...new Set(pending.map(i => ITEM_LABEL[i.concept] || i.concept))].join(' + ')}`
  : ''

/** Estado de la ruta en Torre de Control, en corto para la bandeja. */
export const ROUTE_STATUS: Record<string, string> = {
  LIQUIDADO: 'Liquidada', CERRADO: 'Cerrada', RETORNO_COMPLETADO: 'Unidad liberada', ENTREGADO: 'Entregada', CIERRE_OPERATIVO: 'Cierre operativo',
}

/** Servicios de la ruta: Entrega, Recojo, Traslado o Recojo por cliente (sin repetir). */
export function serviceText(r: EconRoute) {
  const label = (s: { request_type: string | null; attention_mode: string | null }) => s.attention_mode === 'RECOJO_CLIENTE' ? 'Recojo por cliente'
    : s.request_type === 'RECOJO' ? 'Recojo' : s.request_type === 'TRASLADO' ? 'Traslado' : s.request_type === 'DESPACHO' ? 'Entrega' : s.request_type || '—'
  return [...new Set((r.services || []).map(label))].join(' + ') || '—'
}

/** Proveedor: el de mayor monto entre los ítems; sin ítems, el transportista (tercero) o JRM (flota propia). */
export const supplierText = (r: EconRoute, suppliers: string[]) => suppliers[0]
  || (r.modalidad === 'TERCERO' ? r.carrier || 'Tercero' : 'JRM (propia)')

/** Días desde que la ruta quedó lista para el cierre (cierre operativo, retorno o salida), en fecha de Lima. */
export function daysPending(v: string | null | undefined, now = new Date()) {
  if (!v) return null
  const day = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(d)
  return Math.max(0, Math.round((Date.parse(day(now)) - Date.parse(day(new Date(v)))) / 86400000))
}

export const documentaryHref = (dispatchId: string) => `/despacho/documentos?despacho=${dispatchId}&vista=liquidacion`
