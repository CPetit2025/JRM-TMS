'use client'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, ChevronDown, ChevronRight, GripVertical, Search, Trash2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { ServiceTypeBadge } from '@/components/ui/service-type-badge'
import { ErpOtLinea, ErpStockCorteAviso } from '@/components/erp/ErpReferencia'
import { districtOf } from '@/lib/address'
import { partyName, referenceLabel } from '@/lib/suppliers'
import { serviceKind, SERVICE_KINDS, type ServiceKind } from '@/lib/request-service'
import { serviceDate, wasRescheduled } from '@/lib/request-schedule'
import { partyMissing, requestedAttention, type TransportRequest } from './types'
import type { RouteBuilder } from './useRouteBuilder'

const control = 'rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-[#002855]'
const kg = (n: number) => `${Math.round(n).toLocaleString('es-PE')}`
export const requestWeight = (r: TransportRequest) => Number(r.estimated_weight || 0) || (r.transport_request_items || []).reduce((t, i) => t + Number(i.weight || 0), 0)
const clientOf = (r: TransportRequest) => partyName(r, (r.request_client?.business_name || r.contracts?.clients?.business_name), r.suppliers?.business_name)
const docOf = (r: TransportRequest) => (r.contracts?.code ? `OT ${r.contracts.code}` : referenceLabel(r) || 'Sin OT')
const placeOf = (r: TransportRequest) => `${districtOf(r.pickup_address, r.pickup_district) || 'Origen'} → ${districtOf(r.delivery_address, r.delivery_district) || 'Destino'}`

type Item = { id: string; sku?: string | null; description?: string | null; quantity?: number | null; weight?: number | null; volume_m3?: number | null }

// Detalle de una solicitud: productos (cantidades, peso y volumen), stock del ERP de su OT y direcciones. Se carga al desplegar.
function RequestDetail({ request }: { request: TransportRequest }) {
  const supabase = useMemo(() => createClient(), [])
  const [items, setItems] = useState<Item[] | null>(null)
  useEffect(() => {
    let alive = true
    void supabase.from('transport_request_items').select('*').eq('transport_request_id', request.id).then(({ data }) => { if (alive) setItems((data || []) as Item[]) })
    return () => { alive = false }
  }, [supabase, request.id])
  return (
    <div className="space-y-2 rounded-lg border border-slate-200 bg-white p-3 text-xs">
      <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        <p><span className="text-slate-500">Origen:</span> {request.pickup_address || '—'}</p>
        <p><span className="text-slate-500">Destino:</span> {request.delivery_address || '—'}</p>
        <p><span className="text-slate-500">Atención:</span> <b>{requestedAttention(request)}</b>{wasRescheduled(request) && request.rescheduling?.fecha_anterior ? ` · antes ${serviceDate(request.rescheduling.fecha_anterior)}` : ''}</p>
        {(request.pickup_contact || request.pickup_phone) && <p><span className="text-slate-500">Contacto:</span> {[request.pickup_contact, request.pickup_phone].filter(Boolean).join(' · ')}</p>}
      </div>
      {request.contracts?.code && <p><span className="text-slate-500">Stock ERP de la OT:</span> <ErpOtLinea ot={request.contracts.code} /></p>}
      {items == null ? <p className="text-slate-500">Cargando productos…</p> : items.length === 0 ? <p className="text-slate-500">Sin detalle de productos en la solicitud.</p>
        : <div className="overflow-x-auto"><table className="w-full min-w-[480px] text-left">
          <thead className="text-[11px] uppercase text-slate-500"><tr><th className="py-1 pr-2 font-semibold">Código</th><th className="py-1 pr-2 font-semibold">Descripción</th><th className="py-1 pr-2 text-right font-semibold">Cantidad</th><th className="py-1 pr-2 text-right font-semibold">Peso (kg)</th><th className="py-1 text-right font-semibold">Vol. (m³)</th></tr></thead>
          <tbody className="divide-y divide-slate-100">{items.map(i => <tr key={i.id}>
            <td className="py-1 pr-2 text-slate-700">{i.sku || '—'}</td><td className="py-1 pr-2 text-slate-800">{i.description || '—'}</td>
            <td className="py-1 pr-2 text-right tabular-nums">{Number(i.quantity ?? 0).toLocaleString('es-PE')}</td>
            <td className="py-1 pr-2 text-right tabular-nums">{Number(i.weight) ? kg(Number(i.weight)) : '—'}</td>
            <td className="py-1 text-right tabular-nums">{Number(i.volume_m3) ? Number(i.volume_m3).toLocaleString('es-PE', { maximumFractionDigits: 2 }) : '—'}</td>
          </tr>)}</tbody>
        </table></div>}
    </div>
  )
}

