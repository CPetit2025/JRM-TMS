'use client'
import { AlertCircle, Box, FileText, Users } from 'lucide-react'
import { ServiceTypeBadge } from '@/components/ui/service-type-badge'
import { StatusBadge } from '@/components/ui/status-badge'
import { RouteCrewDetails } from '@/components/despacho/RouteCrewDetails'
import { ProgrammingNotes } from '@/components/despacho/programar-ruta/ProgrammingNotes'
import { conformityLabels, deliveryServiceKind, type DeliveryRow } from '@/lib/delivery'
import { partyName, referenceLabel, requiresSupplier } from '@/lib/suppliers'
import { detailTime, milestones, pendingItems, type DispatchDetail } from '@/lib/dispatch-detail'
import { DetailCard, Fields, MilestoneList, MilestoneStepper, PendingList } from './DetailParts'

export const modalityLabel = (row: Pick<DeliveryRow, 'modalidad' | 'carrier_name'>) =>
  row.modalidad === 'TERCERO' ? `Tercero${row.carrier_name ? ` · ${row.carrier_name}` : ''}` : row.modalidad === 'RECOJO_CLIENTE' ? 'Recojo por cliente' : 'Transporte propio'
const hasOt = (row: DeliveryRow) => !!row.ot_code && row.ot_code !== 'Sin OT vinculada'
const docsLabel = (state?: string) => !state || state === 'NO_REQUERIDO' ? 'No requeridos' : state === 'LISTO' ? 'Listos' : state === 'REEMISION' ? 'Por reemitir' : 'Pendientes'
const docsTone = (state?: string) => !state || state === 'NO_REQUERIDO' ? 'neutral' : state === 'LISTO' ? 'success' : state === 'REEMISION' ? 'danger' : 'warning'
const conformityTone = (c: DeliveryRow['conformity']) => c === 'VALIDADA' ? 'success' : c === 'OBSERVADA' || c === 'RECHAZADA' || c === 'RECHAZO_DESTINO' ? 'danger' : c === 'NO_APLICA' || c === 'HISTORICA' ? 'neutral' : 'warning'

export function ResumenTab({ row, detail }: { row: DeliveryRow; detail: DispatchDetail }) {
  const pickup = deliveryServiceKind(row) === 'RECOJO', party = partyName(row, row.client_name, row.supplier_name)
  const driver = detail.dispatch.driver
  return <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(20rem,1fr)]">
    <div className="min-w-0 space-y-4">
      <DetailCard title="Resumen del servicio" icon={<FileText className="h-5 w-5" aria-hidden />}>
        <Fields items={[
          ['Tipo de servicio', <ServiceTypeBadge key="k" kind={deliveryServiceKind(row)} full />], ['Solicitud', row.request_number], ['N.º despacho', row.dispatch_number || 'Sin número'],
          ['Documento de referencia', referenceLabel(row) || 'Sin documento'], ['OT', hasOt(row) ? row.ot_code : 'Sin OT'],
          [requiresSupplier(row) ? 'Proveedor' : 'Cliente', party || (requiresSupplier(row) ? 'Proveedor sin vincular' : 'Cliente sin vincular')],
          [pickup ? 'Origen (recojo)' : 'Origen', row.pickup_address || '—'], [pickup ? 'Destino' : 'Destino (entrega)', row.delivery_address || '—'],
          ['Programación', detailTime(row.scheduled_departure)],
        ]} />
        {detail.dispatch.services_count > 1 && <p className="mt-3 text-xs text-slate-500">La ruta {row.dispatch_number} atiende {detail.dispatch.services_count} servicios; este detalle corresponde a la solicitud {row.request_number}.</p>}
      </DetailCard>
      <ProgrammingNotes dispatchId={row.dispatch_id} />
      <DetailCard title="Unidad y tripulación" icon={<Users className="h-5 w-5" aria-hidden />}>
        <Fields items={[
          ['Unidad', row.plate || 'Sin placa'], ['Conductor', <span key="c">{row.driver_name || driver?.name || (row.modalidad === 'RECOJO_CLIENTE' ? 'Unidad del cliente' : 'Sin conductor')}{driver?.document_number && <span className="block text-xs text-slate-500">DNI {driver.document_number}</span>}</span>],
          ['Modalidad de transporte', modalityLabel(row)],
        ]} />
        <div className="mt-4 border-t border-slate-100 pt-4"><RouteCrewDetails dispatchId={row.dispatch_id} /></div>
      </DetailCard>
      <DetailCard title="Documentos y conformidad" icon={<FileText className="h-5 w-5" aria-hidden />}>
        <div className="overflow-x-auto"><table className="w-full min-w-[28rem] text-left text-sm">
          <thead className="bg-slate-50 text-xs text-slate-600"><tr><th className="p-2 font-semibold">Documento</th><th className="p-2 font-semibold">Número</th><th className="p-2 font-semibold">Estado</th></tr></thead>
          <tbody className="divide-y">
            <tr><td className="p-2">Guía de entrega</td><td className="p-2 font-medium">{row.guide_number || '—'}</td><td className="p-2"><StatusBadge tone={row.guide_number ? 'success' : 'warning'}>{row.guide_number ? 'Registrada' : 'Pendiente'}</StatusBadge></td></tr>
            {row.note_number && <tr><td className="p-2">Nota de despacho</td><td className="p-2 font-medium">{row.note_number}</td><td className="p-2"><StatusBadge tone="success">Registrada</StatusBadge></td></tr>}
            <tr><td className="p-2">Documentos de salida</td><td className="p-2">—</td><td className="p-2"><StatusBadge tone={docsTone(row.documents_state)}>{docsLabel(row.documents_state)}</StatusBadge></td></tr>
            <tr><td className="p-2">Conformidad</td><td className="p-2">{row.photos_count ? `${row.photos_count} foto(s)` : '—'}</td><td className="p-2"><StatusBadge tone={conformityTone(row.conformity)}>{conformityLabels[row.conformity]}</StatusBadge></td></tr>
          </tbody>
        </table></div>
      </DetailCard>
    </div>
    <div className="min-w-0 space-y-4">
      <DetailCard title="Estado del despacho" icon={<Box className="h-5 w-5" aria-hidden />}>
        <MilestoneStepper steps={milestones(detail, row)} />
      </DetailCard>
      <DetailCard title="Seguimiento del despacho"><MilestoneList steps={milestones(detail, row)} /></DetailCard>
      <DetailCard title="Pendientes" icon={<AlertCircle className="h-5 w-5 text-amber-600" aria-hidden />}><PendingList items={pendingItems(row)} /></DetailCard>
    </div>
  </div>
}
