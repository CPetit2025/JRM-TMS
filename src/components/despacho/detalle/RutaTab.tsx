'use client'
import { AlertTriangle, Box, MapPin, Radio, Users } from 'lucide-react'
import { StatusBadge } from '@/components/ui/status-badge'
import { deliveryServiceKind, deliveryStatus, type DeliveryRow } from '@/lib/delivery'
import { detailTime, eventActor, eventTitle, gpsStatus, incidents, milestones, pendingItems, type DispatchDetail } from '@/lib/dispatch-detail'
import { DetailCard, Fields, MilestoneList, MilestoneStepper, PendingList } from './DetailParts'
import { modalityLabel } from './ResumenTab'

export function RutaTab({ row, detail }: { row: DeliveryRow; detail: DispatchDetail }) {
  const pickup = deliveryServiceKind(row) === 'RECOJO', steps = milestones(detail, row, true), current = steps.find(s => s.state === 'current' || s.state === 'alert')
  const gps = gpsStatus(detail, row), found = incidents(detail.events)
  return <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(20rem,1fr)]">
    <div className="min-w-0 space-y-4">
      <DetailCard title="Ruta programada" icon={<MapPin className="h-5 w-5" aria-hidden />}>
        <Fields items={[
          [pickup ? 'Origen (recojo)' : 'Origen', row.pickup_address || '—'], [pickup ? 'Destino' : 'Destino (entrega)', row.delivery_address || '—'],
          ['Fecha y hora programada', detailTime(row.scheduled_departure)],
          ['Distancia estimada de la ruta', detail.dispatch.estimated_distance_km ? `${Number(detail.dispatch.estimated_distance_km).toLocaleString('es-PE', { maximumFractionDigits: 1 })} km` : 'Sin registrar'],
          ['Modalidad', modalityLabel(row)], ['Unidad', row.plate || 'Sin placa'],
        ]} />
      </DetailCard>
      <DetailCard title="Seguimiento de hitos" icon={<Users className="h-5 w-5" aria-hidden />}><MilestoneList steps={steps} /></DetailCard>
      <DetailCard title="Incidencias y observaciones" icon={<AlertTriangle className="h-5 w-5" aria-hidden />}>
        {found.length ? <ul className="divide-y rounded-lg border border-slate-200">{found.map((e, i) => <li key={`${e.at}/${i}`} className="grid gap-1 p-3 text-sm sm:grid-cols-[9rem_minmax(0,1fr)]">
          <p className="tabular-nums text-slate-600">{detailTime(e.at)}</p>
          <div className="min-w-0"><p className="font-semibold text-rose-800">{eventTitle(e.type)}</p>{e.detail && <p className="whitespace-pre-wrap break-words text-slate-700">{e.detail}</p>}<p className="text-xs text-slate-500">{eventActor(e)}{e.scope === 'RUTA' && detail.dispatch.services_count > 1 ? ' · registrado en la ruta' : ''}</p></div>
        </li>)}</ul> : <p className="text-sm text-slate-500">Sin incidencias registradas.</p>}
      </DetailCard>
    </div>
    <div className="min-w-0 space-y-4">
      <DetailCard title="Estado actual" icon={<Box className="h-5 w-5" aria-hidden />}>
        <MilestoneStepper steps={steps} />
        <div className="mt-3 rounded-lg border border-blue-100 bg-blue-50 p-3 text-sm text-jrm-navy">
          <p className="font-semibold">{deliveryStatus(row.state).label}</p>
          <p className="text-xs text-slate-600">{current ? `${current.label}: ${current.note}` : 'Todos los hitos operativos registrados.'}</p>
        </div>
        <p className="mt-2 text-xs text-slate-500">El cierre operativo no cierra la parte documentaria ni la económica: cada una tiene su propio cierre.</p>
      </DetailCard>
      <DetailCard title="Seguimiento GPS" icon={<Radio className="h-5 w-5" aria-hidden />}>
        <div className="flex flex-wrap items-center gap-2"><StatusBadge tone={gps.tone}>{gps.label}</StatusBadge><span className="text-sm text-slate-600">{gps.detail}</span></div>
      </DetailCard>
      <DetailCard title="Pendientes"><PendingList items={pendingItems(row)} /></DetailCard>
    </div>
  </div>
}
