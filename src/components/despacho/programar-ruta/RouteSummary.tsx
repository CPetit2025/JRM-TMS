'use client'
import type { ReactNode } from 'react'
import { AlertTriangle, CalendarClock, CircleAlert, Info, ListChecks, Receipt, Truck, Users, Wallet } from 'lucide-react'
import { RouteCubicaje } from '@/components/despacho/RouteCubicaje'
import { specialServicesTotal, CONCEPT_LABEL } from '@/components/despacho/InheritedSpecialServices'
import { districtOf } from '@/lib/address'
import { cellDateTime } from '@/lib/table-format'
import type { RouteCheck, RouteStep } from './route-checks'
import type { RouteBuilder } from './useRouteBuilder'

const money = (n: number) => n.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const Pending = () => <span className="font-semibold text-amber-700">Pendiente</span>
const Estimated = () => <span className="ml-1 rounded bg-slate-100 px-1 text-[10px] font-semibold uppercase text-slate-500">estimado</span>

function Block({ icon, title, step, onGo, children }: { icon: ReactNode; title: string; step?: RouteStep; onGo: (s: RouteStep) => void; children: ReactNode }) {
  return <section className="border-t border-slate-200 pt-3">
    <div className="mb-2 flex items-center justify-between gap-2">
      <h4 className="flex items-center gap-2 text-sm font-semibold text-[#002855]">{icon}{title}</h4>
      {step && <button type="button" onClick={() => onGo(step)} className="text-xs font-semibold text-blue-700 hover:underline">Editar</button>}
    </div>
    <dl className="space-y-1 text-xs">{children}</dl>
  </section>
}
const Row = ({ label, children }: { label: string; children: ReactNode }) =>
  <div className="flex justify-between gap-3"><dt className="text-slate-500">{label}</dt><dd className="min-w-0 truncate text-right font-semibold text-slate-900">{children}</dd></div>

const TONE = {
  block: ['border-red-200 bg-red-50 text-red-800', CircleAlert],
  warn: ['border-amber-200 bg-amber-50 text-amber-900', AlertTriangle],
  info: ['border-blue-200 bg-blue-50 text-blue-900', Info],
} as const

export function RouteAlerts({ checks, onGo, limit }: { checks: RouteCheck[]; onGo: (s: RouteStep) => void; limit?: number }) {
  const order = { block: 0, warn: 1, info: 2 }
  const sorted = [...checks].sort((a, b) => order[a.level] - order[b.level] || a.step - b.step)
  const shown = limit ? sorted.slice(0, limit) : sorted
  return <ul className="space-y-1.5">{shown.map(c => {
    const [tone, Icon] = TONE[c.level]
    return <li key={c.key}><button type="button" onClick={() => onGo(c.step)} className={`flex w-full items-start gap-2 rounded-lg border px-2.5 py-1.5 text-left text-xs ${tone}`}>
      <Icon className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 flex-1">{c.label}</span>
      <span className="shrink-0 text-[10px] font-semibold opacity-70">Paso {c.step}</span>
    </button></li>
  })}{limit && sorted.length > limit && <li className="text-[11px] text-slate-500">y {sorted.length - limit} más en Validación</li>}</ul>
}

