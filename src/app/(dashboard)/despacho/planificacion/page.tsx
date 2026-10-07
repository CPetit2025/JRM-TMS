'use client'
import { DataTable } from '@/components/ui/data-table'

import Link from 'next/link'
import { useEffect, useMemo, useState } from 'react'
import { CalendarRange, FileUp, Loader2, RefreshCw, Search } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/caja'

type Stop = { request_id: string; request_number: string; ot_code: string | null; client: string | null; origin?: string; delivery: string; cargo: string | null }
type Plan = { id: string; dispatch_number: string; status: string; scheduled_departure: string | null; driver_name: string | null; vehicle_plate: string | null; stops: Stop[]; documents: { doc_type: string; request_id: string | null; signed?: boolean }[] }

const planningTime = (date: string | null) => date ? new Date(date).toLocaleString('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '—'

export default function DispatchPlanningPage() {
  const db = useMemo(() => createClient(), [])
  const [plans, setPlans] = useState<Plan[] | null>(null)
  const [error, setError] = useState('')
  const [search, setSearch] = useState('')
  const [date, setDate] = useState('')
  const [includeDeparted, setIncludeDeparted] = useState(false)
  const [reload, setReload] = useState(0)
  useEffect(() => {
    let cancelled = false, fetching = false
    const load = async () => {
      if (fetching) return
      fetching = true
      try {
        const result = await db.rpc('get_documentary_queue', { p_include_departed: includeDeparted })
        if (cancelled) return
        if (result.error) throw result.error
        setPlans(result.data || []); setError('')
      } catch (err) { if (!cancelled) setError(errorMessage(err)) }
      finally { fetching = false }
    }
    void load()
    const timer = window.setInterval(() => void load(), 30000)
    return () => { cancelled = true; window.clearInterval(timer) }
  }, [db, includeDeparted, reload])
  const needle = search.trim().toLocaleLowerCase('es-PE')
  const rows = (plans || []).flatMap(plan => plan.stops.map(stop => ({ plan, stop }))).filter(({ plan, stop }) => {
    const parts = plan.scheduled_departure ? new Intl.DateTimeFormat('en', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(plan.scheduled_departure)) : []
    const value = (type: string) => parts.find(part => part.type === type)?.value || ''
    const day = `${value('year')}-${value('month')}-${value('day')}`
    return (!date || day === date) && (!needle || [plan.dispatch_number, plan.vehicle_plate, plan.driver_name, stop.request_number, stop.ot_code, stop.client, stop.origin, stop.delivery].join(' ').toLocaleLowerCase('es-PE').includes(needle))
  })
  return <div className="min-w-0 space-y-5">
    <div className="flex flex-wrap items-center justify-between gap-3"><div><h1 className="flex items-center gap-2 text-2xl font-bold text-[#002855]"><CalendarRange className="h-6 w-6" />Planificación de Despachos</h1><p className="mt-2 text-sm leading-6 text-slate-600">Consulta la OT, ruta, unidad y conductor. Como Auditor de Despacho, registra el Packing List antes de la salida.</p></div><button onClick={() => setReload(n => n + 1)} className="flex min-h-11 items-center gap-2 rounded-lg border bg-white px-3 text-sm"><RefreshCw className="h-4 w-4" />Actualizar</button></div>
    <div className="flex flex-wrap items-end gap-4 rounded-xl border border-slate-200 bg-white p-4"><label className="min-w-0 flex-1 text-xs font-semibold text-slate-600">Buscar OT, solicitud, unidad o cliente<div className="relative mt-2"><Search className="absolute left-3 top-3 h-4 w-4 text-slate-400" /><input value={search} onChange={e => setSearch(e.target.value)} className="min-h-11 w-full rounded-lg border border-slate-300 pl-9 pr-3 text-sm" /></div></label><label className="text-xs font-semibold text-slate-600">Fecha de salida · Lima<input type="date" value={date} onChange={e => setDate(e.target.value)} className="mt-2 block min-h-11 rounded-lg border border-slate-300 px-3 text-sm" /></label><label className="flex min-h-11 items-center gap-2 text-sm text-slate-600"><input type="checkbox" checked={includeDeparted} onChange={e => setIncludeDeparted(e.target.checked)} />Incluir salidas de los últimos 7 días</label>{(search || date) && <button onClick={() => { setDate(''); setSearch('') }} className="min-h-11 text-sm font-semibold text-blue-700">Limpiar filtros</button>}</div>
    {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">No se pudo consultar la planificación: {error}. Pulsa Actualizar para reintentar.</p>}
    {plans === null && !error ? <Loader2 className="mx-auto h-6 w-6 animate-spin text-slate-400" /> : !rows.length ? <p className="rounded-xl border bg-white p-6 text-center text-sm text-slate-500">No hay servicios para estos filtros.</p> : <section className="overflow-hidden rounded-xl border border-slate-200 bg-white"><p className="border-b px-4 py-3 text-sm text-slate-600">{rows.length} servicio(s) · consulta de planificación</p><div className="overflow-x-auto"><DataTable className="block w-full text-left text-sm lg:table"><thead className="hidden bg-slate-50 text-xs text-slate-500 lg:table-header-group"><tr>{['OT / Solicitud', 'Cliente / Ruta', 'Salida / Unidad', 'Packing List'].map(label => <th key={label} scope="col" className="px-4 py-3 font-semibold">{label}</th>)}</tr></thead><tbody className="block divide-y lg:table-row-group">{rows.map(({ plan, stop }) => {
      const hasPacking = plan.documents.some(doc => doc.doc_type === 'PACKING_LIST' && doc.signed && (!doc.request_id || doc.request_id === stop.request_id))
      return <tr key={`${plan.id}/${stop.request_id}`} className="grid gap-2 p-4 sm:grid-cols-2 lg:table-row lg:p-0"><td className="min-w-0 py-2 lg:px-4 lg:py-4"><p className="font-bold text-[#002855]">{stop.ot_code ? `OT ${stop.ot_code}` : 'Sin OT vinculada'}</p><p className="mt-1 text-xs text-slate-600">{stop.request_number} · {plan.dispatch_number}</p></td><td className="min-w-0 py-2 lg:max-w-80 lg:px-4 lg:py-4"><p className="break-words font-medium text-slate-800">{stop.client || 'Sin cliente registrado'}</p><p className="mt-1 break-words text-xs leading-5 text-slate-600">{stop.origin || 'Origen sin registrar'} → {stop.delivery}</p><p className="mt-1 text-xs text-slate-500">{stop.cargo}</p></td><td className="min-w-0 py-2 lg:px-4 lg:py-4"><p className="font-medium">{planningTime(plan.scheduled_departure)}</p><p className="mt-1 text-xs text-slate-600">{plan.vehicle_plate || 'Sin placa'} · {plan.driver_name || 'Sin conductor registrado'}</p><p className="mt-1 text-xs text-slate-500">{plan.status === 'PROGRAMADO' ? 'Programado' : 'Salida registrada'}</p></td><td className="py-2 lg:px-4 lg:py-4"><p className={`text-xs font-semibold ${hasPacking ? 'text-emerald-700' : 'text-amber-800'}`}>{hasPacking ? 'Packing List registrado' : 'Packing List pendiente'}</p><Link href={`/despacho/documentos?despacho=${plan.id}`} className="mt-3 inline-flex min-h-11 items-center gap-2 rounded-lg bg-[#002855] px-3 text-xs font-semibold text-white"><FileUp className="h-4 w-4" />{plan.status === 'PROGRAMADO' ? 'Gestionar Packing List' : 'Consultar Packing List'}</Link></td></tr>
    })}</tbody></DataTable></div></section>}
  </div>
}
