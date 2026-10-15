'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { Camera, CheckCircle2, Gauge, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/caja'
import { formatKm, odometerPhotoPath, prepareOdometerPhoto, uploadOdometerPhoto } from '@/lib/odometer'

type Workday = {
  success: boolean; error?: string; operation_date: string; unit: string | null
  start?: { odometer: number; captured_at: string } | null; close?: { odometer: number; captured_at: string } | null
  active_route?: boolean
}

/** Cierre de jornada: odómetro final del día con foto del tablero. Con el inicio del checklist da los km del día. */
export default function JornadaPage() {
  const supabase = useMemo(() => createClient(), [])
  const [day, setDay] = useState<Workday | null>(null)
  const [loading, setLoading] = useState(true)
  const [odometer, setOdometer] = useState('')
  const [photo, setPhoto] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [operation, setOperation] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const { data, error } = await supabase.rpc('get_driver_workday')
    setLoading(false)
    if (error) { toast.error(errorMessage(error)); return }
    setDay(data as Workday)
  }, [supabase])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])

  const km = Number(odometer.replace(',', '.'))
  const start = day?.start?.odometer != null ? Number(day.start.odometer) : null

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (!navigator.onLine) { toast.error('Sin señal: cierre la jornada cuando tenga conexión. Si no lo hace, se tomará el odómetro del checklist de mañana.'); return }
    if (!(km > 0)) { toast.error('Ingrese el odómetro (km) que marca el tablero.'); return }
    if (!photo) { toast.error('Tome la foto del odómetro (tablero).'); return }
    if (start != null && km < start && !window.confirm(`El odómetro final (${formatKm(km)}) es menor que el de inicio (${formatKm(start)}). ¿Está seguro? Revise el tablero.`)) return
    if (day?.active_route && !window.confirm('Tiene una ruta en curso. ¿Cerrar la jornada de todas formas?')) return
    setBusy(true)
    try {
      const op = operation || crypto.randomUUID(); setOperation(op)
      const { data: auth } = await supabase.auth.getUser()
      if (!auth.user) throw new Error('Sesión vencida: vuelva a ingresar')
      const file = await prepareOdometerPhoto(photo)
      const path = await uploadOdometerPhoto(supabase, odometerPhotoPath(auth.user.id, op, file.type), file)
      const { data, error } = await supabase.rpc('close_driver_workday', { p_operation: op, p_odometer: String(km), p_photo: path, p_captured_at: new Date().toISOString() })
      if (error || !data?.success) throw error || new Error(data?.error || 'No se pudo cerrar la jornada')
      toast.success(data.km != null ? `Jornada cerrada: ${formatKm(data.km)} recorridos hoy` : 'Jornada cerrada')
      setOperation(null); setPhoto(null); setOdometer(''); await load()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }

  const input = 'mt-1 min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm'
  return <div className="mx-auto max-w-lg space-y-4 p-4 pb-8">
    <header className="rounded-xl border border-slate-200 bg-white p-4">
      <h1 className="flex items-center gap-2 text-lg font-bold text-[#002855]"><Gauge className="h-6 w-6" />Cerrar jornada</h1>
      <p className="mt-1 text-sm text-slate-600">Al terminar el día registra el odómetro final con la foto del tablero. Con el odómetro del checklist se calculan los km del día de la unidad.</p>
    </header>
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
          <label className="flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-lg border border-dashed border-[#002855] px-3 text-sm font-semibold text-[#002855]">
            <Camera className="h-5 w-5" />{photo ? 'Foto del tablero lista · cambiar' : 'Tomar foto del tablero'}
            <input type="file" accept="image/*" capture="environment" className="hidden" onChange={e => setPhoto(e.target.files?.[0] || null)} /></label>
          <button type="submit" disabled={busy} className="flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[#002855] px-4 text-sm font-bold text-white disabled:opacity-60">{busy && <Loader2 className="h-4 w-4 animate-spin" />}Cerrar jornada</button>
        </form>}
      </>}
    <button type="button" onClick={() => void load()} className="flex min-h-11 items-center gap-2 rounded-lg border border-slate-300 px-3 text-sm"><RefreshCw className="h-4 w-4" />Actualizar</button>
    <Link href="/app" className="block py-3 text-center text-sm font-semibold text-[#002855]">Volver a Inicio</Link>
  </div>
}
