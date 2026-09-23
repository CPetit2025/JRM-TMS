'use client'

import Link from 'next/link'
import { AlertTriangle, CheckCircle2, FileWarning, Wrench } from 'lucide-react'
import { useActiveTrip } from '@/contexts/ActiveTripContext'

export default function AlertasPage() {
  const { pending, summary, trip } = useActiveTrip()
  const operational = [
    trip && pending.checklist ? { code: 'CHECKLIST', message: 'Checklist del viaje pendiente.', href: '/app/checklist' } : null,
    trip && (pending.stops || 0) > 0 ? { code: 'STOPS', message: `${pending.stops} parada(s) pendientes de completar.`, href: '/app/ruta' } : null,
    summary.stats.open_failures > 0 ? { code: 'FAILURES', message: `${summary.stats.open_failures} reporte(s) de falla abiertos.`, href: '/app/fallas' } : null,
  ].filter(Boolean) as Array<{ code: string; message: string; href: string }>
  return <div className="mx-auto max-w-lg space-y-5 p-4">
    <div><h1 className="text-xl font-black text-[#002855]">Alertas</h1><p className="text-sm text-slate-500">Documentos, viaje y pendientes operativos.</p></div>
    <section className="space-y-3">{summary.alerts.map(item => <div key={item.code} className={`flex items-start gap-3 rounded-2xl border p-4 ${item.level === 'error' ? 'border-red-200 bg-red-50 text-red-900' : item.level === 'warning' ? 'border-amber-200 bg-amber-50 text-amber-900' : 'border-emerald-200 bg-emerald-50 text-emerald-900'}`}>{item.level === 'success' ? <CheckCircle2 className="h-5 w-5 shrink-0" /> : <FileWarning className="h-5 w-5 shrink-0" />}<p className="text-sm font-semibold">{item.message}</p></div>)}</section>
    <section><h2 className="mb-3 font-black text-slate-800">Pendientes operativos</h2>{operational.length ? <div className="space-y-2">{operational.map(item => <Link key={item.code} href={item.href} className="flex items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-sm font-semibold text-slate-800 shadow-sm"><AlertTriangle className="h-5 w-5 text-amber-600" />{item.message}</Link>)}</div> : <div className="rounded-2xl bg-white p-6 text-center shadow-sm"><CheckCircle2 className="mx-auto h-9 w-9 text-emerald-600" /><p className="mt-2 font-bold text-slate-800">Sin pendientes inmediatos</p></div>}</section>
    <Link href="/app/fallas" className="flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-3 font-bold text-[#002855]"><Wrench className="h-5 w-5" />Reportar falla o incidencia</Link>
  </div>
}
