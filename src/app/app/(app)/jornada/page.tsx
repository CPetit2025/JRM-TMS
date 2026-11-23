'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, Gauge, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/caja'
import { formatKm } from '@/lib/odometer'
import { syncWorkdayReminder } from '@/lib/workday-reminder'

type Workday = {
  success: boolean; error?: string; operation_date: string; unit: string | null
  start?: { odometer: number; captured_at: string } | null; close?: { odometer: number; captured_at: string } | null
  active_route?: boolean
}

/** Cierre de jornada: odómetro final del día por ingreso manual. Con el inicio del checklist da los km del día. */
export default function JornadaPage() {
  const supabase = useMemo(() => createClient(), [])
  const [day, setDay] = useState<Workday | null>(null)
  const [loading, setLoading] = useState(true)
  const [odometer, setOdometer] = useState('')
  const [busy, setBusy] = useState(false)
  const [operation, setOperation] = useState<string | null>(null)

  const [pending, setPending] = useState<{ operation_date: string; unit: string; start_odometer: number | null } | null>(null)
  const [prevOdo, setPrevOdo] = useState(''), [noAccess, setNoAccess] = useState(false), [reason, setReason] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    const [{ data, error }, p] = await Promise.all([supabase.rpc('get_driver_workday'), supabase.rpc('get_driver_pending_close')])
    setLoading(false)
    setPending(p.data?.success ? p.data.pending : null)
    if (error) { toast.error(errorMessage(error)); return }
    setDay(data as Workday)
    if (data?.success) void syncWorkdayReminder(!!(data.start && !data.close))
  }, [supabase])

  // Jornada anterior sin cierre: odómetro actual del tablero o, sin acceso a la unidad, el motivo
  const closePrevious = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy || !pending) return
    if (!navigator.onLine) { toast.error('Sin señal: vuelve a intentarlo cuando tengas conexión.'); return }
    const value = Number(prevOdo.replace(',', '.'))
    if (!noAccess && !(value > 0 && value < 5000000)) { toast.error('Ingrese el odómetro (km) que marca el tablero.'); return }
    if (noAccess && reason.trim().length < 10) { toast.error('Explique por qué no puede leer el odómetro (mínimo 10 caracteres).'); return }
    const start = pending.start_odometer != null ? Number(pending.start_odometer) : null
    if (!noAccess && start != null && value < start && !window.confirm(`El odómetro (${formatKm(value)}) es menor que el de inicio de esa jornada (${formatKm(start)}). ¿Está seguro?`)) return
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('close_driver_pending_workday', { p_operation: crypto.randomUUID(), p_odometer: noAccess ? null : String(value), p_reason: noAccess ? reason.trim() : null })
      if (error || !data?.success) throw error || new Error(data?.error || 'No se pudo cerrar la jornada')
      toast.success(data.waived ? 'Motivo registrado. Ya puedes hacer el checklist de hoy.' : data.km != null ? `Jornada cerrada: ${formatKm(data.km)} recorridos` : 'Jornada cerrada')
      setPrevOdo(''); setReason(''); setNoAccess(false); await load()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])

  const km = Number(odometer.replace(',', '.'))
  const start = day?.start?.odometer != null ? Number(day.start.odometer) : null

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (!navigator.onLine) { toast.error('Sin señal: cierre la jornada cuando tenga conexión. Si no lo hace, se tomará el odómetro del checklist de mañana.'); return }
    if (!(km > 0 && km < 5000000)) { toast.error('Ingrese el odómetro (km) que marca el tablero.'); return }
    if (start != null && km < start && !window.confirm(`El odómetro final (${formatKm(km)}) es menor que el de inicio (${formatKm(start)}). ¿Está seguro? Revise el tablero.`)) return
    if (day?.active_route && !window.confirm('Tiene una ruta en curso. ¿Cerrar la jornada de todas formas?')) return
    setBusy(true)
    try {
      const op = operation || crypto.randomUUID(); setOperation(op)
      const { data, error } = await supabase.rpc('close_driver_workday', { p_operation: op, p_odometer: String(km), p_photo: null, p_captured_at: new Date().toISOString() })
      if (error || !data?.success) throw error || new Error(data?.error || 'No se pudo cerrar la jornada')
      toast.success(data.km != null ? `Jornada cerrada: ${formatKm(data.km)} recorridos hoy` : 'Jornada cerrada')
      setOperation(null); setOdometer(''); await load()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }

  const input = 'mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm'
  return <div className="mx-auto max-w-lg space-y-4 p-4 pb-8">
    <header className="rounded-xl border border-slate-200 bg-white p-4">
      <h1 className="flex items-center gap-2 text-lg font-bold text-[#002855]"><Gauge className="h-6 w-6" />Cerrar jornada</h1>
      <p className="mt-1 text-sm text-slate-600">Al terminar el día registra el odómetro final que marca el tablero. Con el odómetro del checklist se calculan los km del día de la unidad.</p>
    </header>
    {pending && <form onSubmit={closePrevious} className="space-y-3 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
      <p><b className="block">Jornada del {pending.operation_date} sin cerrar · {pending.unit}</b>Registra el odómetro que marca ahora el tablero de esa unidad. Hasta cerrarla no podrás hacer el checklist de hoy.</p>
      {!noAccess && <label className="block font-semibold">Odómetro actual (km)
        <input inputMode="decimal" value={prevOdo} onChange={e => setPrevOdo(e.target.value.replace(/[^0-9.,]/g, ''))} placeholder={pending.start_odometer != null ? `Inicio: ${formatKm(Number(pending.start_odometer))}` : 'Ej.: 125610'} className={input} /></label>}
      <label className="flex min-h-11 items-center gap-2"><input type="checkbox" checked={noAccess} onChange={e => setNoAccess(e.target.checked)} className="h-5 w-5" />No tengo acceso a esa unidad</label>
      {noAccess && <label className="block font-semibold">Motivo (quedará para revisión)
        <textarea value={reason} onChange={e => setReason(e.target.value)} rows={2} placeholder="Ej.: la unidad quedó en taller" className="mt-1 w-full rounded-lg border border-slate-300 bg-white p-3 text-sm text-slate-900" /></label>}
      <button type="submit" disabled={busy} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-red-700 px-4 text-sm font-bold text-white disabled:opacity-60">{busy && <Loader2 className="h-4 w-4 animate-spin" />}{noAccess ? 'Registrar motivo' : 'Cerrar esa jornada'}</button>
    </form>}
    {loading && !day ? <p className="flex justify-center p-6"><Loader2 className="h-6 w-6 animate-spin" /></p>
      : !day?.success ? <p className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{day?.error || 'No se pudo cargar la jornada'}</p>
      : !day.unit ? <section className="space-y-3 rounded-xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
          <p>Hoy no tienes una unidad confirmada. Realiza primero el checklist del día.</p>
          <Link href="/app/checklist" className="inline-flex min-h-11 items-center rounded-lg bg-[#002855] px-4 font-semibold text-white">Ir al checklist</Link>
        </section>
      : <>
        <section className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-white p-4 text-sm">
          <p><span className="block text-xs text-slate-500">Unidad</span><b>{day.unit}</b></p>
          <p><span className="block text-xs text-slate-500">Fecha</span><b>{day.operation_date}</b></p>
          <p><span className="block text-xs text-slate-500">Odómetro de inicio</span><b>{start != null ? formatKm(start) : 'Sin registrar'}</b></p>
          <p><span className="block text-xs text-slate-500">Odómetro final</span><b>{day.close ? formatKm(day.close.odometer) : 'Pendiente'}</b></p>
          {day.close && start != null && <p className="col-span-2 flex items-center gap-2 rounded-lg bg-emerald-50 p-3 text-emerald-800"><CheckCircle2 className="h-4 w-4" />Jornada cerrada · {formatKm(Math.max(Number(day.close.odometer) - start, 0))} recorridos</p>}
        </section>
        {!day.close && <form onSubmit={submit} className="space-y-3 rounded-xl border border-slate-200 bg-white p-4">
          <label className="block text-sm font-semibold">Odómetro final (km)
            <input required inputMode="decimal" value={odometer} onChange={e => setOdometer(e.target.value.replace(/[^0-9.,]/g, ''))} placeholder={start != null ? `Mayor o igual a ${formatKm(start)}` : 'Ej.: 125610'} className={input} /></label>
          {start != null && km > 0 && km >= start && <p className="text-sm text-slate-600">Recorrido del día: <b>{formatKm(km - start)}</b></p>}
          <button type="submit" disabled={busy} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#002855] px-4 text-sm font-bold text-white disabled:opacity-60">{busy && <Loader2 className="h-4 w-4 animate-spin" />}Cerrar jornada</button>
        </form>}
      </>}
    <button type="button" onClick={() => void load()} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm"><RefreshCw className="h-4 w-4" />Actualizar</button>
    <Link href="/app" className="block py-3 text-center text-sm font-semibold text-[#002855]">Volver a Inicio</Link>
  </div>
}
