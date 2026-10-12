'use client'

import { useEffect, useRef, useState } from 'react'
import { Filter, Save, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { aptApi, cleanFilters } from '@/lib/apt/api'
import { fmtDate } from '@/lib/apt/format'
import { FLOW_ALMACENES, flowNodeLabel } from '@/lib/apt/flowColors'
import type { AptOperationalFilters, AptFilterOptions } from '@/lib/apt/types'
import { MultiSelect } from './AptFilterBar'

type View = { name: string; filters: AptOperationalFilters }
const labels: Record<string, string> = { desde: 'Movimientos desde', hasta: 'Movimientos hasta', cutoff: 'Corte', almacen: 'Ubicación', ot: 'OT madre', lote: 'Lote', clientes: 'Cliente' }
const valueLabel = (key: string, value: unknown) => key === 'almacen' ? flowNodeLabel(String(value)) : ['desde', 'hasta', 'cutoff'].includes(key) ? fmtDate(String(value)) : Array.isArray(value) ? value.join(', ') : String(value)

export function OperationalFilterBar({ filters, onApply, cutoffLabel }: { filters: AptOperationalFilters; onApply: (filters: AptOperationalFilters) => void; cutoffLabel?: string | null }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState(filters)
  const [opts, setOpts] = useState<AptFilterOptions | null>(null)
  const [owner, setOwner] = useState<string | null>(null)
  const [views, setViews] = useState<View[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const input = 'mt-1 h-11 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm outline-none focus:border-[#002855] focus:ring-2 focus:ring-blue-100'
  useEffect(() => { aptApi.filterOptions().then(setOpts).catch(() => setOpts(null)) }, [])
  useEffect(() => {
    let alive = true
    const client = createClient()
    const load = (id?: string) => {
      if (!alive) return
      setOwner(id || null); setViews([])
      if (id) try {
        const stored = JSON.parse(localStorage.getItem(`apt:operational-views:v1:${id}`) || '[]')
        if (Array.isArray(stored)) setViews(stored.filter(v => typeof v?.name === 'string' && v.filters && typeof v.filters === 'object' && !Array.isArray(v.filters)).slice(0, 12))
      } catch { /* Storage may be disabled. */ }
    }
    void client.auth.getUser().then(({ data }) => load(data.user?.id)).catch(() => load())
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => load(session?.user.id))
    return () => { alive = false; subscription.unsubscribe() }
  }, [])
  useEffect(() => { if (open) dialog.current?.showModal(); else dialog.current?.close() }, [open])
  const persist = (next: View[]) => {
    if (!owner) return
    try { localStorage.setItem(`apt:operational-views:v1:${owner}`, JSON.stringify(next)); setViews(next) }
    catch { setError('El navegador no permite guardar la vista.'); return }
    setError('')
  }
  const save = () => {
    const title = name.trim().slice(0, 60)
    if (!title) { setError('Escribe un nombre para guardar la vista.'); return }
    if (views.length >= 12 && !views.some(v => v.name === title)) { setError('Puedes guardar hasta 12 vistas personales.'); return }
    persist([...views.filter(v => v.name !== title), { name: title, filters: cleanFilters(filters) }]); setName('')
  }
  const apply = () => {
    if (draft.desde && draft.hasta && draft.desde > draft.hasta) { setError('La fecha desde no puede superar la fecha hasta.'); return }
    if (draft.cutoff && ((draft.hasta && draft.hasta > draft.cutoff) || (draft.desde && draft.desde > draft.cutoff))) { setError('El período de movimientos no puede superar el corte del inventario.'); return }
    const effectiveEnd = draft.hasta || draft.cutoff || cutoffLabel
    if (draft.desde && effectiveEnd) {
      const days = (Date.parse(effectiveEnd) - Date.parse(draft.desde)) / 86400000 + 1
      if (days < 1 || days > 366) { setError('Selecciona un período entre 1 y 366 días, sin superar el corte.'); return }
    }
    onApply(cleanFilters(draft)); setOpen(false)
  }
  const active = Object.entries(cleanFilters(filters))
  return <section aria-label="Filtros operativos APT" className="sticky top-0 z-30 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-sm backdrop-blur">
    <div className="flex flex-wrap items-center justify-between gap-2"><div><p className="flex items-center gap-2 text-xs font-bold text-[#002855]"><Filter className="h-4 w-4" /> Contexto del análisis</p><p className="mt-1 text-[11px] text-slate-500">Corte: {fmtDate(cutoffLabel || filters.cutoff)} · {active.length ? `${active.length} filtros aplicados` : 'Alcance general'}</p></div><div className="flex flex-wrap gap-2">{views.length > 0 && <select aria-label="Aplicar vista personal" value="" onChange={e => { const view = views[Number(e.target.value)]; if (view) onApply(view.filters) }} className="h-10 max-w-48 rounded-lg border border-slate-200 bg-white px-2 text-xs"><option value="">Mis vistas…</option>{views.map((v, i) => <option value={i} key={v.name}>{v.name}</option>)}</select>}{active.length > 0 && <button type="button" onClick={() => onApply({})} className="rounded-lg px-3 text-xs text-slate-600 hover:bg-slate-100">Limpiar</button>}<button type="button" onClick={() => { setDraft(filters); setError(''); setOpen(true) }} className="h-10 rounded-lg bg-[#002855] px-4 text-xs font-bold text-white">Filtros y vistas</button></div></div>
    {active.length > 0 && <div className="mt-2 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">{active.map(([key, value]) => <span key={key} className="inline-flex max-w-full items-center gap-1 rounded-full bg-blue-50 py-1 pl-2.5 pr-1 text-[11px] text-[#002855]"><b>{labels[key] || key}:</b><span className="max-w-48 truncate" title={valueLabel(key, value)}>{valueLabel(key, value)}</span><button type="button" aria-label={`Quitar ${labels[key] || key}`} onClick={() => onApply({ ...filters, [key]: undefined })} className="rounded-full p-1 hover:bg-blue-100"><X className="h-3 w-3" /></button></span>)}</div>}
    <dialog ref={dialog} onCancel={() => setOpen(false)} onClose={() => setOpen(false)} aria-labelledby="apt-operational-filter-title" className="fixed inset-0 m-0 h-dvh max-h-dvh w-full max-w-none border-0 bg-white p-0 text-slate-900 backdrop:bg-slate-950/40 sm:left-auto sm:right-0 sm:w-[520px]">
      <div className="flex h-full flex-col"><header className="flex items-center justify-between border-b p-5"><div><h2 id="apt-operational-filter-title" className="font-bold text-[#002855]">Alcance del análisis</h2><p className="text-xs text-slate-500">Aplica todos los filtros en una sola consulta.</p></div><button type="button" aria-label="Cerrar filtros" onClick={() => setOpen(false)} className="p-2"><X className="h-5 w-5" /></button></header><div className="flex-1 space-y-6 overflow-y-auto p-5">
      <section className="space-y-3"><h3 className="text-xs font-bold uppercase text-slate-500">Inventario al corte</h3><label className="block text-xs font-semibold">Fecha de corte<input type="date" value={draft.cutoff || ''} onChange={e => setDraft(d => ({ ...d, cutoff: e.target.value || undefined }))} className={input} /></label><p className="text-xs text-slate-500">Sin fecha, se utiliza el corte documental del modelo. Un corte histórico no modifica los datos cargados.</p><label className="block text-xs font-semibold">Ubicación del saldo<select value={draft.almacen || ''} onChange={e => setDraft(d => ({ ...d, almacen: (e.target.value || undefined) as AptOperationalFilters['almacen'] }))} className={input}><option value="">Todos los almacenes</option>{FLOW_ALMACENES.map(a => <option value={a} key={a}>{flowNodeLabel(a)}</option>)}</select></label></section>
      <section className="space-y-3"><h3 className="text-xs font-bold uppercase text-slate-500">Período de movimientos</h3><div className="flex flex-wrap gap-2">{[30, 90].map(days => <button type="button" key={days} onClick={() => { const end = draft.cutoff || cutoffLabel; if (!end) { setError('Espera a que cargue el corte o selecciona una fecha de corte.'); return } const start = new Date(`${end}T00:00:00Z`); start.setUTCDate(start.getUTCDate() - days + 1); setDraft(d => ({ ...d, desde: start.toISOString().slice(0, 10), hasta: end })); setError('') }} className="rounded-lg border border-slate-200 px-3 py-2 text-xs">Últimos {days} días al corte</button>)}</div><div className="grid grid-cols-2 gap-3">{(['desde', 'hasta'] as const).map(key => <label key={key} className="text-xs font-semibold">{key === 'desde' ? 'Desde' : 'Hasta'}<input type="date" value={draft[key] || ''} onChange={e => setDraft(d => ({ ...d, [key]: e.target.value || undefined }))} className={input} /></label>)}</div><p className="text-xs leading-relaxed text-slate-500">El período filtra producción, salidas y consumo; el saldo se calcula al corte con su historial previo. La consulta admite hasta 366 días.</p></section>
      <section className="space-y-3"><h3 className="text-xs font-bold uppercase text-slate-500">OT, material y cliente</h3><label className="block text-xs font-semibold">OT madre<input value={draft.ot || ''} onChange={e => setDraft(d => ({ ...d, ot: e.target.value.trim() || undefined }))} placeholder="Ej. 16339" className={input} /></label><label className="block text-xs font-semibold">Lote / variante<input value={draft.lote || ''} onChange={e => setDraft(d => ({ ...d, lote: e.target.value.trim() || undefined }))} placeholder="Ej. 16339-E014" className={input} /></label><MultiSelect label="Cliente" options={(opts?.clientes || []).map(c => c.cliente)} value={draft.clientes} searchable onChange={clientes => setDraft(d => ({ ...d, clientes }))} /></section>
      {owner && <section className="space-y-3 border-t pt-4"><h3 className="text-xs font-bold uppercase text-slate-500">Vistas personales</h3><p className="text-xs text-slate-500">Guarda los filtros aplicados en este navegador, disponibles solo para tu usuario.</p><div className="flex gap-2"><input aria-label="Nombre de vista" maxLength={60} value={name} onChange={e => setName(e.target.value)} className="h-10 min-w-0 flex-1 rounded-lg border px-3 text-sm" placeholder="Nombre de vista" /><button type="button" onClick={save} className="flex items-center gap-1 rounded-lg border px-3 text-xs"><Save className="h-4 w-4" /> Guardar</button></div>{views.map(v => <div key={v.name} className="flex items-center justify-between text-xs"><button type="button" onClick={() => setDraft(v.filters)} className="truncate font-semibold text-[#002855]">{v.name}</button><button type="button" aria-label={`Eliminar vista ${v.name}`} onClick={() => persist(views.filter(other => other.name !== v.name))} className="p-2"><X className="h-3.5 w-3.5" /></button></div>)}</section>}
      </div><footer className="border-t p-4">{error && <p role="alert" className="mb-2 text-xs text-red-700">{error}</p>}<div className="flex gap-2"><button type="button" onClick={() => { setDraft({}); setError('') }} className="h-11 rounded-lg border px-4 text-sm">Restablecer</button><button type="button" onClick={apply} className="h-11 flex-1 rounded-lg bg-[#002855] text-sm font-bold text-white">Aplicar filtros</button></div></footer></div>
    </dialog>
  </section>
}
