import { serviceKind, type ServiceKind } from '@/lib/request-service'
export type Conformity = 'PENDIENTE' | 'RECIBIDA' | 'OBSERVADA' | 'RECHAZADA' | 'VALIDADA' | 'HISTORICA' | 'NO_APLICA'
export type DeliveryRow = {
  dispatch_id: string; request_id: string; dispatch_number: string; request_number: string
  ot_code: string; client_name: string | null; pickup_address: string; delivery_address: string
  plate: string; driver_name: string | null; carrier_name: string | null; modalidad: string | null
  scheduled_departure: string; guide_number: string | null; conformity: Conformity
  documents_state?: string; submission_id: string | null; photos_count: number; submitted_at: string | null; arrived_at: string | null
  state: string; last_event_at: string; gps_at: string | null
  events: { type: string; description: string | null; at: string }[]
  /** Tipo de la solicitud (se completa en la pantalla con fetchServiceTypes) */
  request_type?: string; attention_mode?: string | null; contract_id?: string | null
  supplier_name?: string | null; reference_type?: string | null; reference_number?: string | null; purchase_order?: string | null
}
/** Tipo de servicio de una entrega: usa los datos de la solicitud; sin ellos, solo reconoce el recojo por el cliente. */
export function deliveryServiceKind(row: DeliveryRow): ServiceKind | null {
  return row.request_type ? serviceKind(row) : row.modalidad === 'RECOJO_CLIENTE' ? 'RECOJO_CLIENTE' : null
}
export type DeliverySubmission = {
  id: string; operation_id: string; photos: string[]; packing_photos?: string[]; guide_number: string | null; received_by: string | null
  note: string | null; source: string; captured_at: string; submitted_at: string
  review: { decision: string; reason: string | null; reviewed_at: string } | null
}
export type DeliveryDetail = { state: Conformity; arrived_at: string | null; can_review: boolean; submissions: DeliverySubmission[] }
export const conformityLabels: Record<Conformity, string> = {
  PENDIENTE: 'Guía pendiente', RECIBIDA: 'Pendiente de validación', OBSERVADA: 'Observada', RECHAZADA: 'Rechazada',
  VALIDADA: 'Aprobada', HISTORICA: 'Histórica', NO_APLICA: 'Recojo por cliente · nota de salida',
}
export function deliveryStatus(state: string) {
  switch (state) {
    case 'RECOJO_CLIENTE': return { label: 'Recojo por cliente', color: 'bg-slate-100 text-slate-700', dot: 'bg-slate-500', pulse: false }
    case 'PROGRAMADO': return { label: 'Programado', color: 'bg-slate-100 text-slate-700', dot: 'bg-slate-500', pulse: false }
    case 'EN RUTA': case 'EN_CURSO': return { label: 'En ruta', color: 'bg-blue-50 text-blue-800', dot: 'bg-blue-500', pulse: true }
    case 'EN_DESTINO': return { label: 'En destino', color: 'bg-amber-50 text-amber-900', dot: 'bg-amber-500', pulse: true }
    case 'RECIBIDA': case 'PENDIENTE_VALIDACION': return { label: 'Validación pendiente', color: 'bg-amber-50 text-amber-900', dot: 'bg-amber-500', pulse: true }
    case 'OBSERVADA': case 'RECHAZADA': case 'INCIDENCIA': return { label: state === 'INCIDENCIA' ? 'Incidencia' : state === 'OBSERVADA' ? 'Observada' : 'Rechazada', color: 'bg-red-50 text-red-800', dot: 'bg-red-500', pulse: true }
    case 'ENTREGADO': return { label: 'Entregado', color: 'bg-emerald-50 text-emerald-800', dot: 'bg-emerald-500', pulse: false }
    case 'LIQUIDADO': case 'CERRADO': return { label: 'Viaje cerrado', color: 'bg-emerald-50 text-emerald-900', dot: 'bg-emerald-700', pulse: false }
    case 'RETORNO': case 'RETORNO_COMPLETADO': case 'ESPERANDO_AUTORIZACION': return { label: state === 'RETORNO' ? 'En retorno' : state === 'RETORNO_COMPLETADO' ? 'En base' : 'Espera autorización', color: 'bg-blue-50 text-blue-800', dot: 'bg-blue-500', pulse: state === 'RETORNO' }
    case 'CANCELADO': return { label: 'Cancelado', color: 'bg-slate-100 text-slate-600', dot: 'bg-slate-400', pulse: false }
    default: return { label: state.replaceAll('_', ' ') || 'Sin estado', color: 'bg-slate-100 text-slate-700', dot: 'bg-slate-500', pulse: false }
  }
}
export const deliveryTime = (value: string | null) => value ? new Date(value).toLocaleString('es-PE', {
  timeZone: 'America/Lima', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
}) : '—'
export function filterDeliveries(rows: DeliveryRow[], search: string, state: string, conformity: string) {
  const needle = search.trim().toLocaleLowerCase('es-PE')
  return rows.filter(row => (!state || row.state === state) && (!conformity || row.conformity === conformity) &&
    (!needle || [row.ot_code, row.request_number, row.dispatch_number, row.guide_number, row.client_name,
      row.plate, row.driver_name, row.carrier_name, row.pickup_address, row.delivery_address].join(' ').toLocaleLowerCase('es-PE').includes(needle)))
}
// Camera photos are reduced before upload/queuing; server independently decodes them.
export async function deliveryPhoto(file: File): Promise<File> {
  const bitmap = await createImageBitmap(file)
  try {
    const ratio = Math.min(1, 1280 / Math.max(bitmap.width, bitmap.height))
    const canvas = document.createElement('canvas')
    canvas.width = Math.round(bitmap.width * ratio); canvas.height = Math.round(bitmap.height * ratio)
    const context = canvas.getContext('2d')
    if (!context) throw Error('No se pudo preparar la fotografía')
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height)
    const blob = await new Promise<Blob | null>(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.8))
    if (!blob) throw Error('No se pudo preparar la fotografía')
    return new File([blob], 'guia.jpg', { type: 'image/jpeg' })
  } finally { bitmap.close() }
}
