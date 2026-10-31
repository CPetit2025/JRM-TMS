'use client'
import { useState } from 'react'
import { ArrowLeft, ArrowRight, Check, Loader2, PanelRightOpen, Truck, X } from 'lucide-react'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { districtOf } from '@/lib/address'
import { serviceDate } from '@/lib/request-schedule'
import { cellDateTime } from '@/lib/table-format'
import { ROUTE_STEPS, blocking, firstBlockedStep, type RouteStep } from './route-checks'
import { requestedAttention, type TransportRequest } from './types'
import { StepServicios } from './StepServicios'
import { StepTransporte } from './StepTransporte'
import { SpecialServicesTable } from './SpecialServicesTable'
import { RouteAlerts, RouteSummary } from './RouteSummary'
import type { RouteBuilder } from './useRouteBuilder'

const control = 'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-[#002855]'

function Stepper({ rb, onGo }: { rb: RouteBuilder; onGo: (s: RouteStep) => void }) {
  const current = ROUTE_STEPS.find(s => s.step === rb.step)!
  return <nav aria-label="Etapas del armado de ruta">
    <p className="text-sm font-semibold text-[#002855] sm:hidden">Paso {rb.step} de 5 · {current.title}</p>
    <ol className="mt-2 flex items-center gap-1 sm:mt-0 sm:gap-2">
      {ROUTE_STEPS.map(({ step, title, hint }, i) => {
        const active = step === rb.step
        const done = step < rb.step && blocking(rb.checks, step).length === 0
        return <li key={step} className="flex min-w-0 flex-1 items-center gap-2">
          <button type="button" onClick={() => onGo(step)} aria-current={active ? 'step' : undefined}
            className={`flex min-w-0 items-center gap-2 rounded-lg px-1 py-1 text-left ${active ? '' : 'opacity-80 hover:opacity-100'}`}>
            <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full border-2 text-sm font-bold ${active ? 'border-[#002855] bg-[#002855] text-white' : done ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-slate-300 bg-white text-slate-600'}`}>{done ? <Check className="h-4 w-4" /> : step}</span>
            <span className="hidden min-w-0 lg:block"><span className={`block truncate text-sm font-semibold ${active ? 'text-[#002855]' : 'text-slate-700'}`}>{title}</span><span className="block truncate text-[11px] text-slate-500">{hint}</span></span>
          </button>
          {i < ROUTE_STEPS.length - 1 && <span aria-hidden className="h-px flex-1 bg-slate-200" />}
        </li>
      })}
    </ol>
  </nav>
}

function StepSalida({ rb }: { rb: RouteBuilder }) {
  const nd = rb.newDispatch
  const late = new Set(rb.late.map(r => r.request_number))
  const first = rb.selectedServices[0]
  return <div className="space-y-4">
    <div className="grid gap-3 md:grid-cols-2">
      <label><span className="mb-1 block text-xs font-semibold text-slate-700">Fecha y hora programadas de salida *</span>
        <input type="datetime-local" aria-label="Fecha Programada Salida" className={control} value={nd.scheduled_departure} onChange={e => rb.setNewDispatch({ ...nd, scheduled_departure: e.target.value })} />
        {rb.selectedDates.length === 1 && nd.scheduled_departure && nd.scheduled_departure === rb.autoDeparture && <span className="mt-1 block text-xs text-emerald-700">Tomada de la fecha requerida ({serviceDate(rb.selectedDates[0])}) a las 08:00; ajuste la hora si es necesario.</span>}
        {rb.selectedDates.length === 1 && nd.scheduled_departure.slice(0, 10) !== rb.selectedDates[0] && <button type="button" onClick={() => rb.setNewDispatch(c => ({ ...c, scheduled_departure: `${rb.selectedDates[0]}T${c.scheduled_departure.slice(11, 16) || '08:00'}` }))} className="mt-1 text-xs font-semibold text-blue-700 underline">Usar fecha requerida: {serviceDate(rb.selectedDates[0])}</button>}
      </label>
      {nd.document_type === 'GR' && !rb.ownPickupOnly && <label><span className="mb-1 flex items-center justify-between text-xs font-semibold text-slate-700">Distancia estimada (km) {rb.calculatingDistance && <Loader2 className="h-3 w-3 animate-spin text-blue-500" />}</span>
        <input type="number" min="0" step="0.1" placeholder="Cálculo automático" disabled={rb.calculatingDistance} className={control} value={nd.estimated_distance_km}
          onChange={e => rb.setNewDispatch({ ...nd, estimated_distance_km: e.target.value === '' ? '' : Number(e.target.value) })} />
        <span className="mt-1 block text-[11px] text-slate-500">Se calcula al seleccionar los servicios; puede ajustarla.</span></label>}
    </div>
    {rb.selectedServices.length > 0 && <section aria-label="Secuencia de la ruta" className="rounded-xl border border-slate-200 p-3">
      <h4 className="mb-2 text-sm font-semibold text-slate-900">Secuencia</h4>
      <ol className="space-y-1.5 text-sm">
        {first && <li className="flex items-center gap-2 text-slate-600"><span className="grid h-6 w-6 place-items-center rounded-full border border-slate-300 text-[10px] font-bold">O</span>Origen · {districtOf(first.pickup_address, first.pickup_district) || first.pickup_address || '—'}</li>}
        {rb.selectedServices.map((req: TransportRequest, i) => <li key={req.id} className="flex flex-wrap items-center gap-2">
          <span className="grid h-6 w-6 place-items-center rounded-full bg-[#002855] text-[11px] font-bold text-white">{i + 1}</span>
          <b className="text-slate-900">{req.request_number}</b>
          <span className="text-slate-600">{(req.request_type === 'RECOJO' ? districtOf(req.pickup_address, req.pickup_district) : districtOf(req.delivery_address, req.delivery_district)) || '—'}</span>
          <span className={`text-xs ${late.has(req.request_number) ? 'font-semibold text-red-700' : 'text-slate-500'}`}>Atención: {requestedAttention(req)}{late.has(req.request_number) ? ' · la salida queda después' : ''}</span>
        </li>)}
      </ol>
      {rb.selectedDates.length > 1 && <p className="mt-2 text-xs text-amber-800">Las solicitudes tienen fechas distintas: confirme la salida según el orden de atención.</p>}
    </section>}
    <label className="block"><span className="mb-1 block text-xs font-semibold text-slate-700">Observaciones operativas {rb.late.length > 0 ? <span className="text-red-700">* (motivo de la salida después de la atención requerida)</span> : <span className="font-normal text-slate-500">(opcional)</span>}</span>
      <textarea rows={3} maxLength={1000} value={rb.notes} onChange={e => rb.setNotes(e.target.value)} placeholder="Ej.: el cliente confirmó recepción por la tarde; acceso por puerta 2"
        className={`${control} ${rb.late.length > 0 && rb.notes.trim().length < 5 ? 'border-red-400' : ''}`} /></label>
  </div>
}

function StepValidacion({ rb, onGo }: { rb: RouteBuilder; onGo: (s: RouteStep) => void }) {
  const blockers = rb.blockers
  const nd = rb.newDispatch
  return <div className="space-y-4">
    {blockers.length === 0
      ? <p className="flex items-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 p-3 text-sm font-semibold text-emerald-800"><Check className="h-4 w-4" />Lista para programar. Revise las advertencias antes de confirmar.</p>
      : <p className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-800">Faltan {blockers.length} dato{blockers.length > 1 ? 's' : ''} obligatorio{blockers.length > 1 ? 's' : ''}. Cada uno lleva a su etapa.</p>}
    {rb.checks.length > 0 && <RouteAlerts checks={rb.checks} onGo={onGo} />}
    <dl className="grid gap-x-6 gap-y-1.5 rounded-xl border border-slate-200 p-3 text-sm sm:grid-cols-2">
      <div className="flex justify-between gap-2"><dt className="text-slate-500">Paradas</dt><dd className="font-semibold">{rb.selectedServices.map(r => r.request_number).join(' → ') || '—'}</dd></div>
      <div className="flex justify-between gap-2"><dt className="text-slate-500">Documento</dt><dd className="font-semibold">{nd.document_type === 'NOTA_SALIDA' ? 'Nota de Salida' : 'Guía de Remisión'}</dd></div>
      {nd.document_type === 'GR' && <div className="flex justify-between gap-2"><dt className="text-slate-500">Unidad</dt><dd className="font-semibold">{(rb.modalidad === 'TERCERO' ? rb.tercero.placa : nd.vehicle_plate) || '—'} · {rb.modalidad === 'TERCERO' ? 'tercero' : 'propia'}</dd></div>}
      <div className="flex justify-between gap-2"><dt className="text-slate-500">Salida</dt><dd className="font-semibold">{nd.scheduled_departure ? cellDateTime(new Date(nd.scheduled_departure).toISOString()) : '—'}</dd></div>
      {nd.document_type === 'GR' && <div className="flex justify-between gap-2"><dt className="text-slate-500">Flete acordado</dt><dd className="font-semibold tabular-nums">S/ {rb.routeFreight.toLocaleString('es-PE', { minimumFractionDigits: 2 })}</dd></div>}
      {rb.notes.trim() && <div className="flex justify-between gap-2 sm:col-span-2"><dt className="text-slate-500">Observaciones</dt><dd className="text-right">{rb.notes.trim()}</dd></div>}
    </dl>
    <p className="text-xs text-slate-500">Para sumar servicios después de programar y antes de salir, cancele y rearme la ruta: el sistema libera las reservas y conserva el motivo. En ruta, registre una incidencia.</p>
  </div>
}

export function RouteBuilderModal({ rb, onLink }: { rb: RouteBuilder; onLink: (request: TransportRequest) => void }) {
  const [showSummary, setShowSummary] = useState(false)
  // Se puede volver a cualquier etapa; para avanzar, las anteriores no deben tener bloqueos.
  const go = (target: RouteStep) => {
    setShowSummary(false)
    if (target > rb.step) {
      const blocked = firstBlockedStep(rb.checks, (target - 1) as RouteStep)
      if (blocked != null) {
        rb.setStep(blocked)
        toast.error(`Complete esta etapa: ${blocking(rb.checks, blocked)[0].label}`)
        return
      }
    }
    rb.setStep(target)
  }
  const next = () => go(Math.min(5, rb.step + 1) as RouteStep)
  const onSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (rb.step < 5) next()
    else void rb.handleProgramar()
  }
  const pending = rb.blockers.length
  return (
    <Modal isOpen={rb.isModalOpen} onClose={() => rb.setIsModalOpen(false)} title="Armar ruta y programar unidad" maxWidth="max-w-[96rem]"
      footer={<div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <button type="button" onClick={() => rb.setIsModalOpen(false)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50">Cancelar</button>
          <button type="button" onClick={() => setShowSummary(v => !v)} className="inline-flex items-center gap-1 rounded-lg px-3 py-2 text-sm font-medium text-[#002855] hover:bg-slate-100 lg:hidden"><PanelRightOpen className="h-4 w-4" />Resumen</button>
          <p role="status" className={`hidden text-sm font-medium sm:block ${pending ? 'text-amber-700' : 'text-emerald-700'}`}>{pending ? (pending === 1 ? 'Falta 1 dato' : `Faltan ${pending} datos`) : 'Lista para programar'}</p>
        </div>
        <div className="flex gap-2">
          <button type="button" disabled={rb.step === 1} onClick={() => go((rb.step - 1) as RouteStep)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-4 py-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40"><ArrowLeft className="h-4 w-4" />Anterior</button>
          {rb.step < 5
            ? <button type="submit" form="route-form" className="inline-flex items-center gap-1 rounded-lg bg-[#002855] px-5 py-2 text-sm font-bold text-white hover:bg-[#001d3d]">Siguiente<ArrowRight className="h-4 w-4" /></button>
            : <button type="submit" form="route-form" disabled={rb.isSubmitting || pending > 0}
              className="inline-flex items-center gap-2 rounded-lg bg-[#002855] px-5 py-2 text-sm font-bold text-white hover:bg-[#001d3d] disabled:opacity-50">
              {rb.isSubmitting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Truck className="h-4 w-4" />}Programar ruta</button>}
        </div>
      </div>}>
      <form id="route-form" onSubmit={onSubmit} className="space-y-4">
        <Stepper rb={rb} onGo={go} />
        <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_22rem]">
          <div className="min-w-0">
            {ROUTE_STEPS.map(({ step, title }) => <section key={step} hidden={rb.step !== step} aria-label={title} className="rounded-xl border border-slate-200 bg-white p-4">
              <h3 className="mb-3 text-base font-bold text-[#002855]">{step}. {step === 1 ? 'Selección de servicios' : step === 2 ? 'Asignación de transporte' : step === 3 ? 'Servicios adicionales' : step === 4 ? 'Programación de salida' : 'Resumen y validación'}</h3>
              {step === 1 && <StepServicios rb={rb} onLink={onLink} />}
              {step === 2 && <StepTransporte rb={rb} />}
              {step === 3 && <SpecialServicesTable services={rb.selectedServices} stops={rb.forkliftStops} lines={rb.inheritedLines} value={rb.specialServices} onChange={rb.setSpecialServices}
                forklift={rb.routeForklift} onForkliftChange={rb.setForklift} />}
              {step === 4 && <StepSalida rb={rb} />}
              {step === 5 && <StepValidacion rb={rb} onGo={go} />}
            </section>)}
          </div>
          {/* Resumen: columna fija en escritorio; en el celular se abre como hoja con «Resumen» (siempre montado para el cálculo de carga) */}
          <aside className={`${showSummary ? 'fixed inset-x-0 bottom-0 z-50 max-h-[80dvh] overflow-y-auto rounded-t-2xl bg-slate-50 p-3 shadow-2xl' : 'hidden'} lg:static lg:block lg:max-h-none lg:self-start lg:overflow-visible lg:rounded-none lg:bg-transparent lg:p-0 lg:shadow-none`}>
            {showSummary && <button type="button" onClick={() => setShowSummary(false)} className="mb-2 ml-auto flex items-center gap-1 text-sm font-semibold text-slate-600 lg:hidden"><X className="h-4 w-4" />Cerrar</button>}
            <RouteSummary rb={rb} onGo={go} />
          </aside>
        </div>
      </form>
    </Modal>
  )
}
