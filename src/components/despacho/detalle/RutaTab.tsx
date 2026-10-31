'use client'
import { AlertCircle, AlertTriangle, Box, CalendarDays, Clock, FileText, Info, MapPin, Route, Truck, Users } from 'lucide-react'
import { deliveryServiceKind, type DeliveryRow } from '@/lib/delivery'
import { detailTime, durationLabel, eventActor, eventTitle, gpsStatus, milestones, pendingItems, type DetailEvent, type DispatchDetail } from '@/lib/dispatch-detail'
import { Callout, CellGrid, DetailCard, MilestoneList, MilestoneStepper, PendingList, Place } from './DetailParts'
import { currentStatus, modalityLabel } from './ResumenTab'
import { RouteTrack } from './RouteTrack'

/** Novedades registradas: incidencias, observaciones de Monitoreo, llegada y rechazo (sin cambios de estado ni avisos inventados). */
const observations = (events: DetailEvent[]) => events.filter(e => e.level === 'INCIDENCIA'
  || (e.source === 'OPERACION' && e.type !== 'STATUS_CHANGE') || e.type === 'LLEGADA_DESTINO' || e.type.startsWith('RECHAZO_'))
const GPS_DOT = { success: 'bg-emerald-500', warning: 'bg-amber-500', danger: 'bg-rose-500', neutral: 'bg-slate-400' }

export function RutaTab({ row, detail }: { row: DeliveryRow; detail: DispatchDetail }) {
  const pickup = deliveryServiceKind(row) === 'RECOJO', steps = milestones(detail, row, true), status = currentStatus(row, detail)
  const gps = gpsStatus(detail, row), found = observations(detail.events), est = detail.estimate
  const km = est?.distance_km ?? detail.dispatch.estimated_distance_km
  return <div className="grid items-start gap-4 sm:gap-5 xl:grid-cols-[minmax(0,1.45fr)_minmax(22rem,1fr)]">
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <DetailCard title="Ruta programada" icon={<MapPin />}>
        <CellGrid cols="grid-cols-1 sm:grid-cols-4" items={[
          [pickup ? 'Origen (recojo)' : 'Origen', <Place key="o" text={row.pickup_address} />, 'sm:col-span-2'], [pickup ? 'Destino' : 'Destino (entrega)', <Place key="d" text={row.delivery_address} />, 'sm:col-span-2'],
          ['Fecha y hora programada', <span key="f" className="flex items-center gap-2"><CalendarDays aria-hidden className="h-4 w-4 text-jrm-navy" />{detailTime(row.scheduled_departure)}</span>],
          ['Distancia estimada', <span key="k" className="flex items-center gap-2"><Route aria-hidden className="h-4 w-4 text-jrm-navy" />{km ? `${Number(km).toLocaleString('es-PE', { maximumFractionDigits: 1 })} km${!est?.distance_km && detail.dispatch.services_count > 1 ? ' (ruta)' : ''}` : 'Sin registrar'}</span>],
          ['Tiempo estimado', <span key="t" className="flex items-center gap-2"><Clock aria-hidden className="h-4 w-4 text-jrm-navy" />{durationLabel(est?.duration_min) || 'Sin estimar'}</span>],
          ['Modalidad', <span key="m" className="flex items-center gap-2"><Truck aria-hidden className="h-4 w-4 text-jrm-navy" />{modalityLabel(row)}</span>],
        ]} />
        {est && <p className="mt-2 text-xs text-slate-500">Distancia y tiempo estimados por OSRM al programar la ruta ({detailTime(est.computed_at)}).</p>}
      </DetailCard>
      <DetailCard title="Seguimiento de hitos" icon={<Users />}><MilestoneList steps={steps} /></DetailCard>
      <DetailCard title="Incidencias y observaciones" icon={<FileText />}>
        {found.length ? <ul className="divide-y divide-slate-200 overflow-hidden rounded-lg border border-slate-200">{found.map((e, i) => <li key={`${e.at}/${i}`} className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 gap-y-1 p-3 text-sm sm:grid-cols-[2rem_11rem_minmax(0,1fr)]">
          <span aria-hidden className={`grid h-7 w-7 place-items-center rounded-full ${e.level === 'INCIDENCIA' ? 'bg-rose-100 text-rose-600' : e.type === 'LLEGADA_DESTINO' ? 'bg-blue-600 text-white' : 'bg-slate-500 text-white'}`}>
            {e.level === 'INCIDENCIA' ? <AlertTriangle className="h-4 w-4" /> : e.type === 'LLEGADA_DESTINO' ? <Info className="h-4 w-4" /> : <AlertCircle className="h-4 w-4" />}</span>
          <p className="tabular-nums text-slate-600 sm:pt-1">{detailTime(e.at)}</p>
          <div className="col-start-2 min-w-0 sm:col-start-3"><p className={`font-semibold ${e.level === 'INCIDENCIA' ? 'text-rose-700' : 'text-slate-800'}`}>{eventTitle(e.type)}</p>
            {e.detail && <p className="whitespace-pre-wrap break-words text-slate-600">{e.detail}</p>}
            <p className="text-xs text-slate-400">{eventActor(e)}{e.scope === 'RUTA' && detail.dispatch.services_count > 1 ? ' · registrado en la ruta' : ''}</p></div>
        </li>)}</ul> : <p className="text-sm text-slate-500">Sin incidencias ni observaciones registradas.</p>}
      </DetailCard>
    </div>
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <DetailCard title="Estado actual" icon={<Box />}>
        <MilestoneStepper steps={steps} />
        <Callout title={status.title}>{status.text}</Callout>
        <p className="mt-3 text-xs text-slate-500">El cierre operativo no cierra la parte documentaria ni la económica: cada una tiene su propio cierre.</p>
      </DetailCard>
      <DetailCard title="Tracking" icon={<MapPin />}>
        <RouteTrack dispatchId={row.dispatch_id} gps={detail.presence.applies} estimate={est || null} origin={row.pickup_address} destination={row.delivery_address} />
        <dl className="mt-3 grid grid-cols-2 divide-x divide-slate-200 text-sm">
          <div className="pr-3"><dt className="text-xs text-slate-500">Última actualización</dt><dd className="font-medium text-slate-800">{detail.presence.gps_at ? detailTime(detail.presence.gps_at) : '—'}</dd></div>
          <div className="pl-3"><dt className="text-xs text-slate-500">Estado GPS</dt><dd className="flex items-center gap-2 font-semibold text-slate-800"><span aria-hidden className={`h-2.5 w-2.5 rounded-full ${GPS_DOT[gps.tone]}`} />{gps.label}</dd>
            <dd className="text-xs text-slate-500">{gps.detail}</dd></div>
        </dl>
      </DetailCard>
      <DetailCard title="Pendientes" icon={<AlertCircle className="text-orange-600" />}><PendingList items={pendingItems(row)} /></DetailCard>
    </div>
  </div>
}
