'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, ChevronLeft, Forklift, Gauge, Loader2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

// Turno del operario: horómetro al iniciar el turno y checklist del equipo (pre-uso de montacargas, semanal de
// elevadores). Un ítem crítico en falla se reporta a Mantenimiento como falla crítica (ver mant_registrar_turno).

type Item = { id: string; texto: string; critico: boolean }
type Equipo = {
  vehicle_id: string; plate: string; codigo: string | null; modelo: string; familia: string; familia_nombre: string
  lectura: 'KM' | 'HORAS' | 'CALENDARIO'; checklist: Item[]; checklist_frecuencia: 'TURNO' | 'SEMANAL'
  horas: number | null; ultimo_turno: string | null; ultimo_semanal: string | null; semanal_pendiente: boolean
}
type Marca = { ok: boolean; obs: string }

function hace(fecha: string | null) {
  if (!fecha) return 'Sin registros'
  const h = Math.round((Date.now() - new Date(fecha).getTime()) / 3600000)
  if (h < 1) return 'Hace menos de 1 h'
  if (h < 24) return `Hace ${h} h`
  const d = Math.round(h / 24)
  return d === 1 ? 'Ayer' : `Hace ${d} días`
}

export default function EquiposTurnoPage() {
  const supabase = useMemo(() => createClient(), [])
  const [equipos, setEquipos] = useState<Equipo[] | null>(null)
  const [sel, setSel] = useState<Equipo | null>(null)
  const [horas, setHoras] = useState('')
  const [marcas, setMarcas] = useState<Record<string, Marca>>({})
  const [obs, setObs] = useState('')
  const [saving, setSaving] = useState(false)

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('mant_equipos_turno')
    if (error || !data?.success) { toast.error(error?.message || data?.error || 'No se pudo cargar los equipos'); setEquipos([]); return }
    setEquipos(data.equipos || [])
  }, [supabase])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])

  const abrir = (e: Equipo) => {
    setSel(e); setHoras(''); setObs('')
    setMarcas(Object.fromEntries(e.checklist.map(i => [i.id, { ok: true, obs: '' }])))
  }

  const enFalla = sel ? sel.checklist.filter(i => marcas[i.id] && !marcas[i.id].ok) : []

  const guardar = async () => {
    if (!sel) return
    if (sel.lectura === 'HORAS' && !horas.trim()) return toast.error('Registra el horómetro')
    if (horas.trim() && (isNaN(Number(horas)) || Number(horas) < 0)) return toast.error('Horómetro inválido')
    if (enFalla.some(i => i.critico) && !confirm('Marcaste un punto crítico en falla: se reportará a Mantenimiento y el equipo no debe operar hasta revisarse. ¿Continuar?')) return
    setSaving(true)
    const { data, error } = await supabase.rpc('mant_registrar_turno', {
      p_vehicle_id: sel.vehicle_id, p_horas: horas.trim() ? Number(horas) : null,
      p_checklist: sel.checklist.map(i => ({ id: i.id, ok: marcas[i.id]?.ok ?? true, obs: marcas[i.id]?.obs || null })),
      p_observaciones: obs.trim() || null,
    })
    setSaving(false)
    if (error || !data?.success) return toast.error(error?.message || data?.error || 'No se pudo registrar')
    if (data.aviso) toast.warning(data.aviso, { duration: 8000 })
    else toast.success('Turno registrado')
    if (data.fallas > 0) toast.info(`${data.fallas} punto(s) reportado(s) a Mantenimiento`)
    setSel(null)
    void load()
  }

  if (equipos === null) return <div className="flex min-h-[55vh] items-center justify-center"><Loader2 className="h-8 w-8 animate-spin text-[#002855]" /></div>

  if (sel) return <div className="mx-auto max-w-lg space-y-4 p-4 pb-8">
    <button type="button" onClick={() => setSel(null)} className="flex items-center gap-1 text-sm font-bold text-[#002855]"><ChevronLeft className="h-4 w-4" />Equipos</button>
    <section className="rounded-3xl bg-[#002855] p-5 text-white shadow-lg">
      <p className="text-xs font-bold uppercase tracking-wide text-blue-200">{sel.familia_nombre}</p>
      <h1 className="mt-1 text-2xl font-black">{sel.plate}</h1>
      <p className="text-sm text-blue-100">{sel.modelo}{sel.codigo ? ` · ${sel.codigo}` : ''}</p>
    </section>

    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <label className="flex items-center gap-2 font-black text-slate-800"><Gauge className="h-5 w-5 text-[#002855]" />Horómetro {sel.lectura === 'HORAS' ? '' : '(si tiene)'}</label>
      <input type="number" inputMode="decimal" min={0} step="0.1" value={horas} onChange={e => setHoras(e.target.value)}
        placeholder={sel.horas != null ? `Último: ${sel.horas} h` : 'Horas'} className="mt-2 w-full rounded-xl border border-slate-300 px-3 py-3 text-lg font-bold text-slate-900 outline-none focus:ring-2 focus:ring-[#002855]" />
      {sel.horas != null && <p className="mt-1 text-xs text-slate-500">Última lectura válida: {sel.horas} h</p>}
    </section>

    <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <h2 className="font-black text-slate-800">Checklist {sel.checklist_frecuencia === 'SEMANAL' ? 'semanal' : 'de inicio de turno'}</h2>
      <p className="text-xs text-slate-500">Marca solo lo que está mal. Los puntos <b className="text-[#cf152d]">críticos</b> se reportan a Mantenimiento.</p>
      <ul className="mt-3 space-y-2">
        {sel.checklist.map(i => {
          const m = marcas[i.id] || { ok: true, obs: '' }
          return <li key={i.id} className={`rounded-xl border p-3 ${m.ok ? 'border-slate-200' : 'border-red-200 bg-red-50'}`}>
            <div className="flex items-start justify-between gap-2">
              <span className="text-sm font-semibold text-slate-800">{i.texto}{i.critico && <span className="ml-1 rounded bg-red-100 px-1.5 text-[10px] font-bold text-[#cf152d]">CRÍTICO</span>}</span>
              <div className="flex shrink-0 gap-1">
                <button type="button" aria-label="Bien" onClick={() => setMarcas(s => ({ ...s, [i.id]: { ...m, ok: true } }))}
                  className={`rounded-lg p-1.5 ${m.ok ? 'bg-emerald-500 text-white' : 'bg-slate-100 text-slate-400'}`}><CheckCircle2 className="h-5 w-5" /></button>
                <button type="button" aria-label="En falla" onClick={() => setMarcas(s => ({ ...s, [i.id]: { ...m, ok: false } }))}
                  className={`rounded-lg p-1.5 ${!m.ok ? 'bg-[#cf152d] text-white' : 'bg-slate-100 text-slate-400'}`}><XCircle className="h-5 w-5" /></button>
              </div>
            </div>
            {!m.ok && <input value={m.obs} onChange={e => setMarcas(s => ({ ...s, [i.id]: { ...m, obs: e.target.value } }))} placeholder="¿Qué observaste?"
              className="mt-2 w-full rounded-lg border border-red-200 bg-white px-3 py-2 text-sm text-slate-900 outline-none" />}
          </li>
        })}
      </ul>
      <textarea value={obs} onChange={e => setObs(e.target.value)} rows={2} placeholder="Observaciones (opcional)"
        className="mt-3 w-full rounded-xl border border-slate-300 px-3 py-2 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-[#002855]" />
    </section>

    {enFalla.length > 0 && <div className="flex items-start gap-2 rounded-xl bg-amber-50 p-3 text-sm text-amber-900"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />{enFalla.length} punto(s) en falla se reportarán a Mantenimiento.</div>}
    <button type="button" disabled={saving} onClick={() => void guardar()}
      className="flex w-full items-center justify-center gap-2 rounded-2xl bg-[#f8c400] py-4 text-base font-black text-[#002855] shadow-md disabled:opacity-60">
      {saving && <Loader2 className="h-5 w-5 animate-spin" />}Registrar
    </button>
  </div>

  return <div className="mx-auto max-w-lg space-y-4 p-4 pb-8">
    <div><h1 className="text-xl font-black text-[#002855]">Equipos</h1><p className="text-sm text-slate-500">Horómetro al iniciar el turno y checklist del equipo.</p></div>
    {equipos.length === 0 ? <div className="rounded-2xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">No hay equipos registrados.</div> :
      <ul className="space-y-2">{equipos.map(e => <li key={e.vehicle_id}>
        <button type="button" onClick={() => abrir(e)} className="flex w-full items-center gap-3 rounded-2xl border border-slate-200 bg-white p-4 text-left shadow-sm">
          <span className="rounded-xl bg-blue-50 p-2.5 text-[#002855]"><Forklift className="h-6 w-6" /></span>
          <span className="min-w-0 flex-1">
            <b className="block text-[#002855]">{e.plate}</b>
            <small className="block truncate text-slate-500">{e.modelo}{e.horas != null ? ` · ${e.horas} h` : ''}</small>
            <small className="block text-slate-400">Último registro: {hace(e.ultimo_turno)}</small>
          </span>
          {e.semanal_pendiente && <span className="rounded-full bg-amber-100 px-2 py-1 text-[10px] font-bold text-amber-800">Semanal pendiente</span>}
        </button>
      </li>)}</ul>}
  </div>
}
