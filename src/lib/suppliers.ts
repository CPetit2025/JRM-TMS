// Proveedores de MP, insumos, producción y proyectos (no transportistas ni talleres) y documento de referencia
// de la solicitud. Una sola lógica para formularios, tablas y detalle.
import { serviceKind, type RequestService } from '@/lib/request-service'

export const SUPPLIER_CATEGORIES = {
  MATERIA_PRIMA: 'Materia prima', INSUMOS: 'Insumos', PRODUCCION: 'Producción',
  PROYECTOS: 'Proyectos', SERVICIOS: 'Servicios', OTROS: 'Otros',
} as const
export type SupplierCategory = keyof typeof SUPPLIER_CATEGORIES

export type SupplierLocation = {
  id: string; supplier_id: string; name: string; address: string; department: string | null; province: string | null
  district: string | null; contact_name: string | null; contact_phone: string | null; is_active: boolean
}
export type Supplier = {
  id: string; tax_id: string; business_name: string; category: SupplierCategory; contact_name: string | null
  contact_phone: string | null; contact_email: string | null; notes: string | null; is_active: boolean
  supplier_locations?: SupplierLocation[]
}

export const REFERENCE_TYPES = { OC: 'Orden de compra', RQ: 'Requerimiento', OS: 'Orden de servicio' } as const
export type ReferenceType = keyof typeof REFERENCE_TYPES

type Referenced = { reference_type?: string | null; reference_number?: string | null; purchase_order?: string | null }

/** Documento de referencia: "RQ 1203". Las solicitudes antiguas guardaban la OC/OS en purchase_order. */
export function referenceLabel(r: Referenced | null | undefined): string | null {
  if (!r) return null
  if (r.reference_type && r.reference_number) return `${r.reference_type} ${r.reference_number}`
  return r.purchase_order?.trim() ? r.purchase_order.trim() : null
}

/** Los recojos y traslados punto a punto se identifican por el proveedor; las entregas, por el cliente. */
export function requiresSupplier(r: Partial<RequestService> | null | undefined): boolean {
  const kind = serviceKind(r)
  return kind === 'RECOJO' || kind === 'PUNTO_A_PUNTO'
}

/** Empresa de la fila: proveedor en recojo/punto a punto, cliente en entregas. */
export function partyName(r: Partial<RequestService> | null | undefined, client?: string | null, supplier?: string | null): string | null {
  return requiresSupplier(r) ? supplier || client || null : client || supplier || null
}

/** RUC peruano: 11 dígitos con dígito verificador. */
export function isValidRuc(value: string): boolean {
  if (!/^\d{11}$/.test(value)) return false
  const weights = [5, 4, 3, 2, 7, 6, 5, 4, 3, 2]
  const sum = weights.reduce((acc, w, i) => acc + w * Number(value[i]), 0)
  const check = (11 - (sum % 11)) % 10
  return check === Number(value[10])
}
