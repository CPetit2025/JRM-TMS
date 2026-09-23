'use client'

import Link from 'next/link'
import { AlertTriangle, Bot, CalendarClock, Camera, CheckCircle2, ChevronRight, ClipboardCheck, DollarSign, History, Loader2, MapPin, RefreshCw, ShieldCheck, Truck, Wrench } from 'lucide-react'
import { useActiveTrip } from '@/contexts/ActiveTripContext'

function greeting() {
  const hour = new Date().getHours()
  return hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches'
}

function dateTime(value?: string | null) {
  return value ? new Date(value).toLocaleString('es-PE', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' }) : 'Por confirmar'
}

export default function OperationalHome() {
  const { user, driver, trip, pending, summary, loading, error, refresh } = useActiveTrip()
  if (loading && !user) return <div className="flex min-h-[55vh] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#002855]" /></div>

  const nextStop = trip?.stops.find(stop => stop.status !== 'ENTREGADO')
  const nextTrip = summary.upcoming[0]
  const quick = trip ? [
    ['/app/checklist', 'Checklist', ClipboardCheck], ['/app/ruta', 'Evidencia', Camera],
    ['/app/gastos', 'Gasto', DollarSign], ['/app/fallas', 'Incidencia', Wrench],
  ] as const : [
    ['/app/viajes', 'Mis viajes', Truck], ['/app/actividades', 'Actividad', History],
    ['/app/fallas', 'Reportar falla', Wrench], ['/app/perfil', 'Mi expediente', ShieldCheck],
  ] as const

  return <div className="mx-auto max-w-lg space-y-4 p-4 pb-8">
    <section className="flex items-start justify-between gap-3">
      <div><p className="text-sm text-slate-500">{greeting()},</p><h1 className="text-2xl font-black text-[#002855]">{user?.first_name || driver?.first_name || 'Conductor'}</h1></div>
      <button type="button" onClick={() => void refresh()} aria-label="Actualizar información" className="rounded-full border border-slate-200 bg-white p-2.5 text-[#002855] shadow-sm"><RefreshCw className="h-4 w-4" /></button>
    </section>

    {error && <section className="rounded-2xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><b>Información parcialmente disponible.</b> Pulsa actualizar. Si continúa, informa a soporte.</section>}

    {trip ? <section className="overflow-hidden rounded-3xl bg-[#002855] text-white shadow-lg"><div className="p-5">
      <div className="flex items-start justify-between gap-3"><div><p className="text-xs font-semibold uppercase tracking-wide text-blue-200">Ruta actual</p><h2 className="mt-1 text-xl font-black">{trip.dispatch_number}</h2></div><span className="rounded-full bg-white/15 px-3 py-1 text-xs font-bold">{trip.status}</span></div>
      <div className="mt-4 flex items-center gap-2 text-sm"><Truck className="h-4 w-4 text-[#f8c400]" />{trip.vehicle_plate || 'Unidad pendiente'}</div>
      <div className="mt-2 flex items-start gap-2 text-sm"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[#f8c400]" /><span>{nextStop?.pickup_address || 'Origen pendiente'} → {nextStop?.delivery_address || trip.contract?.destination_address || 'Destino pendiente'}</span></div>
      <Link href="/app/ruta" className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-[#f8c400] px-4 py-3 font-black text-[#002855]">Ver viaje <ChevronRight className="h-5 w-5" /></Link>
    </div></section> : <section className="overflow-hidden rounded-3xl border border-blue-100 bg-white shadow-sm">
      <div className="bg-[#002855] p-5 text-white"><div className="flex items-center justify-between"><div><p className="text-xs font-bold uppercase tracking-wide text-blue-200">Estado operativo</p><h2 className="mt-1 text-xl font-black">Disponible</h2></div><span className="h-3 w-3 rounded-full bg-emerald-400 ring-4 ring-emerald-400/20" /></div><p className="mt-2 text-sm text-blue-100">Tu sesión de conductor está activa.</p></div>
      <div className="p-4">{nextTrip ? <><p className="text-xs font-bold uppercase text-slate-400">Próxima programación</p><p className="mt-1 font-black text-[#002855]">{nextTrip.dispatch_number} · {nextTrip.vehicle_plate || 'Unidad por asignar'}</p><p className="mt-1 text-sm text-slate-600">{nextTrip.origin || 'Origen por confirmar'} → {nextTrip.destination || nextTrip.destination_address || 'Destino por confirmar'}</p><p className="mt-2 text-xs font-semibold text-slate-500">{dateTime(nextTrip.scheduled_departure)}</p></> : <div className="flex gap-3"><CalendarClock className="h-9 w-9 shrink-0 text-[#002855]" /><div><h3 className="font-bold text-slate-800">Sin programación asignada</h3><p className="mt-1 text-sm text-slate-500">La próxima ruta aparecerá aquí automáticamente cuando despacho la asigne.</p></div></div>}</div>
    </section>}

    <button type="button" onClick={() => window.dispatchEvent(new Event('jrm:open-ai'))} className="flex w-full items-center gap-3 rounded-2xl bg-gradient-to-r from-[#002855] to-[#00509d] p-4 text-left text-white shadow-md">
      <span className="rounded-full bg-white/15 p-2"><Bot className="h-6 w-6 text-[#f8c400]" /></span><span className="flex-1"><b className="block">Copiloto IA</b><small className="text-blue-100">Habla, consulta tu viaje o prepara una acción</small></span><ChevronRight className="h-5 w-5" />
    </button>

    {trip && <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><h2 className="font-black text-slate-800">Pendientes del viaje</h2><div className="mt-3 space-y-2 text-sm">
      {pending.checklist && <Link href="/app/checklist" className="flex items-center gap-2 rounded-xl bg-amber-50 p-3 text-amber-900"><AlertTriangle className="h-4 w-4" />Checklist pendiente</Link>}
      {(pending.stops || 0) > 0 && <div className="flex items-center gap-2 rounded-xl bg-blue-50 p-3 text-blue-900"><MapPin className="h-4 w-4" />{pending.stops} parada(s) por completar</div>}
      {(pending.expenses || 0) > 0 && <Link href="/app/gastos" className="flex items-center gap-2 rounded-xl bg-violet-50 p-3 text-violet-900"><DollarSign className="h-4 w-4" />{pending.expenses} gasto(s) pendientes</Link>}
      {!pending.checklist && !pending.stops && !pending.expenses && <div className="flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-emerald-800"><CheckCircle2 className="h-4 w-4" />Sin pendientes inmediatos</div>}
    </div></section>}

    <section><h2 className="mb-3 font-black text-slate-800">Acciones rápidas</h2><div className="grid grid-cols-4 gap-2">{quick.map(([href, label, Icon]) => <Link key={href} href={href} className="flex min-h-20 flex-col items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white p-2 text-center text-[11px] font-bold text-[#002855] shadow-sm"><Icon className="h-6 w-6" />{label}</Link>)}</div></section>

    {!trip && <><section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm"><div className="flex items-center justify-between"><h2 className="font-black text-slate-800">Alertas y documentos</h2><Link href="/app/alertas" className="text-xs font-bold text-[#002855]">Ver todas</Link></div><div className="mt-3 space-y-2">{summary.alerts.map(alert => <div key={alert.code} className={`flex items-start gap-2 rounded-xl p-3 text-sm ${alert.level === 'error' ? 'bg-red-50 text-red-800' : alert.level === 'warning' ? 'bg-amber-50 text-amber-900' : 'bg-emerald-50 text-emerald-800'}`}>{alert.level === 'success' ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />}{alert.message}</div>)}</div></section>
      <section className="grid grid-cols-3 gap-2 text-center"><div className="rounded-2xl bg-white p-3 shadow-sm"><b className="block text-xl text-[#002855]">{summary.stats.completed_30d}</b><span className="text-[10px] text-slate-500">Viajes 30 días</span></div><div className="rounded-2xl bg-white p-3 shadow-sm"><b className="block text-xl text-[#002855]">{summary.stats.open_failures}</b><span className="text-[10px] text-slate-500">Fallas abiertas</span></div><div className="rounded-2xl bg-white p-3 shadow-sm"><b className="block text-xl text-[#002855]">{summary.stats.pending_expenses}</b><span className="text-[10px] text-slate-500">Gastos pendientes</span></div></section></>}
  </div>
}
