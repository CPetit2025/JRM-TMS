import type { SupabaseClient } from '@supabase/supabase-js'

export type RequestService = {
  request_type: string; attention_mode?: string | null; contract_id?: string | null
  pickup_address?: string | null; delivery_address?: string | null
}

/** Tipo de servicio único para todo el sistema (tablas, detalle, filtros y exportaciones). */
export type ServiceKind = 'RECOJO' | 'RECOJO_CLIENTE' | 'ENTREGA_OT' | 'PUNTO_A_PUNTO' | 'ENTREGA'
export const SERVICE_KINDS: Record<ServiceKind, { short: string; label: string }> = {
  ENTREGA_OT: { short: 'Entrega OT', label: 'Entrega de contrato u OT' },
  RECOJO: { short: 'Recojo', label: 'Recojo hacia planta' },
  PUNTO_A_PUNTO: { short: 'Punto a punto', label: 'Entrega de punto a punto' },
  RECOJO_CLIENTE: { short: 'Recojo cliente', label: 'Recojo por el cliente en planta' },
  ENTREGA: { short: 'Entrega', label: 'Entrega sin OT vinculada' },
}
export function serviceKind(request: Partial<RequestService> | null | undefined): ServiceKind | null {
  if (!request) return null
  if (request.attention_mode === 'RECOJO_CLIENTE') return 'RECOJO_CLIENTE'
  if (request.request_type === 'RECOJO') return 'RECOJO'
  if (request.request_type === 'TRASLADO') return 'PUNTO_A_PUNTO'
  if (request.request_type === 'DESPACHO') return request.contract_id ? 'ENTREGA_OT' : 'ENTREGA'
  return null
}
export function serviceLabel(request: Partial<RequestService> | null | undefined) {
  const kind = serviceKind(request)
  return kind ? SERVICE_KINDS[kind].label : 'Tipo sin identificar'
}

/** Completa filas que solo traen request_id (Torre, Documentos) con el tipo de servicio de la solicitud. */
export async function fetchServiceTypes(db: SupabaseClient, ids: string[]) {
  const map = new Map<string, Pick<RequestService, 'request_type' | 'attention_mode' | 'contract_id'>>()
  const unique = [...new Set(ids.filter(Boolean))]
  for (let i = 0; i < unique.length; i += 150) {
    const { data, error } = await db.from('transport_requests').select('id, request_type, attention_mode, contract_id').in('id', unique.slice(i, i + 150))
    if (error) break
    for (const r of (data || []) as { id: string; request_type: string; attention_mode: string | null; contract_id: string | null }[])
      map.set(r.id, { request_type: r.request_type, attention_mode: r.attention_mode, contract_id: r.contract_id })
  }
  return map
}

export function serviceAddresses(request: RequestService) {
  if (request.attention_mode === 'RECOJO_CLIENTE' || request.request_type === 'RECOJO')
    return [{ label: 'Recojo', address: request.pickup_address || 'Sin dirección registrada' }]
  if (request.request_type === 'TRASLADO') return [
    { label: 'Origen', address: request.pickup_address || 'Sin origen registrado' },
    { label: 'Entrega', address: request.delivery_address || 'Sin destino registrado' },
  ]
  return [{ label: 'Entrega', address: request.delivery_address || 'Sin dirección registrada' }]
}

export type RequestExecutionLeg = {
  dispatch_id: string; dispatch_number: string; dispatch_status: string; stop_status: string; sequence: number | null
  vehicle_plate: string | null; driver_name: string | null; modalidad: string | null; departure: string | null
  actual_km: number | null; gps_complete: boolean | null; conformity: string; guide_number: string | null
  actual_weight_kg: number | null; weight_status: string
}
export type RequestExecution = {
  request_id: string; contract_id: string | null; ot_code: string | null; request_type: string
  attention_mode: string | null; requested_weight_kg: number | null; legs: RequestExecutionLeg[]
}

export const executionWeightLabels: Record<string, string> = {
  APT_VALIDADO: 'Guía validada · peso de SALIDA APT', SIN_GUIA_VALIDADA: 'Pendiente de guía validada',
  SIN_PESO_APT: 'Guía sin peso completo en APT', GUIA_INCOMPLETA: 'Guía sin serie: requiere identificación completa',
  GUIA_COMPARTIDA: 'Guía compartida: falta distribuir el peso por servicio',
  RECOJO_SIN_PESO: 'Recojo: no hay peso real sustentado en SALIDA APT', NO_APLICA: 'No aplica a transporte JRM',
  CANCELADO: 'Viaje cancelado · excluido de mediciones',
}
