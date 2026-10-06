export type RequestService = {
  request_type: string; attention_mode?: string | null; contract_id?: string | null
  pickup_address?: string | null; delivery_address?: string | null
}

export function serviceLabel(request: RequestService) {
  if (request.attention_mode === 'RECOJO_CLIENTE') return 'Recojo por el cliente'
  if (request.request_type === 'RECOJO') return 'Recojo hacia planta'
  if (request.request_type === 'TRASLADO') return 'Entrega de punto a punto'
  if (request.request_type === 'DESPACHO') return request.contract_id ? 'Entrega de contrato' : 'Entrega'
  return 'Tipo sin identificar'
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
