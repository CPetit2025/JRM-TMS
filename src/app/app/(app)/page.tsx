'use client'

import Link from 'next/link'
import { AlertTriangle, CalendarClock, Camera, CheckCircle2, ChevronRight, ClipboardCheck, DollarSign, Loader2, MapPin, Truck, Wrench } from 'lucide-react'
import { useActiveTrip } from '@/contexts/ActiveTripContext'

function greeting() {
  const hour = new Date().getHours()
  return hour < 12 ? 'Buenos días' : hour < 19 ? 'Buenas tardes' : 'Buenas noches'
}

export default function OperationalHome() {
  const { user, driver, trip, pending, loading } = useActiveTrip()
  if (loading && !user) return <div className="flex min-h-[55vh] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#002855]" /></div>

  const nextStop = trip?.stops.find(stop => stop.status !== 'ENTREGADO')
  return <div className="mx-auto max-w-lg space-y-4 p-4 pb-8">
    <section>
      <p className="text-sm text-slate-500">{greeting()},</p>
      <h1 className="text-2xl font-black text-[#002855]">{user?.first_name || 'Usuario'}</h1>
    </section>

    {trip ? <>
      <section className="overflow-hidden rounded-3xl bg-[#002855] text-white shadow-lg">
        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div><p className="text-xs font-semibold uppercase tracking-wide text-blue-200">Ruta actual</p><h2 className="mt-1 text-xl font-black">{trip.dispatch_number}</h2></div>
            <span className="rounded-full bg-white/15 px-3 py-1 text-xs font-bold">{trip.status}</span>
          </div>
          <div className="mt-4 flex items-center gap-2 text-sm"><Truck className="h-4 w-4 text-[#f8c400]" />{trip.vehicle_plate || 'Unidad pendiente'}</div>
          <div className="mt-2 flex items-start gap-2 text-sm"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-[#f8c400]" />
            <span>{nextStop?.pickup_address || 'Origen pendiente'} → {nextStop?.delivery_address || trip.contract?.destination_address || 'Destino pendiente'}</span>
          </div>
          <Link href="/app/ruta" className="mt-5 flex w-full items-center justify-center gap-2 rounded-xl bg-[#f8c400] px-4 py-3 font-black text-[#002855]">
            Ver viaje <ChevronRight className="h-5 w-5" />
          </Link>
        </div>
      </section>

      <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <h2 className="font-black text-slate-800">Pendientes</h2>
        <div className="mt-3 space-y-2 text-sm">
          {pending.checklist && <Link href="/app/checklist" className="flex items-center gap-2 rounded-xl bg-amber-50 p-3 text-amber-900"><AlertTriangle className="h-4 w-4" />Checklist pendiente</Link>}
          {(pending.stops || 0) > 0 && <div className="flex items-center gap-2 rounded-xl bg-blue-50 p-3 text-blue-900"><MapPin className="h-4 w-4" />{pending.stops} parada(s) por completar</div>}
          {(pending.expenses || 0) > 0 && <Link href="/app/gastos" className="flex items-center gap-2 rounded-xl bg-violet-50 p-3 text-violet-900"><DollarSign className="h-4 w-4" />{pending.expenses} gasto(s) pendientes</Link>}
          {!pending.checklist && !pending.stops && !pending.expenses && <div className="flex items-center gap-2 rounded-xl bg-emerald-50 p-3 text-emerald-800"><CheckCircle2 className="h-4 w-4" />Sin pendientes inmediatos</div>}
        </div>
      </section>

      <section><h2 className="mb-3 font-black text-slate-800">Acciones rápidas</h2>
        <div className="grid grid-cols-4 gap-2">
          {[
            ['/app/checklist', 'Checklist', ClipboardCheck], ['/app/ruta', 'Evidencia', Camera],
            ['/app/gastos', 'Gasto', DollarSign], ['/app/fallas', 'Incidencia', Wrench],
          ].map(([href, label, Icon]) => <Link key={String(label)} href={String(href)} className="flex flex-col items-center gap-2 rounded-2xl border border-slate-200 bg-white p-3 text-center text-[11px] font-bold text-[#002855] shadow-sm">
            <Icon className="h-6 w-6" />{String(label)}
          </Link>)}
        </div>
      </section>
    </> : <section className="space-y-4">
      <div className="rounded-3xl border border-blue-100 bg-blue-50 p-6 text-center">
        <CalendarClock className="mx-auto h-10 w-10 text-[#002855]" /><h2 className="mt-3 text-lg font-black text-[#002855]">Sin viaje activo</h2>
        <p className="mt-1 text-sm text-slate-600">Cuando recibas una programación aparecerá aquí con su unidad, horario y destino.</p>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="rounded-2xl border border-slate-200 bg-white p-4"><h3 className="font-bold text-slate-800">Estado</h3><p className="mt-2 text-sm text-slate-500">{driver ? 'Disponible para asignación' : 'Perfil operativo activo'}</p></div>
        <div className="rounded-2xl border border-slate-200 bg-white p-4"><h3 className="font-bold text-slate-800">Documentos</h3><p className="mt-2 text-sm text-slate-500">{driver?.license_expiration ? `Licencia vence: ${new Date(driver.license_expiration).toLocaleDateString('es-PE')}` : 'Revisa tu expediente operativo'}</p></div>
      </div>
    </section>}
  </div>
}
