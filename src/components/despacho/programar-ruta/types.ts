import type { RequestRescheduling } from '@/lib/request-schedule'
import { requiresSupplier } from '@/lib/suppliers'
import { serviceDate } from '@/lib/request-schedule'

export type PlanningCarrier = { business_name: string | null }
export type PlanningVehicle = { plate: string; status: string; type: string | null; brand: string | null; model: string | null; assigned_driver_id: string | null; weight_capacity: number | null; volume_capacity: number | null; carriers: PlanningCarrier | null }
export type PlanningDriver = { id: string; first_name: string; last_name: string; document_number: string; profile_id: string | null; carriers: PlanningCarrier | null }

export interface TransportRequest {
  id: string
  request_number: string
  requester_name: string
  pickup_address: string
  delivery_address: string
  attention_mode?: 'TRANSPORTE_JRM' | 'RECOJO_CLIENTE' | null
  site_id?: string | null
  pickup_contact?: string | null
  pickup_phone?: string | null
  request_type?: string
  status: string
  created_at: string
  required_date?: string
  required_at?: string | null
  time_window?: string | null
  rescheduling?: RequestRescheduling
  contract_id?: string
  delivery_district?: string | null
  pickup_district?: string | null
  reference_type?: string | null
  reference_number?: string | null
  purchase_order?: string | null
  suppliers?: { business_name: string } | null
  supplier_id?: string | null
  client_id?: string | null
  request_client?: { business_name: string } | null
  estimated_weight?: number | null
  service_cost?: number | null
  unloading_estimate_pen?: number | null
  unloading_required?: boolean | null
  operational_approved_pen?: number | null
  transport_request_items?: Array<{ weight?: number | null; volume_m3?: number | null; quantity?: number | null }>
  contracts?: {
    id: string
    code: string
    clients?: {
      business_name: string
    }
    contract_budgets?: Array<{
      balance_pen: number
      allocated_pen: number
    }>
  }
}

export interface DispatchRequest {
  transport_request_id: string
  status: string
  document_type?: string
  document_number?: string
  transport_requests: {
    id?: string
    request_number: string
    pickup_address: string
    delivery_address: string
    delivery_district?: string | null
    request_type?: string
    attention_mode?: string | null
    contract_id?: string | null
    required_date?: string | null
    required_at?: string | null
    time_window?: string | null
    rescheduling?: RequestRescheduling
    contracts?: { code: string; clients?: { business_name: string } | null } | null
    transport_request_items?: Array<{
      weight?: number
      quantity?: number
      volume_m3?: number
    }>
  }
}

export interface Dispatch {
  id: string
  dispatch_number: string
  legacy_dispatch_number?: string | null
  driver_name: string
  driver_id?: string | null
  vehicle_plate: string
  scheduled_departure: string
  status: string
  estimated_distance_km?: number
  docs_required?: boolean
  docs_ready_at?: string | null
  docs_reissue?: boolean
  docs_reissue_reason?: string | null
  modalidad?: string | null
  tercero_salida_at?: string | null
  dispatch_requests?: DispatchRequest[]
}

// Sin proveedor (recojo / traslado) o sin cliente (entregas) una solicitud no se programa: la base también lo impide.
export function partyMissing(req: { request_type?: string; attention_mode?: string | null; supplier_id?: string | null; client_id?: string | null; contract_id?: string | null }): 'proveedor' | 'cliente' | null {
  if (requiresSupplier(req)) return req.supplier_id ? null : 'proveedor'
  return req.client_id ? null : 'cliente'
}

export function requestedAttention(request: { required_at?: string | null; required_date?: string | null; time_window?: string | null }) {
  if (request.required_at) return new Date(request.required_at).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short', hour12: false })
  return `${serviceDate(request.required_date)}${request.time_window ? ` · ${request.time_window}` : ''}`
}
