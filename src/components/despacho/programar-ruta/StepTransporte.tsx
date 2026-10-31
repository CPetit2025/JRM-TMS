'use client'
import Link from 'next/link'
import { CheckCircle2, Loader2, ShieldAlert } from 'lucide-react'
import { SearchableSelect } from '@/components/ui/SearchableSelect'
import { RouteAuxiliaryPicker } from '@/components/despacho/RouteAuxiliaryPicker'
import { TerceroFields } from '@/components/despacho/Tercero'
import { QuoteBreakdown } from '@/components/tarifas/TransportTariffManager'
import { referenceLabel } from '@/lib/suppliers'
import { serviceLabel } from '@/lib/request-service'
import type { RouteBuilder } from './useRouteBuilder'

const control = 'w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-[#002855]'
const label = 'mb-1 block text-xs font-semibold text-slate-700'
const money = (n: number) => n.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const lima = (iso: string) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))

// Flete de la ruta en un solo lugar: referencial (solicitudes), tarifario, acordado, diferencia, motivo y reparto por OT.
function FreightPanel({ rb }: { rb: RouteBuilder }) {
  const tercero = rb.modalidad === 'TERCERO'
  const diff = rb.routeFreight - rb.referentialFreight
  const missing = rb.checks.some(c => c.key.startsWith('flete-'))
  return (
    <section className="space-y-3 rounded-xl border border-slate-200 p-3" aria-label="Flete acordado y referencial">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-sm font-semibold text-slate-900">Flete de la ruta</h4>
        <p className="text-[11px] text-slate-500">Con OT se reserva en su partida{tercero ? ' a nombre del proveedor' : ''}. Sin OT se vincula a la OC, OS o RQ.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <div className="rounded-lg bg-slate-50 p-2"><p className="text-[11px] text-slate-500">Referencial (solicitudes)</p><p className="font-semibold tabular-nums text-slate-800">S/ {money(rb.referentialFreight)}</p></div>
        <div className="rounded-lg bg-slate-50 p-2"><p className="text-[11px] text-slate-500">Tarifario</p>
          <p className="font-semibold tabular-nums text-slate-800">{rb.loadingRate ? <Loader2 className="h-4 w-4 animate-spin text-slate-400" /> : rb.detectedFreightRate ? `S/ ${money(rb.detectedFreightRate.rate)}` : <span className="font-normal text-slate-400">Sin tarifa</span>}</p></div>
        <label className="sm:col-span-1"><span className={label}>{tercero ? 'Flete pactado con el proveedor' : 'Flete acordado'} (S/) <span className="text-red-700">*</span></span>
          <input type="number" min="0" step="0.01" required aria-label={tercero ? 'Flete pactado con el proveedor' : 'Flete de la ruta'} value={rb.manualFreightCost} onChange={e => rb.setManualFreightCost(e.target.value)}
            placeholder="Monto acordado" className={`${control} ${missing ? 'border-red-400' : 'border-slate-300'}`} /></label>
        <div className="rounded-lg bg-slate-50 p-2"><p className="text-[11px] text-slate-500">Diferencia vs. referencial</p>
          <p className={`font-semibold tabular-nums ${Math.abs(diff) < 0.005 ? 'text-slate-800' : diff > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>{Math.abs(diff) < 0.005 ? '—' : `${diff > 0 ? '+' : ''}S/ ${money(diff)}`}</p></div>
      </div>
      <div className="flex flex-wrap gap-3 text-xs">
        {rb.detectedFreightRate && <button type="button" onClick={() => rb.setManualFreightCost(String(rb.detectedFreightRate!.rate))} className="font-semibold text-blue-700 hover:underline">Usar el tarifario (S/ {money(rb.detectedFreightRate.rate)})</button>}
        {rb.referentialFreight > 0 && <button type="button" onClick={() => rb.setManualFreightCost(rb.referentialFreight.toFixed(2))} className="font-semibold text-blue-700 hover:underline">Usar el referencial (S/ {money(rb.referentialFreight)})</button>}
      </div>
      {missing && <p className="text-xs font-semibold text-red-700">{rb.checks.find(c => c.key.startsWith('flete-'))?.label}</p>}
      {rb.freightQuote && !rb.loadingRate && <details className="text-xs"><summary className="cursor-pointer font-semibold text-slate-600">Detalle del tarifario</summary><div className="mt-2"><QuoteBreakdown quote={rb.freightQuote} compact /></div></details>}
      {rb.freightNeedsReason && <label id="ruta-flete-motivo" className="block rounded-lg border border-amber-200 bg-amber-50 p-2">
        <span className="mb-0.5 block text-[11px] font-semibold text-amber-800">Motivo de la diferencia con el referencial * <span className="font-normal">(queda en el historial de costos)</span></span>
        <input value={rb.freightReason} onChange={e => rb.setFreightReason(e.target.value)} placeholder="Ej.: tarifa del transportista con peaje nuevo" className={`${control} border-slate-300`} /></label>}
      {rb.mixedOT && <div className="space-y-2 rounded-lg border border-blue-100 bg-blue-50/40 p-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="text-xs font-semibold text-slate-800">Distribución por servicio <span className="font-normal text-slate-500">· con OT se usa el margen operativo de la partida</span></p>
          <button type="button" onClick={() => rb.setFreightShares({})} className="text-xs text-blue-700 underline">Distribuir según los estimados</button>
        </div>
        {rb.modalidad === 'PROPIA' && rb.selectedServices.some(r => r.request_type === 'RECOJO') && <p className="text-xs text-blue-900">Los recojos con flota propia no se valorizan: el flete se reparte entre los demás servicios.</p>}
        {rb.selectedServices.map(req => {
          const fixed = rb.modalidad === 'PROPIA' && req.request_type === 'RECOJO'
          return <label key={req.id} className="flex flex-wrap items-center justify-between gap-2 text-xs">
            <span><strong>{req.request_number}</strong> · {req.contracts?.code ? `OT ${req.contracts.code}` : referenceLabel(req) || 'Sin referencia'} · {serviceLabel(req)}</span>
            <span className="flex items-center gap-1">S/
              <input disabled={fixed} type="number" min="0" step="0.01" aria-label={`Flete ${req.request_number}`} value={fixed ? '0.00' : rb.freightShares[req.id] ?? rb.serviceShare(req.id).toFixed(2)} onChange={e => rb.setFreightShares(prev => ({ ...prev, [req.id]: e.target.value }))} className="w-28 rounded border border-blue-200 bg-white px-2 py-1 text-right" />
            </span>
          </label>
        })}
        <p className={`text-xs font-semibold ${rb.allocationMatches ? 'text-emerald-700' : 'text-red-700'}`}>Total S/ {money(rb.routeFreight)} · Distribuido S/ {money(rb.selectedServices.reduce((sum, r) => sum + rb.serviceShare(r.id), 0))}{!rb.allocationMatches && ' · Ajuste la distribución'}</p>
      </div>}
    </section>
  )
}

export function StepTransporte({ rb }: { rb: RouteBuilder }) {
  const nd = rb.newDispatch
  if (!nd.selected_requests.length) return <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">Seleccione primero los servicios: la modalidad se hereda de la solicitud.</p>
  if (nd.document_type === 'NOTA_SALIDA') return <p className="rounded-lg bg-blue-50 p-3 text-sm text-blue-800">Recojo por el cliente · Nota de Salida. Sin conductor propio, monitoreo GPS ni flete JRM. El Asistente Documentario prepara la Nota de Despacho; el retiro no espera esa confirmación.</p>
  const busyPlates = new Set(rb.dispatches.map(d => d.vehicle_plate))
  const busyDrivers = new Map(rb.dispatches.filter(d => d.driver_id).map(d => [d.driver_id as string, d.dispatch_number]))
  const elig = rb.currentEligibility
  const cap = rb.capacityKg
  return (
    <div className="space-y-4">
      <div className="grid max-w-sm grid-cols-2 gap-1 rounded-lg border border-slate-200 bg-white p-1 text-xs font-semibold">
        {(['PROPIA', 'TERCERO'] as const).map(m => (
          <button key={m} type="button" onClick={() => rb.changeModalidad(m)} aria-pressed={rb.modalidad === m}
            className={`rounded-md py-1.5 ${rb.modalidad === m ? 'bg-[#002855] text-white' : 'text-slate-600 hover:bg-slate-50'}`}>{m === 'PROPIA' ? 'Unidad propia' : 'Tercero'}</button>
        ))}
      </div>
      {rb.modalidad === 'TERCERO' ? <TerceroFields value={rb.tercero} onChange={rb.setTercero} /> : (
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <span className={label}>Placa del vehículo *</span>
            <SearchableSelect ariaLabel="Placa del vehículo" value={nd.vehicle_plate} onChange={rb.changeVehicle} placeholder="Seleccione vehículo…"
              options={rb.vehicles.map(v => ({ value: v.plate, label: `${v.plate} · ${[v.brand, v.model].filter(Boolean).join(' ')}${v.weight_capacity ? ` · ${Number(v.weight_capacity).toLocaleString('es-PE')} kg` : ''}${busyPlates.has(v.plate) ? ' · Con ruta activa' : ' · Disponible'}` }))} />
          </div>
          <div>
            <span className={label}>Conductor *</span>
            <SearchableSelect ariaLabel="Conductor" value={nd.driver_name} onChange={rb.changeDriver} placeholder="Seleccione conductor…"
              options={rb.drivers.map(d => ({ value: `${d.first_name} ${d.last_name}`, label: `${d.first_name} ${d.last_name} · ${d.document_number}${busyDrivers.has(d.id) ? ` · En ruta ${busyDrivers.get(d.id)}` : ' · Disponible'}` }))} />
          </div>
          {rb.occupiedAssignment && <div className="rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900 md:col-span-2">
            <p className="font-semibold">{rb.occupiedAssignment.route.dispatch_number} · {rb.occupiedAssignment.route.status.replace(/_/g, ' ')}</p>
            <p className="mt-1">{rb.occupiedAssignment.kind === 'ADD_SERVICE' ? 'Esta unidad y conductor ya tienen una ruta. Incorpore los nuevos servicios uno a uno al despacho existente.' : rb.occupiedAssignment.kind === 'CLOSING' ? 'La ruta está en retorno o pendiente de cierre. Complete su cierre antes de programar otra.' : 'La unidad o el conductor tiene otro despacho. Seleccione la misma pareja de la ruta existente o recursos disponibles.'}</p>
            {rb.occupiedAssignment.kind === 'ADD_SERVICE' && rb.canAddService && <button type="button" onClick={() => rb.openRouteAddition(rb.occupiedAssignment!.route.id)} className="mt-3 min-h-11 rounded-lg bg-jrm-navy px-4 font-semibold text-white">Agregar servicio a esta ruta</button>}
            <Link href={`/torre-control?despacho=${rb.occupiedAssignment.route.id}&fecha=${rb.occupiedAssignment.route.scheduled_departure ? lima(rb.occupiedAssignment.route.scheduled_departure) : ''}`} className="mt-2 block font-semibold underline">Ver despacho en Torre de Control</Link>
          </div>}
          {elig && <p className={`flex items-start gap-1.5 rounded-lg px-3 py-2 text-xs md:col-span-2 ${elig.status === 'APTO' ? 'bg-emerald-50 text-emerald-800' : elig.status === 'BLOQUEADO' ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-900'}`}>
            {elig.status === 'APTO' ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0" /> : <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />}
            {elig.status === 'APTO' ? 'Unidad y conductor habilitados.' : elig.status === 'BLOQUEADO' ? `No habilitado: ${elig.blocking_reasons.join('; ')}` : `Habilitado con observaciones: ${elig.observation_reasons.join('; ')}`}</p>}
          <div className="md:col-span-2">
            <RouteAuxiliaryPicker people={rb.assistants} value={rb.auxiliares} onChange={rb.setAuxiliares}
              driverId={rb.selectedDriver?.id} loading={rb.assistantsLoading} error={rb.assistantsError}
              onRefresh={() => { void rb.fetchAssistants() }} />
          </div>
        </div>
      )}
      <p className="text-xs text-slate-600">Capacidad de la unidad: {cap ? <b className="tabular-nums">{Math.round(cap).toLocaleString('es-PE')} kg{rb.capacityM3 ? ` · ${rb.capacityM3.toLocaleString('es-PE')} m³` : ''}</b> : <span className="text-amber-700">sin capacidad registrada</span>}
        {' '}· Carga declarada en las solicitudes: <b className={`tabular-nums ${cap && rb.declaredKg > cap ? 'text-red-700' : ''}`}>{Math.round(rb.declaredKg).toLocaleString('es-PE')} kg</b></p>
      {rb.ownPickupOnly ? <p className="rounded-lg bg-blue-50 p-3 text-xs text-blue-900">Recojo con flota propia: sin valorización de flete. Se conserva el seguimiento y la documentación.</p> : <FreightPanel rb={rb} />}
    </div>
  )
}
