import type { DeliveryRow } from '@/lib/delivery'

// Portal público de seguimiento: clasificación de cada servicio por su origen (OT madre, subcontrato, error u
// orden sin OT: OS, OC, RQ) y apertura de guías / Packing List con URL firmada (/api/tracking/documento).

export type PortalDocument = { id: string; type: 'GUIA_REMISION' | 'PACKING_LIST'; number: string | null; name: string | null }
export type PortalRow = DeliveryRow & {
  dispatch_status?: string; ot_type?: string | null; sequence_order?: number | null
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
export async function openPortalDocument(access: { token: string; pin: string }, target: { kind: 'DOC'; id: string } | { kind: 'FIRMA' | 'PACKING'; dispatchId: string; requestId: string; index: number }) {
  const win = window.open('', '_blank')
  try {
    const res = await fetch('/api/tracking/documento', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(target.kind === 'DOC'
        ? { token: access.token, pin: access.pin, kind: 'DOC', id: target.id }
        : { token: access.token, pin: access.pin, kind: target.kind, id: target.dispatchId, request_id: target.requestId, index: target.index }),
    })
    const data = await res.json().catch(() => null) as { success?: boolean; url?: string; error?: string } | null
    if (!res.ok || !data?.url) throw new Error(data?.error || 'Documento no disponible')
    if (win) { win.opener = null; win.location.href = data.url } else window.location.href = data.url
  } catch (error) {
    win?.close()
    throw error
  }
}

// Estado visible en el portal: el de la parada si ya tiene ruta; si no, el de la solicitud.
export type PortalTone = { label: string; bg: string; text: string }
const TONE = {
  slate: { bg: 'bg-slate-200', text: 'text-slate-800' }, sky: { bg: 'bg-sky-200', text: 'text-sky-900' },
  blue: { bg: 'bg-blue-300', text: 'text-blue-950' }, amber: { bg: 'bg-amber-200', text: 'text-amber-950' },
  emerald: { bg: 'bg-emerald-200', text: 'text-emerald-900' }, violet: { bg: 'bg-violet-200', text: 'text-violet-900' },
  red: { bg: 'bg-red-200', text: 'text-red-900' }, orange: { bg: 'bg-orange-200', text: 'text-orange-900' },
}
const tone = (label: string, t: keyof typeof TONE): PortalTone => ({ label, ...TONE[t] })
export function portalStatus(row: { state: string } | null | undefined, requestStatus?: string): PortalTone {
  if (row) switch (row.state) {
    case 'PROGRAMADO': return tone('Programado', 'sky')
    case 'EN RUTA': case 'EN_CURSO': return tone('En ruta', 'blue')
    case 'EN_DESTINO': return tone('En destino', 'amber')
    case 'ENTREGADO': case 'LIQUIDADO': case 'CERRADO': return tone('Entregado', 'emerald')
    case 'PENDIENTE_VALIDACION': return tone('Guía recibida', 'violet')
    case 'OBSERVADA': case 'RECHAZADA': return tone('Guía observada', 'red')
    case 'INCIDENCIA': return tone('Incidencia', 'red')
    case 'CANCELADO': return tone('Cancelado', 'red')
    case 'RECOJO_CLIENTE': return tone('Recojo por cliente', 'slate')
  }
  switch (requestStatus || '') {
    case 'PENDIENTE': case 'PENDIENTE DE APROBACIÓN': case 'APROBADA': return tone('Solicitado', 'slate')
    case 'OBSERVADA': return tone('Observada', 'orange')
    case 'REPROGRAMADA': return tone('Reprogramado', 'orange')
    case 'ASIGNADA': return tone('Programado', 'sky')
    case 'EN_TRANSITO': case 'EN TRANSITO': return tone('En ruta', 'blue')
    case 'ENTREGADA': return tone('Entregado', 'emerald')
    case 'CANCELADA': case 'ANULADA': case 'RECHAZADA': return tone('Cancelado', 'red')
  }
  return tone((row?.state || requestStatus || '—').replaceAll('_', ' ').toLowerCase().replace(/^./, c => c.toUpperCase()), 'slate')
}
