'use client'

import Link from 'next/link'
import { CalendarClock, CheckCircle2, ChevronRight, History, MapPin, Truck } from 'lucide-react'
import { useActiveTrip, type TripSummary } from '@/contexts/ActiveTripContext'

function TripCard({ item, active = false }: { item: TripSummary; active?: boolean }) {
  return <article className={`rounded-2xl border p-4 shadow-sm ${active ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-white'}`}>
    <div className="flex items-start justify-between gap-3"><div><p className="font-black text-[#002855]">{item.dispatch_number}</p><p className="mt-1 text-xs font-semibold text-slate-500">{item.vehicle_plate || 'Unidad por asignar'}</p></div><span className="rounded-full bg-slate-100 px-2.5 py-1 text-[10px] font-bold text-slate-700">{item.status}</span></div>
    <p className="mt-3 flex items-start gap-2 text-sm text-slate-600"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[#002855]" />{item.origin || 'Origen por confirmar'} → {item.destination || item.destination_address || 'Destino por confirmar'}</p>
    <p className="mt-2 flex items-center gap-2 text-xs text-slate-500"><CalendarClock className="h-4 w-4" />{item.scheduled_departure ? new Date(item.scheduled_departure).toLocaleString('es-PE') : 'Horario por confirmar'}</p>
    {active && <Link href="/app/ruta" className="mt-3 flex items-center justify-center gap-1 rounded-xl bg-[#002855] px-3 py-2 text-sm font-bold text-white">Abrir viaje <ChevronRight className="h-4 w-4" /></Link>}
  </article>
}

export default function ViajesPage() {
  const { trip, summary } = useActiveTrip()
  return <div className="mx-auto max-w-lg space-y-5 p-4">
    <div><h1 className="text-xl font-black text-[#002855]">Mis viajes</h1><p className="text-sm text-slate-500">Ruta activa, próximas programaciones e historial.</p></div>
    {trip && <section><h2 className="mb-2 text-sm font-black uppercase tracking-wide text-slate-500">En curso</h2><TripCard active item={{ ...trip, destination_address: trip.contract?.destination_address }} /></section>}
    <section><h2 className="mb-2 flex items-center gap-2 font-black text-slate-800"><Truck className="h-5 w-5" />Próximos</h2>{summary.upcoming.length ? <div className="space-y-3">{summary.upcoming.map(item => <TripCard key={item.id} item={item} />)}</div> : <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center"><CalendarClock className="mx-auto h-9 w-9 text-slate-300" /><p className="mt-2 font-bold text-slate-700">Sin programaciones próximas</p><p className="mt-1 text-sm text-slate-500">Se actualizará automáticamente al recibir una asignación.</p></div>}</section>
    <section><h2 className="mb-2 flex items-center gap-2 font-black text-slate-800"><History className="h-5 w-5" />Historial reciente</h2>{summary.recent.length ? <div className="space-y-3">{summary.recent.map(item => <TripCard key={item.id} item={item} />)}</div> : <div className="rounded-2xl bg-emerald-50 p-5 text-center text-emerald-800"><CheckCircle2 className="mx-auto h-8 w-8" /><p className="mt-2 text-sm font-semibold">Aún no hay viajes finalizados asociados a tu perfil.</p></div>}</section>
  </div>
}