export function StepServicios({ rb, onLink }: { rb: RouteBuilder; onLink: (request: TransportRequest) => void }) {
  const [tab, setTab] = useState<'disponibles' | 'seleccionados'>('disponibles')
  const [search, setSearch] = useState('')
  const [kind, setKind] = useState<ServiceKind | ''>('')
  const [date, setDate] = useState('')
  const [expanded, setExpanded] = useState<string | null>(null)
  const [dragId, setDragId] = useState<string | null>(null)
  const selectedIds = rb.newDispatch.selected_requests.map(r => r.id)
  const candidates = rb.pendingRequests.filter(r => {
    if (kind && serviceKind(r) !== kind) return false
    if (date && r.required_date?.slice(0, 10) !== date && r.required_at?.slice(0, 10) !== date) return false
    const term = search.trim().toLocaleLowerCase('es-PE')
    return !term || [r.request_number, r.contracts?.code, r.contracts?.clients?.business_name, r.suppliers?.business_name, referenceLabel(r),
      districtOf(r.pickup_address, r.pickup_district), districtOf(r.delivery_address, r.delivery_district)].join(' ').toLocaleLowerCase('es-PE').includes(term)
  })
  const toggle = (r: TransportRequest) => void rb.toggleRequestSelection(r.id, r.pickup_address, r.delivery_address)
  const expand = (id: string) => setExpanded(current => (current === id ? null : id))
  const head = 'px-2 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-slate-500'

  return (
    <div className="space-y-3">
      <ErpStockCorteAviso />
      <div className="flex flex-wrap gap-2">
        <label className="relative min-w-0 flex-1 basis-56"><span className="sr-only">Buscar servicios</span><Search aria-hidden className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Buscar RT, OT, cliente o destino…" className={`${control} w-full pl-9`} /></label>
        <select aria-label="Tipo de servicio" value={kind} onChange={e => setKind(e.target.value as ServiceKind | '')} className={`${control} w-44`}>
          <option value="">Todos los servicios</option>
          {(Object.keys(SERVICE_KINDS) as ServiceKind[]).map(k => <option key={k} value={k}>{SERVICE_KINDS[k].short}</option>)}
        </select>
        <input type="date" aria-label="Fecha requerida" value={date} onChange={e => setDate(e.target.value)} className={`${control} w-40`} />
        {(search || kind || date) && <button type="button" onClick={() => { setSearch(''); setKind(''); setDate('') }} className="px-2 text-xs font-semibold text-blue-700 hover:underline">Limpiar</button>}
      </div>
      <div role="tablist" className="flex gap-4 border-b border-slate-200 text-sm">
        {([['disponibles', `Servicios disponibles (${candidates.length})`], ['seleccionados', `Seleccionados para la ruta (${selectedIds.length})`]] as const).map(([key, label]) =>
          <button key={key} type="button" role="tab" aria-selected={tab === key} onClick={() => setTab(key)}
            className={`-mb-px border-b-2 px-1 pb-2 font-semibold ${tab === key ? 'border-[#002855] text-[#002855]' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>{label}</button>)}
      </div>

      {tab === 'disponibles' ? (
        <div className="max-h-[52vh] overflow-auto rounded-lg border border-slate-200">
          {rb.pendingRequests.length === 0 ? <div className="p-8 text-center text-slate-500"><p className="font-medium">No hay solicitudes disponibles</p><p className="mt-1 text-xs">Las solicitudes aprobadas aparecen aquí para armar la ruta.</p></div>
            : candidates.length === 0 ? <p className="p-6 text-center text-sm text-slate-500">Ningún servicio coincide con la búsqueda.</p>
            : <table className="w-full min-w-[760px] text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50"><tr>
                <th className="w-8 px-2" /><th className={head}>RT / Documento</th><th className={head}>Cliente</th><th className={head}>Servicio</th><th className={head}>Origen → Destino</th><th className={head}>Fecha requerida</th><th className={`${head} text-right`}>Peso (kg)</th><th className="w-8" />
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {candidates.map(req => {
                  const stop = selectedIds.indexOf(req.id)
                  const missing = partyMissing(req)
                  const weight = requestWeight(req)
                  return <Fragment key={req.id}>
                    <tr className={stop >= 0 ? 'bg-blue-50/70' : 'hover:bg-slate-50'}>
                      <td className="px-2 py-2"><input type="checkbox" aria-label={`Seleccionar ${req.request_number}`} className="h-4 w-4 rounded border-slate-300 text-[#002855] focus:ring-[#002855] disabled:opacity-40" checked={stop >= 0}
                        disabled={Boolean(missing) && stop < 0} title={missing ? `Sin ${missing}: vincúlelo antes de programar` : undefined} onChange={() => toggle(req)} /></td>
                      <td className="px-2 py-2">
                        <span className="flex items-center gap-1.5">
                          {stop >= 0 && <span className="grid h-5 w-5 place-items-center rounded-full bg-[#002855] text-[10px] font-bold text-white" title={`Parada ${stop + 1}`}>{stop + 1}</span>}
                          <span className="font-bold text-[#002855]">{req.request_number}</span>
                        </span>
                        <span className="block text-xs text-slate-600">{docOf(req)}</span>
                      </td>
                      <td className="max-w-44 px-2 py-2">
                        <span className="block truncate text-xs text-slate-700" title={clientOf(req) || undefined}>{clientOf(req) || '—'}</span>
                        {missing && <button type="button" onClick={() => onLink(req)} className="mt-0.5 rounded-full bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700 ring-1 ring-red-200 hover:bg-red-100">Sin {missing} · vincular</button>}
                      </td>
                      <td className="px-2 py-2"><ServiceTypeBadge request={req} />
                        {req.attention_mode === 'RECOJO_CLIENTE' && <span className="block text-[11px] font-medium text-teal-700">Recojo por cliente</span>}
                        {!req.attention_mode && <span className="block text-[11px] font-medium text-red-700">Modalidad pendiente</span>}</td>
                      <td className="max-w-48 truncate px-2 py-2 text-xs text-slate-700" title={`${req.pickup_address} → ${req.delivery_address}`}>{placeOf(req)}</td>
                      <td className="whitespace-nowrap px-2 py-2 text-xs text-slate-700">{requestedAttention(req)}
                        {wasRescheduled(req) && <span className="ml-1 rounded-full bg-orange-100 px-1.5 text-[10px] font-bold text-orange-800">Reprogramado</span>}</td>
                      <td className="px-2 py-2 text-right text-xs tabular-nums text-slate-700">{weight ? kg(weight) : '—'}</td>
                      <td className="px-1"><button type="button" onClick={() => expand(req.id)} aria-expanded={expanded === req.id} aria-label={`Detalle de ${req.request_number}`} className="rounded p-1 text-slate-500 hover:bg-slate-100">{expanded === req.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button></td>
                    </tr>
                    {expanded === req.id && <tr className="bg-slate-50"><td colSpan={8} className="px-3 pb-3 pt-1"><RequestDetail request={req} /></td></tr>}
                  </Fragment>
                })}
              </tbody>
            </table>}
        </div>
      ) : (
        <div className="rounded-lg border border-slate-200">
          {rb.selectedServices.length === 0 ? <p className="p-6 text-center text-sm text-slate-500">Aún no hay servicios en la ruta. Selecciónelos en «Servicios disponibles».</p>
            : <>
              <p className="border-b border-slate-100 px-3 py-2 text-xs text-slate-500">Orden de paradas: arrastre las filas o use las flechas. Es el orden de atención de la ruta.</p>
              <div className="overflow-x-auto"><table className="w-full min-w-[720px] text-sm">
                <thead className="bg-slate-50"><tr><th className="w-6" /><th className={head}>#</th><th className={head}>RT / Documento</th><th className={head}>Cliente</th><th className={head}>Servicio</th><th className={head}>Destino</th><th className={head}>Fecha requerida</th><th className={`${head} text-right`}>Peso (kg)</th><th className={`${head} text-right`}>Acciones</th></tr></thead>
                <tbody className="divide-y divide-slate-100">
                  {rb.selectedServices.map((req, i) => {
                    const lateStop = rb.late.some(l => l.request_number === req.request_number)
                    return <Fragment key={req.id}>
                      <tr draggable onDragStart={() => setDragId(req.id)} onDragEnd={() => setDragId(null)} onDragOver={e => e.preventDefault()}
                        onDrop={e => { e.preventDefault(); if (dragId) rb.moveStop(dragId, i); setDragId(null) }}
                        className={dragId === req.id ? 'opacity-50' : 'bg-white'}>
                        <td className="cursor-grab px-1 text-slate-400"><GripVertical className="h-4 w-4" aria-hidden /></td>
                        <td className="px-2 py-2"><span className="grid h-6 w-6 place-items-center rounded-full bg-[#002855] text-[11px] font-bold text-white">{i + 1}</span></td>
                        <td className="px-2 py-2"><b className="text-[#002855]">{req.request_number}</b><span className="block text-xs text-slate-600">{docOf(req)}</span></td>
                        <td className="max-w-40 truncate px-2 py-2 text-xs text-slate-700">{clientOf(req) || '—'}</td>
                        <td className="px-2 py-2"><ServiceTypeBadge request={req} /></td>
                        <td className="max-w-40 truncate px-2 py-2 text-xs text-slate-700">{placeOf(req)}</td>
                        <td className={`whitespace-nowrap px-2 py-2 text-xs ${lateStop ? 'font-semibold text-red-700' : 'text-slate-700'}`} title={lateStop ? 'La salida programada queda después de esta atención' : undefined}>{requestedAttention(req)}</td>
                        <td className="px-2 py-2 text-right text-xs tabular-nums">{requestWeight(req) ? kg(requestWeight(req)) : '—'}</td>
                        <td className="whitespace-nowrap px-2 py-2 text-right">
                          <button type="button" disabled={i === 0} onClick={() => rb.moveStop(req.id, i - 1)} aria-label={`Subir ${req.request_number}`} className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"><ArrowUp className="h-4 w-4" /></button>
                          <button type="button" disabled={i === rb.selectedServices.length - 1} onClick={() => rb.moveStop(req.id, i + 1)} aria-label={`Bajar ${req.request_number}`} className="rounded p-1 text-slate-500 hover:bg-slate-100 disabled:opacity-30"><ArrowDown className="h-4 w-4" /></button>
                          <button type="button" onClick={() => expand(req.id)} aria-label={`Detalle de ${req.request_number}`} className="rounded p-1 text-slate-500 hover:bg-slate-100">{expanded === req.id ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}</button>
                          <button type="button" onClick={() => toggle(req)} aria-label={`Quitar ${req.request_number} de la ruta`} className="rounded p-1 text-red-500 hover:bg-red-50"><Trash2 className="h-4 w-4" /></button>
                        </td>
                      </tr>
                      {expanded === req.id && <tr className="bg-slate-50"><td colSpan={9} className="px-3 pb-3 pt-1"><RequestDetail request={req} /></td></tr>}
                    </Fragment>
                  })}
                </tbody>
              </table></div>
            </>}
        </div>
      )}
    </div>
  )
}
