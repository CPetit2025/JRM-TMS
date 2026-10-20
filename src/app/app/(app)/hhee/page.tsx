'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, Clock, Loader2, MapPin, RefreshCw, Timer, Truck, Users } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/caja'

type Item = {
  request_id: string; folio: string; work_date: string; state: string; approval: string; route: string | null; plate: string | null
  start: string; planned_end: string; actual_end: string | null; actual_minutes: number | null; closed_by: string | null
  compensation: boolean; geo_entered_at: string | null; can_close: boolean; crew: { name: string; closed: boolean }[]
}

const hour = (v?: string | null) => v ? new Date(v).toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit' }) : '—'
const day = (v: string) => new Date(`${v}T12:00:00`).toLocaleDateString('es-PE', { weekday: 'short', day: '2-digit', month: 'short' })
const span = (min: number) => `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`
const CLOSED_BY: Record<string, string> = { CONDUCTOR: 'Cerrada por ti', GEOCERCA: 'Cerrada al salir de la base', SUPERVISOR: 'Registrada por el supervisor' }
const APPROVAL: Record<string, string> = { APROBADA: 'Aprobada', PENDIENTE: 'En aprobación', OBSERVADA: 'Observada', RECHAZADA: 'Rechazada' }

/** Mis horas extras: las de la ruta (conductor y auxiliar). Solo el conductor las cierra; al cerrar, cierra a toda la tripulación. */
export default function MisHorasExtrasPage() {
  const supabase = useMemo(() => createClient(), [])
  const [items, setItems] = useState<Item[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('hhee_driver_overtime')
    if (error || !data?.success) { toast.error(error ? errorMessage(error) : data?.error || 'No se pudo cargar'); setItems([]); return }
    setItems(data.items as Item[])
  }, [supabase])
  useEffect(() => {
    const t = window.setTimeout(() => void load(), 0)
    const tick = window.setInterval(() => setNow(Date.now()), 30000)
    return () => { window.clearTimeout(t); window.clearInterval(tick) }
  }, [load])

  const close = async (item: Item) => {
    const crew = item.crew.filter(c => !c.closed).map(c => c.name)
    if (!window.confirm(`¿Terminaste? Se cierran tus horas extras a las ${hour(new Date().toISOString())}${crew.length ? ` y las de ${crew.join(', ')}` : ''}.`)) return
    setBusy(item.request_id)
    const { data, error } = await supabase.rpc('hhee_driver_close', { p_request: item.request_id })
    setBusy(null)
    if (error || !data?.success) { toast.error(error ? errorMessage(error) : data?.error || 'No se pudo cerrar'); return }
    toast.success('Horas extras cerradas')
    await load()
  }

  const open = (items || []).filter(i => !i.actual_end)
  const done = (items || []).filter(i => i.actual_end)
  return <div className="mx-auto max-w-lg space-y-4 p-4 pb-8">
    <header className="rounded-xl border border-slate-200 bg-white p-4">
      <h1 className="flex items-center gap-2 text-lg font-bold text-[#002855]"><Timer className="h-6 w-6" />Mis horas extras</h1>
      <p className="mt-1 text-sm text-slate-600">Desde las 17:30 (sábado 13:30) la ruta en curso pasa a horas extras. Ciérralas al terminar; si no, se cierran solas cuando la unidad sale de la base (CEDI o cochera) después de haber entrado.</p>
    </header>

    {items === null ? <p className="flex justify-center p-6"><Loader2 className="h-6 w-6 animate-spin" /></p>
      : items.length === 0 ? <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">No tienes horas extras en los últimos días.</p>
      : <>
        {open.map(item => {
          const running = Math.max(0, Math.round((now - new Date(item.start).getTime()) / 60000))
          return <section key={item.request_id} className="space-y-3 rounded-2xl border border-amber-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-2">
              <div><p className="text-xs font-semibold uppercase text-slate-500">{item.folio} · {day(item.work_date)}</p>
                <p className="mt-1 flex items-center gap-2 font-black text-[#002855]"><Truck className="h-4 w-4" />{item.route ? `Ruta ${item.route}` : 'Sin ruta'}{item.plate ? ` · ${item.plate}` : ''}</p></div>
              <span className={`rounded-full px-2 py-1 text-xs font-bold ${item.approval === 'APROBADA' ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-700'}`}>{APPROVAL[item.approval] || item.approval}</span>
            </div>
            <div className="grid grid-cols-2 gap-2 text-sm">
              <p><span className="block text-xs text-slate-500">Inicio</span><b>{hour(item.start)}</b></p>
              <p><span className="block text-xs text-slate-500">Fin estimado</span><b>{hour(item.planned_end)}</b></p>
              <p className="col-span-2 flex items-center gap-2 rounded-lg bg-amber-50 p-2 text-amber-900"><Clock className="h-4 w-4" />{new Date(item.start).getTime() > now ? 'Aún no empiezan' : `En curso: ${span(running)}`}</p>
              {item.geo_entered_at && <p className="col-span-2 flex items-center gap-2 text-xs text-slate-600"><MapPin className="h-4 w-4" />Entraste a la base a las {hour(item.geo_entered_at)}: se cierran al salir.</p>}
            </div>
            {item.crew.length > 0 && <p className="flex items-center gap-2 text-sm text-slate-600"><Users className="h-4 w-4 shrink-0" />Tripulación: {item.crew.map(c => c.name).join(', ')}</p>}
            {item.can_close ? <button type="button" disabled={busy === item.request_id} onClick={() => void close(item)}
                className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#002855] px-4 text-sm font-bold text-white disabled:opacity-60">
                {busy === item.request_id ? <Loader2 className="h-4 w-4 animate-spin" /> : <CheckCircle2 className="h-4 w-4" />}Terminé · cerrar horas extras{item.crew.length ? ' (con la tripulación)' : ''}</button>
              : <p className="rounded-lg bg-slate-50 p-2 text-xs text-slate-600">{running > 960 ? 'Pasaron más de 16 horas: tu supervisor registra la hora real de fin.' : 'El conductor de la ruta cierra las horas extras de toda la tripulación.'}</p>}
          </section>
        })}
        {done.length > 0 && <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="font-black text-slate-800">Cerradas</h2>
          <ul className="mt-2 divide-y divide-slate-100 text-sm">{done.map(item => <li key={item.request_id} className="py-2">
            <p className="flex justify-between gap-2"><b className="text-[#002855]">{item.folio} · {day(item.work_date)}</b><span>{span(item.actual_minutes || 0)}</span></p>
            <p className="text-xs text-slate-500">{hour(item.start)}–{hour(item.actual_end)} · {CLOSED_BY[item.closed_by || ''] || 'Cerrada'}{item.compensation ? ' · a compensar con descanso' : ''}</p>
          </li>)}</ul>
        </section>}
      </>}
    <button type="button" onClick={() => void load()} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm"><RefreshCw className="h-4 w-4" />Actualizar</button>
    <Link href="/app" className="block py-3 text-center text-sm font-semibold text-[#002855]">Volver a Inicio</Link>
  </div>
}
