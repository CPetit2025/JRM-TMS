'use client'
import { useEffect, useMemo, useState } from 'react'
import { AlertCircle, Box, CalendarDays, FileText, Truck, User, Users } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { ProgrammingNotes } from '@/components/despacho/programar-ruta/ProgrammingNotes'
import type { RouteCrewPerson } from '@/components/despacho/RouteCrewDetails'
import { conformityLabels, deliveryServiceKind, deliveryStatus, type DeliveryRow } from '@/lib/delivery'
import { partyName, referenceLabel, requiresSupplier } from '@/lib/suppliers'
import { detailTime, milestones, pendingItems, type DispatchDetail, type Milestone } from '@/lib/dispatch-detail'
import { Callout, CellGrid, DetailCard, MilestoneList, MilestoneStepper, PendingList, Place, ServiceChip } from './DetailParts'

export const modalityLabel = (row: Pick<DeliveryRow, 'modalidad' | 'carrier_name'>) =>
  row.modalidad === 'TERCERO' ? `Tercero${row.carrier_name ? ` · ${row.carrier_name}` : ''}` : row.modalidad === 'RECOJO_CLIENTE' ? 'Recojo por cliente' : 'Transporte propio'
const docsLabel = (state?: string) => !state || state === 'NO_REQUERIDO' ? 'No requeridos' : state === 'LISTO' ? 'Listos' : state === 'REEMISION' ? 'Por reemitir' : 'Pendientes'
const DOT = { success: 'bg-emerald-500 text-emerald-700', warning: 'bg-orange-500 text-orange-600', danger: 'bg-rose-500 text-rose-700', neutral: 'bg-slate-400 text-slate-600' }
export const StateDot = ({ tone, children }: { tone: keyof typeof DOT; children: React.ReactNode }) =>
  <span className={`inline-flex items-center gap-2 text-sm font-medium ${DOT[tone].split(' ')[1]}`}><span aria-hidden className={`h-2.5 w-2.5 rounded-full ${DOT[tone].split(' ')[0]}`} />{children}</span>
const conformityTone = (c: DeliveryRow['conformity']): keyof typeof DOT => c === 'VALIDADA' ? 'success' : c === 'OBSERVADA' || c === 'RECHAZADA' || c === 'RECHAZO_DESTINO' ? 'danger' : c === 'NO_APLICA' || c === 'HISTORICA' ? 'neutral' : 'warning'

/** Estado actual en una frase (recuadro informativo bajo la línea de estados). */
export function currentStatus(row: DeliveryRow, detail: DispatchDetail): { title: string; text: string } {
  const m = detail.milestones
  if (m.rechazo?.kind === 'TOTAL') return { title: 'Rechazo en destino', text: `El cliente rechazó la entrega el ${detailTime(m.rechazo.at)}.` }
  if (m.conformidad?.decision === 'VALIDADA') return { title: 'Conformidad validada', text: `Validada el ${detailTime(m.conformidad.at)}${m.conformidad.by ? ` por ${m.conformidad.by}` : ''}.` }
  if (m.conformidad) return { title: 'Conformidad observada', text: m.conformidad.reason || 'La guía debe volver a enviarse.' }
  if (row.conformity === 'RECIBIDA') return { title: 'En destino', text: 'Entrega realizada. Pendiente de validación de conformidad.' }
  if (m.llegada) return { title: 'En destino', text: `Llegada registrada el ${detailTime(m.llegada)}; aún no se envía la guía.` }
  if (m.salida) return { title: 'En ruta', text: `La unidad salió el ${detailTime(m.salida)}.` }
  return { title: deliveryStatus(row.state).label, text: `Salida programada para el ${detailTime(row.scheduled_departure)}.` }
}
/** Etiquetas cortas de la línea de estados del bosquejo (Programado, En ruta, En destino, Conformidad). */
const shortSteps = (steps: Milestone[]) => steps.map(s => ({ ...s, label: s.key === 'salida' ? 'En ruta' : s.key === 'llegada' && !s.label.startsWith('Rechazo') ? 'En destino' : s.label }))

function useCrew(dispatchId: string) {
  const db = useMemo(() => createClient(), [])
  const [crew, setCrew] = useState<{ id: string; people: RouteCrewPerson[] | null }>({ id: '', people: null })
  useEffect(() => {
    let alive = true
    void Promise.resolve(db.rpc('get_tower_route_crew', { p_dispatch_id: dispatchId })).then(({ data }) => {
      const result = data as { success?: boolean; people?: RouteCrewPerson[] } | null
      if (alive) setCrew({ id: dispatchId, people: result?.success && Array.isArray(result.people) ? result.people : null })
    }).catch(() => { if (alive) setCrew({ id: dispatchId, people: null }) })
    return () => { alive = false }
  }, [db, dispatchId])
  return crew.id === dispatchId ? crew.people : undefined
}

