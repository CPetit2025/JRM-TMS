import type { DeliveryRow } from '@/lib/delivery'
import { requiresSupplier } from '@/lib/suppliers'

// Portal público de seguimiento: clasificación de cada servicio por su origen (OT madre, subcontrato, error u
// orden sin OT: OS, OC, RQ) y apertura de guías / Packing List con URL firmada (/api/tracking/documento).

export type PortalDocument = { id: string; type: 'GUIA_REMISION' | 'PACKING_LIST'; number: string | null; name: string | null }
export type PortalRow = DeliveryRow & {
  dispatch_status?: string; ot_type?: string | null; parent_ot?: string | null; sequence_order?: number | null
  components?: { id: string; code: string; type: string | null }[]
  supplier_name?: string | null; request_type?: string | null; attention_mode?: string | null
  documents?: PortalDocument[]; signed_photos?: number; packing_photos?: number
}
export type PortalOrigin = 'OT' | 'SUB' | 'ERR' | 'OS' | 'OC' | 'RQ' | 'SIN'
type Source = {
  ot_code?: string | null; ot_type?: string | null; reference_type?: string | null
  reference_number?: string | null; purchase_order?: string | null
}

export const PORTAL_ORIGINS: { key: PortalOrigin; label: string; chip: string; bar: string }[] = [
  { key: 'OT', label: 'OT', chip: 'bg-blue-50 text-blue-800 border-blue-200', bar: 'border-l-blue-600' },
  { key: 'SUB', label: 'Subcontrato', chip: 'bg-violet-50 text-violet-800 border-violet-200', bar: 'border-l-violet-600' },
  { key: 'ERR', label: 'Error', chip: 'bg-rose-50 text-rose-800 border-rose-200', bar: 'border-l-rose-600' },
  { key: 'OS', label: 'OS', chip: 'bg-teal-50 text-teal-800 border-teal-200', bar: 'border-l-teal-600' },
  { key: 'OC', label: 'OC', chip: 'bg-amber-50 text-amber-900 border-amber-200', bar: 'border-l-amber-500' },
  { key: 'RQ', label: 'RQ', chip: 'bg-cyan-50 text-cyan-800 border-cyan-200', bar: 'border-l-cyan-600' },
  { key: 'SIN', label: 'Sin referencia', chip: 'bg-slate-100 text-slate-700 border-slate-200', bar: 'border-l-slate-400' },
]
export const originStyle = (key: PortalOrigin) => PORTAL_ORIGINS.find(o => o.key === key)!

const hasOt = (s: Source) => !!s.ot_code && s.ot_code !== 'Sin OT vinculada'
// «RQ-7781» ya trae el prefijo: no repetirlo («RQ RQ-7781»)
const ref = (type: string, number: string) => number.toUpperCase().startsWith(type) ? number : `${type} ${number}`

/** Tipo de OT: el sufijo del código manda (15304-E001 es error, 15304-S001 subcontrato) aunque el registro diga otra cosa. */
export function otKind(code: string | null | undefined, type: string | null | undefined): 'CONTRATO' | 'SUBCONTRATO' | 'ERROR' {
  if (/-E\d+$/i.test(code || '')) return 'ERROR'
  if (/-S\d+$/i.test(code || '')) return 'SUBCONTRATO'
  return type === 'ERROR' || type === 'SUBCONTRATO' ? type : 'CONTRATO'
}

export function portalOrigin(s: Source): PortalOrigin {
  if (hasOt(s)) { const kind = otKind(s.ot_code, s.ot_type); return kind === 'SUBCONTRATO' ? 'SUB' : kind === 'ERROR' ? 'ERR' : 'OT' }
  if (s.reference_type === 'OS' || s.reference_type === 'OC' || s.reference_type === 'RQ') return s.reference_type
  return s.purchase_order ? 'OC' : 'SIN'
}

/** Texto corto de la referencia principal: «OT 15304-S001», «OS 4500123», «OC 778». */
export function portalReference(s: Source): string {
  if (hasOt(s)) return `OT ${s.ot_code}`
  if (s.reference_type && s.reference_number) return ref(s.reference_type, s.reference_number)
  if (s.purchase_order) return ref('OC', s.purchase_order)
  return 'Sin referencia'
}

/** Referencias secundarias (orden del cliente u OC del proveedor) cuando la principal es la OT. */
export function portalExtraRefs(s: Source): string[] {
  const out: string[] = []
  if (hasOt(s) && s.reference_type && s.reference_number) out.push(ref(s.reference_type, s.reference_number))
  if (s.purchase_order && !(s.reference_type === 'OC' && s.reference_number === s.purchase_order) && (hasOt(s) || s.reference_type)) out.push(ref('OC', s.purchase_order))
  return out
}

export const DOC_LABEL: Record<PortalDocument['type'], string> = { GUIA_REMISION: 'Guía', PACKING_LIST: 'Packing List' }

/** Abre un documento del portal. La ventana se abre antes de la consulta para que el navegador no la bloquee. */
// Acceso al portal: enlace + código (clientes) o la sede desde el TMS (usuario con sesión, sin código)
export type PortalAccess = { token: string; pin: string } | { site: string }
export async function openPortalDocument(access: PortalAccess, target: { kind: 'DOC'; id: string } | { kind: 'FIRMA' | 'PACKING'; dispatchId: string; requestId: string; index: number }) {
  const win = window.open('', '_blank')
  try {
    const res = await fetch('/api/tracking/documento', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...access, ...(target.kind === 'DOC'
        ? { kind: 'DOC', id: target.id }
        : { kind: target.kind, id: target.dispatchId, request_id: target.requestId, index: target.index }) }),
    })
    const data = await res.json().catch(() => null) as { success?: boolean; url?: string; error?: string } | null
    if (!res.ok || !data?.url) throw new Error(data?.error || 'Documento no disponible')
    if (win) { win.opener = null; win.location.href = data.url } else window.location.href = data.url
  } catch (error) {
    win?.close()
    throw error
  }
}