export function RouteSummary({ rb, onGo }: { rb: RouteBuilder; onGo: (s: RouteStep) => void }) {
  const nd = rb.newDispatch
  const gr = nd.document_type === 'GR'
  const services = rb.selectedServices
  const extras = specialServicesTotal(rb.inheritedLines, rb.specialServices, rb.routeForklift)
  const diffPct = rb.referentialFreight > 0 ? ((rb.routeFreight - rb.referentialFreight) / rb.referentialFreight) * 100 : null
  const tercero = rb.modalidad === 'TERCERO'
  const plate = tercero ? rb.tercero.placa : nd.vehicle_plate
  const driver = tercero ? rb.tercero.conductor : nd.driver_name
  const first = services[0]
  const origin = first ? districtOf(first.pickup_address, first.pickup_district) : ''
  const blockers = rb.blockers.length
  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-base font-bold text-[#002855]">Resumen de programación</h3>
        <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${blockers ? 'bg-amber-100 text-amber-800' : 'bg-emerald-100 text-emerald-800'}`}>{blockers ? `${blockers} pendiente${blockers > 1 ? 's' : ''}` : 'Lista'}</span>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <div className="rounded-lg border border-slate-200 p-2.5"><p className="text-[11px] text-slate-500">Servicios</p><p className="text-xl font-bold tabular-nums text-[#002855]">{services.length}</p><p className="text-[11px] text-slate-500">{services.length === 1 ? '1 parada' : `${services.length} paradas`}</p></div>
        <div className="rounded-lg border border-slate-200 p-2.5"><p className="flex items-center gap-1 text-[11px] text-slate-500"><Wallet className="h-3 w-3" />Flete acordado</p>
          <p className="text-xl font-bold tabular-nums text-[#002855]">{!gr ? '—' : rb.ownInternalOnly ? 'S/ 0' : rb.manualFreightCost.trim() ? `S/ ${money(rb.routeFreight)}` : <span className="text-base text-amber-700">Pendiente</span>}</p>
          {gr && <p className="text-[11px] text-slate-500">Ref.: S/ {money(rb.referentialFreight)}{diffPct != null && Math.abs(diffPct) >= 0.05 && rb.manualFreightCost.trim() && <b className={`ml-1 ${diffPct > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>{diffPct > 0 ? '+' : ''}{diffPct.toFixed(1)}%</b>}</p>}
        </div>
      </div>
      {services.length > 0 && <ol className="space-y-1">{services.map((req, i) => <li key={req.id} className="flex items-center gap-2 text-xs">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full bg-[#002855] text-[10px] font-bold text-white">{i + 1}</span>
        <span className="min-w-0 flex-1 truncate"><b className="text-slate-900">{req.request_number}</b> <span className="text-slate-500">· {(req.request_type === 'RECOJO' || req.attention_mode === 'RECOJO_CLIENTE' ? districtOf(req.pickup_address, req.pickup_district) : districtOf(req.delivery_address, req.delivery_district)) || 'Sin distrito'}</span></span>
      </li>)}</ol>}
      {gr && <RouteCubicaje stops={services.map(r => ({ id: r.id, ot: r.contracts?.code ?? null, estimated_weight: r.estimated_weight }))}
        capacidadKg={rb.capacityKg} onCalc={rb.setCubicaje} />}
      {services.length > 0 && <>
        <Block icon={<Truck className="h-4 w-4" />} title="Unidad y personal" step={2} onGo={onGo}>
          <Row label="Documento">{gr ? 'Guía de Remisión' : 'Nota de Salida'}</Row>
          {gr && <>
            <Row label="Modalidad"><span className="rounded bg-blue-50 px-1.5 text-blue-800">{tercero ? 'Tercero' : 'Unidad propia'}</span></Row>
            <Row label="Placa">{plate || <Pending />}</Row>
            <Row label="Conductor">{driver || <Pending />}</Row>
            {!tercero && <Row label="Auxiliares"><span className="inline-flex items-center gap-1"><Users className="h-3 w-3" />{rb.auxiliares.length || 'Ninguno'}</span></Row>}
          </>}
        </Block>
        <Block icon={<CalendarClock className="h-4 w-4" />} title="Programación de salida" step={4} onGo={onGo}>
          <Row label="Fecha y hora">{nd.scheduled_departure ? cellDateTime(new Date(nd.scheduled_departure).toISOString()) : <Pending />}</Row>
          {gr && <Row label="Origen">{origin || '—'}</Row>}
          {gr && <Row label="Distancia">{nd.estimated_distance_km !== '' ? <>{nd.estimated_distance_km} km<Estimated /></> : '—'}</Row>}
        </Block>
        <Block icon={<Receipt className="h-4 w-4" />} title={`Costos adicionales (${extras.count})`} step={3} onGo={onGo}>
          {extras.count === 0 ? <Row label="Servicios">Ninguno</Row> : <>
            {[...new Set([...rb.inheritedLines.filter(l => !(l.id in rb.specialServices.removed)).map(l => l.concept), ...rb.specialServices.added.map(a => a.concept)])].map(c => <Row key={c} label={CONCEPT_LABEL[c] || c}>incluido</Row>)}
            <Row label="Total">S/ {money(extras.total)}</Row>
          </>}
        </Block>
      </>}
      {rb.checks.length > 0 && <section className="border-t border-slate-200 pt-3">
        <h4 className="mb-2 flex items-center gap-2 text-sm font-semibold text-[#002855]"><ListChecks className="h-4 w-4" />Alertas y pendientes</h4>
        <RouteAlerts checks={rb.checks} onGo={onGo} limit={6} />
      </section>}
    </div>
  )
}
