'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import { MapPin, Plus, RefreshCw } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

type Loc = { code: string; label: string; zone: string | null; active: boolean }
const field = 'mt-1 w-full rounded-lg border px-3 py-2.5 font-normal'

/** Ubicaciones del almacén (código, nombre, zona). Un traslado entre ubicaciones no cambia la existencia. */
export default function LocationsPage() {
  const [rows, setRows] = useState<Loc[]>([]), [form, setForm] = useState({ code: '', label: '', zone: '' })
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const load = useCallback(async () => { const { data, error } = await createClient().from('wh_locations').select('code,label,zone,active').order('code'); if (error) setError(error.message); else setRows((data || []) as Loc[]) }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])
  const save = async (l: { code: string; label: string; zone: string; active: boolean }, text: string) => {
    setBusy(true); setError(''); setNotice('')
    const { error } = await createClient().rpc('wh_location_save', { p_code: l.code, p_label: l.label, p_zone: l.zone || null, p_active: l.active })
    if (error) setError(error.message); else { setNotice(text); await load() }
    setBusy(false); return !error
  }
  const submit = async (e: FormEvent) => { e.preventDefault(); if (await save({ ...form, active: true }, `Ubicación ${form.code.toUpperCase()} guardada.`)) setForm({ code: '', label: '', zone: '' }) }
  return <div className="w-full space-y-5">
    <header className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-widest text-blue-700">Maestros · Inventario</p>
      <h1 className="mt-1 text-3xl font-black text-[#002855]">Ubicaciones</h1><p className="mt-1 text-sm text-slate-600">Código de la ubicación física (rack, zona de piso, cuarentena). Se usa al trasladar o ubicar paquetes.</p></div>
      <button onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm font-semibold"><RefreshCw size={16}/>Actualizar</button></header>
    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}{notice && <p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">{notice}</p>}
    <form onSubmit={submit} className="grid gap-3 rounded-xl border bg-white p-5 sm:grid-cols-[1fr_1.6fr_1fr_auto] sm:items-end">
      <label className="text-sm font-semibold">Código<input required maxLength={30} value={form.code} onChange={e => setForm({ ...form, code: e.target.value })} placeholder="A-01-02" className={field}/></label>
      <label className="text-sm font-semibold">Nombre<input maxLength={80} value={form.label} onChange={e => setForm({ ...form, label: e.target.value })} placeholder="Rack A, nivel 1, posición 2" className={field}/></label>
      <label className="text-sm font-semibold">Zona<input maxLength={30} value={form.zone} onChange={e => setForm({ ...form, zone: e.target.value })} placeholder="RACK A" className={field}/></label>
      <button disabled={busy} className="inline-flex items-center justify-center gap-2 rounded-lg bg-[#002855] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50"><Plus size={16}/>Guardar</button></form>
    <section className="overflow-hidden rounded-xl border bg-white"><header className="flex items-center gap-2 border-b p-4"><MapPin size={18} className="text-blue-700"/><h2 className="font-bold text-[#002855]">Ubicaciones · {rows.length}</h2></header>
      {rows.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">No hay ubicaciones. Sin ellas, los paquetes figuran «sin ubicación».</p>
        : <div className="divide-y">{rows.map(r => <article key={r.code} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3"><div><b className="font-mono text-[#002855]">{r.code}</b><span className="ml-2">{r.label}</span>{r.zone && <small className="ml-2 rounded bg-slate-100 px-2 text-slate-600">{r.zone}</small>}{!r.active && <small className="ml-2 rounded bg-slate-100 px-2 text-slate-600">Inactiva</small>}</div>
          <button disabled={busy} onClick={() => void save({ code: r.code, label: r.label, zone: r.zone || '', active: !r.active }, r.active ? `${r.code} desactivada.` : `${r.code} activada.`)} className="rounded-lg border px-3 py-2 text-xs font-semibold">{r.active ? 'Desactivar' : 'Activar'}</button></article>)}</div>}</section>
  </div>
}