// Estado visible en el portal (5 estados de negocio):
// Solicitado: solo registro · Programado: ruta con placa y conductor · En ruta: el conductor inició en el app
// Completado: ruta terminada con documentos conformes (guía validada) · En revisión documental: la guía ya se cargó
// pero aún no se valida (cargar no es liquidar) · Cierre operativo: flota liberada sin haber cargado la documentación.
// Cancelado, Observada y Rechazada en destino se conservan como excepciones. «live» enciende la luz intermitente.
export type PortalTone = { label: string; bg: string; text: string; dot: string; live: boolean }
const TONE = {
  slate: { bg: 'bg-slate-100 ring-slate-300', text: 'text-slate-700', dot: 'bg-slate-400' },
  sky: { bg: 'bg-sky-100 ring-sky-300', text: 'text-sky-900', dot: 'bg-sky-500' },
  blue: { bg: 'bg-blue-100 ring-blue-400', text: 'text-blue-900', dot: 'bg-blue-600' },
  amber: { bg: 'bg-amber-100 ring-amber-400', text: 'text-amber-950', dot: 'bg-amber-500' },
  emerald: { bg: 'bg-emerald-100 ring-emerald-300', text: 'text-emerald-900', dot: 'bg-emerald-600' },
  red: { bg: 'bg-red-100 ring-red-300', text: 'text-red-900', dot: 'bg-red-600' },
  orange: { bg: 'bg-orange-100 ring-orange-300', text: 'text-orange-900', dot: 'bg-orange-500' },
  violet: { bg: 'bg-violet-100 ring-violet-300', text: 'text-violet-900', dot: 'bg-violet-600' },
}
const tone = (label: string, t: keyof typeof TONE, live = false): PortalTone => ({ label, ...TONE[t], live })
const STATUS = {
  solicitado: () => tone('Solicitado', 'slate'),
  programado: () => tone('Programado', 'sky', true),
  enRuta: () => tone('En ruta', 'blue', true),
  completado: () => tone('Completado', 'emerald'),
  revision: () => tone('En revisión documental', 'violet', true),
  cierre: () => tone('Cierre operativo', 'amber', true),
  cancelado: () => tone('Cancelado', 'red'),
  rechazada: () => tone('Rechazada en destino', 'red', true),
}
// Documentos conformes: guía validada, histórica o no requerida (recojo por el cliente).
const DOCS_OK = ['VALIDADA', 'HISTORICA', 'NO_APLICA']
// Guía ya cargada (por el conductor, el tercero o en Documentos) a la espera de validación o corrección.
const DOCS_LOADED = ['RECIBIDA', 'PENDIENTE_VALIDACION', 'OBSERVADA', 'RECHAZADA']
const FINISHED = ['ENTREGADO', 'COMPLETADO', 'LIQUIDADO', 'CERRADO', 'CIERRE_OPERATIVO']
const MOVING = ['EN RUTA', 'EN_RUTA', 'EN_CURSO', 'EN_DESTINO', 'EN_TRANSITO', 'EN TRANSITO']

export function portalStatus(row: { state: string; dispatch_status?: string; conformity?: string | null } | null | undefined, requestStatus?: string): PortalTone {
  if (row) {
    const route = row.dispatch_status || row.state
    if (route === 'CANCELADO' || row.state === 'CANCELADO') return STATUS.cancelado()
    // El cliente no recibió la carga: queda visible hasta que Despacho reprograme o anule el servicio
    if (row.state === 'RECHAZADO_DESTINO') return STATUS.rechazada()
    const finished = FINISHED.includes(route) || ['ENTREGADO', 'LIQUIDADO', 'CERRADO', 'RECIBIDA', 'PENDIENTE_VALIDACION', 'OBSERVADA', 'RECHAZADA'].includes(row.state)
    if (finished || route === 'CIERRE_OPERATIVO') {
      if (DOCS_OK.includes(row.conformity || '')) return STATUS.completado()
      return DOCS_LOADED.includes(row.conformity || '') ? STATUS.revision() : STATUS.cierre()
    }
    if (MOVING.includes(route) || ['EN_DESTINO', 'INCIDENCIA'].includes(row.state)) return STATUS.enRuta()
    return STATUS.programado()
  }
  switch (requestStatus || '') {
    case 'OBSERVADA': return tone('Observada', 'orange')
    case 'ASIGNADA': return STATUS.programado()
    case 'EN_TRANSITO': case 'EN TRANSITO': return STATUS.enRuta()
    case 'ENTREGADA': return STATUS.completado()
    case 'CANCELADA': case 'ANULADA': case 'RECHAZADA': return STATUS.cancelado()
  }
  return STATUS.solicitado()
}

/** Empresa del servicio: proveedor en recojos y traslados, cliente en entregas (y recojo por el cliente). */
export function portalParty(r: { request_type?: string | null; attention_mode?: string | null; client_name?: string | null; supplier_name?: string | null }) {
  const supplier = requiresSupplier({ request_type: r.request_type ?? undefined, attention_mode: r.attention_mode ?? undefined })
  return { label: supplier ? 'Proveedor' : 'Cliente', name: (supplier ? r.supplier_name : r.client_name) || null }
}