export function ResumenTab({ row, detail }: { row: DeliveryRow; detail: DispatchDetail }) {
  const pickup = deliveryServiceKind(row) === 'RECOJO', party = partyName(row, row.client_name, row.supplier_name), driver = detail.dispatch.driver
  const crew = useCrew(row.dispatch_id), steps = milestones(detail, row), status = currentStatus(row, detail)
  return <div className="grid items-start gap-4 sm:gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(22rem,1fr)]">
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <DetailCard title="Resumen del servicio" icon={<FileText />}>
        <CellGrid cols="grid-cols-1 sm:grid-cols-6" items={[
          ['Tipo de servicio', <ServiceChip key="k" row={row} />, 'sm:col-span-2'], ['Solicitud (RT)', row.request_number, 'sm:col-span-2'], ['N.º despacho', row.dispatch_number || 'Sin número', 'sm:col-span-2'],
          ['Documento de referencia', referenceLabel(row) || (row.ot_code && row.ot_code !== 'Sin OT vinculada' ? `OT ${row.ot_code}` : 'Sin documento'), 'sm:col-span-2'],
          [requiresSupplier(row) ? 'Proveedor' : 'Cliente', party || (requiresSupplier(row) ? 'Proveedor sin vincular' : 'Cliente sin vincular'), 'sm:col-span-4'],
          [pickup ? 'Origen (recojo)' : 'Origen', <Place key="o" text={row.pickup_address} />, 'sm:col-span-3'], [pickup ? 'Destino' : 'Destino (entrega)', <Place key="d" text={row.delivery_address} />, 'sm:col-span-3'],
          ['Programación', <span key="p" className="flex items-center gap-2"><CalendarDays aria-hidden className="h-4 w-4 text-jrm-navy" />{detailTime(row.scheduled_departure)}</span>, 'sm:col-span-6'],
        ]} />
        {detail.dispatch.services_count > 1 && <p className="mt-3 text-xs text-slate-500">La ruta {row.dispatch_number} atiende {detail.dispatch.services_count} servicios; este detalle corresponde a la solicitud {row.request_number}.</p>}
        <div className="mt-3 empty:hidden"><ProgrammingNotes dispatchId={row.dispatch_id} /></div>
      </DetailCard>
      <DetailCard title="Unidad y tripulación" icon={<Users />}>
        <CellGrid cols="grid-cols-1 sm:grid-cols-2" items={[
          ['Unidad', <span key="u" className="flex items-center gap-2 font-semibold"><Truck aria-hidden className="h-5 w-5 text-jrm-navy" />{row.plate || 'Sin placa'}</span>],
          ['Conductor', <span key="c" className="flex items-start gap-2"><User aria-hidden className="mt-0.5 h-5 w-5 shrink-0 text-jrm-navy" /><span>{row.driver_name || driver?.name || (row.modalidad === 'RECOJO_CLIENTE' ? 'Unidad del cliente' : 'Sin conductor')}{driver?.document_number && <span className="block text-xs text-slate-500">DNI {driver.document_number}</span>}</span></span>],
          ['Modalidad de transporte', <span key="m" className="flex items-center gap-2"><FileText aria-hidden className="h-4 w-4 text-jrm-navy" />{modalityLabel(row)}</span>],
          ['Auxiliares', <span key="a" className="flex items-start gap-2"><Users aria-hidden className="mt-0.5 h-4 w-4 shrink-0 text-jrm-navy" />{crew === undefined ? 'Cargando…' : crew === null ? 'No disponible' : crew.length ? crew.map(p => p.name).join(', ') : 'No registrados'}</span>],
        ]} />
      </DetailCard>
      <DetailCard title="Documentos y conformidad" icon={<FileText />}>
        <div className="overflow-x-auto rounded-lg border border-slate-200"><table className="w-full min-w-[28rem] text-left text-sm">
          <thead className="bg-slate-50 text-slate-600"><tr><th className="px-3 py-2 font-medium">Documento</th><th className="px-3 py-2 font-medium">Número</th><th className="px-3 py-2 font-medium">Estado</th></tr></thead>
          <tbody className="divide-y divide-slate-200">
            <tr><td className="px-3 py-2">Guía de entrega</td><td className="px-3 py-2">{row.guide_number || '—'}</td><td className="px-3 py-2"><StateDot tone={row.guide_number ? 'success' : 'warning'}>{row.guide_number ? 'Registrado' : 'Pendiente'}</StateDot></td></tr>
            {row.note_number && <tr><td className="px-3 py-2">Nota de despacho</td><td className="px-3 py-2">{row.note_number}</td><td className="px-3 py-2"><StateDot tone="success">Registrado</StateDot></td></tr>}
            <tr><td className="px-3 py-2">Documentos de salida</td><td className="px-3 py-2">—</td><td className="px-3 py-2"><StateDot tone={!row.documents_state || row.documents_state === 'NO_REQUERIDO' ? 'neutral' : row.documents_state === 'LISTO' ? 'success' : 'warning'}>{docsLabel(row.documents_state)}</StateDot></td></tr>
            <tr><td className="px-3 py-2">Conformidad</td><td className="px-3 py-2">{row.photos_count ? `${row.photos_count} foto(s)` : '—'}</td><td className="px-3 py-2"><StateDot tone={conformityTone(row.conformity)}>{conformityLabels[row.conformity]}</StateDot></td></tr>
          </tbody>
        </table></div>
      </DetailCard>
    </div>
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <DetailCard title="Estado del despacho" icon={<Box />}>
        <MilestoneStepper steps={shortSteps(steps)} />
        <Callout title={status.title}>{status.text}</Callout>
      </DetailCard>
      <DetailCard title="Seguimiento del despacho"><MilestoneList steps={steps} columns={false} /></DetailCard>
      <DetailCard title="Pendientes" icon={<AlertCircle className="text-orange-600" />}><PendingList items={pendingItems(row)} /></DetailCard>
    </div>
  </div>
}
