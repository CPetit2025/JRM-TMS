'use client'
// Servicios especiales pedidos en la solicitud (grúa, montacarga, estiba) que la ruta hereda.
// Al programar, el servidor los pasa a PLANIFICADO con el monto solicitado y vincula el montacarga
// a su línea: transport_unloading_costs sigue siendo la única línea por servicio.

export type InheritedLine = {
  id: string; transport_request_id: string; concept: string; description: string | null
  estimated_pen: number; planned_pen: number | null; status: string; origin: string | null
  tariff_missing: boolean | null; estimated_source: string | null
}
type Service = { id: string; request_number: string; unloading_required?: boolean | null }

export const INHERITED_LINE_COLUMNS = 'id, transport_request_id, concept, description, estimated_pen, planned_pen, status, origin, tariff_missing, estimated_source'
export const CONCEPT_LABEL: Record<string, string> = { MONTACARGAS: 'Montacargas', GRUA: 'Grúa', ESTIBA: 'Estiba', OTROS: 'Otros' }
export const ORIGIN_LABEL: Record<string, string> = { SOLICITUD: 'Solicitado', PROGRAMACION: 'Programación', CAJA: 'Caja' }
const money = (n: number) => n.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

export function unloadingAmountLabel(l: { estimated_pen: number; planned_pen?: number | null; tariff_missing?: boolean | null; estimated_source?: string | null }) {
  const amount = Number(l.planned_pen ?? l.estimated_pen ?? 0)
  if (l.estimated_source === 'MANUAL') return `S/ ${money(amount)} · manual (sin tarifa)`
  if (l.tariff_missing && amount === 0) return 'Sin tarifa'
  return `S/ ${money(amount)}`
}

export function InheritedSpecialServices({ services, lines }: { services: Service[]; lines: InheritedLine[] }) {
  if (!services.length) return null
  const none = lines.length === 0 && services.every(s => s.unloading_required !== true)
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
      <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Servicios especiales</p>
      {none ? <p className="mt-1 text-slate-600">No requiere</p> : (
        <ul className="mt-2 space-y-1.5">
          {services.map(s => {
            const own = lines.filter(l => l.transport_request_id === s.id)
            return (
              <li key={s.id} className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-semibold text-slate-800">{s.request_number}</span>
                {own.length === 0
                  ? <span className="text-slate-500">{s.unloading_required ? 'Requiere descarga · sin recurso detallado' : 'No requiere'}</span>
                  : own.map(l => (
                    <span key={l.id} className="inline-flex flex-wrap items-center gap-1.5 rounded-lg border border-slate-200 bg-slate-50 px-2 py-0.5">
                      <span>{CONCEPT_LABEL[l.concept] || l.concept}</span>
                      <span className={`tabular-nums ${l.tariff_missing ? 'text-amber-700' : 'text-slate-700'}`}>{unloadingAmountLabel(l)}</span>
                      <span className="rounded bg-blue-100 px-1.5 text-[11px] font-semibold text-blue-800">{ORIGIN_LABEL[l.origin || 'SOLICITUD'] || 'Solicitado'}</span>
                      {l.description && <span className="text-xs text-slate-500">{l.description}</span>}
                    </span>
                  ))}
              </li>
            )
          })}
        </ul>
      )}
      {lines.length > 0 && <p className="mt-2 text-[11px] text-slate-500">Al programar se planifican en la ruta con el monto solicitado. El montacarga se vincula a su línea, sin duplicar el costo.</p>}
    </div>
  )
}
