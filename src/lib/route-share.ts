import { deliveryTime, type DeliveryRow } from './delivery'
export type RouteShare = {
 id: string; number: string; plate: string; status: string; departure: string; driver: string | null; driver_document: string | null
 driver_license: string | null; license_category: string | null; license_expiration: string | null; driver_phone: string | null
 auxiliaries: { name: string; code: string; document_number: string | null; position: string | null }[]
 forklift: { supplier: string; tax_id: string; operator_name: string; document_number: string | null; license_number: string | null; license_expiration: string | null; phone: string | null; notes: string | null } | null
 services: (DeliveryRow & { cargo_description?: string | null; pickup_contact?: string | null; pickup_phone?: string | null; delivery_contact?: string | null; delivery_phone?: string | null; requester_name?: string | null })[]
}
export const routeIds = (rows: Pick<DeliveryRow, 'dispatch_id'>[]) => [...new Set(rows.map(r => r.dispatch_id))]
export function routeShareText(routes: RouteShare[]): string {
 return routes.map(r => [
  `RUTA ${r.number} · ${r.plate || 'Sin placa'}`, `Estado: ${r.status.replaceAll('_', ' ')} · Salida: ${deliveryTime(r.departure)}`,
  `Conductor: ${r.driver || 'Sin registrar'} · DNI/documento: ${r.driver_document || 'Sin registrar'}`,
  `Licencia: ${r.driver_license || 'Sin registrar'}${r.license_category ? ` · ${r.license_category}` : ''}${r.license_expiration ? ` · Vence: ${r.license_expiration}` : ''}`,
  ...(r.driver_phone ? [`Teléfono: ${r.driver_phone}`] : []),
  ...[...new Set(r.services.map(s => s.carrier_name).filter(Boolean))].map(name => `Transportista: ${name}`),
  ...r.auxiliaries.map(a => `Auxiliar: ${a.code} · ${a.name} · DNI: ${a.document_number || 'Sin registrar'}${a.position ? ` · ${a.position}` : ''}`),
  ...(r.forklift ? [`Montacarga: ${r.forklift.supplier} · RUC ${r.forklift.tax_id}`, `Montacarguista: ${r.forklift.operator_name} · DNI: ${r.forklift.document_number || 'Sin registrar'} · Licencia: ${r.forklift.license_number || 'Sin registrar'}${r.forklift.license_expiration ? ` · Vence: ${r.forklift.license_expiration}` : ''}`, ...[r.forklift.phone, r.forklift.notes].filter(Boolean)] : []),
  ...r.services.map(s => [`Servicio ${s.request_number}${s.ot_code ? ` · OT ${s.ot_code}` : ''}`, `Cliente: ${s.client_name || 'Sin registrar'}${s.supplier_name ? ` · Proveedor: ${s.supplier_name}` : ''}`,
   `Origen: ${s.pickup_address || 'Sin registrar'}`, `Destino: ${s.delivery_address || 'Sin registrar'}`,
   ...[s.cargo_description && `Carga: ${s.cargo_description}`, s.requester_name && `Solicitante: ${s.requester_name}`,
    (s.pickup_contact || s.pickup_phone) && `Contacto en origen: ${[s.pickup_contact, s.pickup_phone].filter(Boolean).join(' · ')}`,
    (s.delivery_contact || s.delivery_phone) && `Contacto en destino: ${[s.delivery_contact, s.delivery_phone].filter(Boolean).join(' · ')}`].filter(Boolean),
   ...[s.reference_number && `${s.reference_type || 'Referencia'}: ${s.reference_number}`, s.guide_number && `GR: ${s.guide_number}`, s.note_number && `Nota: ${s.note_number}`].filter(Boolean),
   `Último evento: ${s.state.replaceAll('_', ' ')} · ${deliveryTime(s.last_event_at)}`].join('\n')),
 ].filter(Boolean).join('\n')).join('\n\n────────────────────\n\n')
}

export type EventSnapshot = Map<string, string>
/** Solo cambios de filas conocidas; abrir el portal o cambiar el período no genera avisos históricos. */
export function routeEventChanges(previous: EventSnapshot, rows: DeliveryRow[]) {
 const snapshot: EventSnapshot = new Map(), changes: DeliveryRow[] = []
 for (const row of rows) {
  const key = `${row.dispatch_id}/${row.request_id}`
  const latest = [...row.events].sort((a, b) => b.at.localeCompare(a.at))[0]
  const fingerprint = JSON.stringify([row.last_event_at, row.state, latest?.type, latest?.description, latest?.at])
  snapshot.set(key, fingerprint)
  if (previous.has(key) && previous.get(key) !== fingerprint) changes.push(row)
 }
 return { snapshot, changes }
}
