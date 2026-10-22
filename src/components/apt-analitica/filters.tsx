'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Bookmark, RefreshCw, RotateCcw, Save, Search, Trash2 } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { comercialRef, ordenRef } from '@/lib/apt-analitica/catalog'
import { AREA_LABEL, EMPTY_FILTERS, type Area, type Filters } from '@/lib/apt-analitica/types'
import { hasDimensionFilters } from '@/lib/apt-analitica/engine'
import { useAnalitica, type Tab } from './context'
import { MultiSelect, fmtDate, fmtDateTime } from './ui'

// Filtros globales: actualizan tarjetas, tablas y gráficos de todas las pestañas. Se guardan en la URL y como vistas.

const uniq = (xs: Array<string | null | undefined>) => [...new Set(xs.filter((x): x is string => !!x))].sort((a, b) => a.localeCompare(b, 'es'))

export function FiltersBar() {
  const { base, filters, setFilters, analysis, meta, reload, tab, setTab } = useAnalitica()
  const [text, setText] = useState(filters.text)
  const [more, setMore] = useState(false)
  useEffect(() => { const t = window.setTimeout(() => setText(filters.text), 0); return () => window.clearTimeout(t) }, [filters.text])
  useEffect(() => {
    if (text === filters.text) return
    const t = window.setTimeout(() => setFilters({ ...filters, text }), 350)
    return () => window.clearTimeout(t)
  }, [text, filters, setFilters])
  const opts = useMemo(() => {
    const a = base.accepted
    return {
      bodegas: uniq(a.map(m => m.bodega)), clientes: uniq(a.map(m => m.razonSocial)), productos: uniq(a.map(m => m.producto)),
      unidades: base.units, lotes: uniq(a.map(m => m.lote)), otop: uniq(a.map(m => ordenRef(m))),
      contratos: uniq([...a.map(m => m.contrato), ...a.map(m => comercialRef(m))]), documentos: uniq(a.map(m => m.numero)),
    }
  }, [base])
  const glosa = useMemo(() => new Map(base.accepted.map(m => [m.producto, m.glosa ?? ''])), [base])
  const set = (p: Partial<Filters>) => setFilters({ ...filters, ...p })
  const active = hasDimensionFilters(filters) || filters.from || filters.to || filters.unidad
  const dimCount = [filters.areas, filters.bodegas, filters.clientes, filters.productos, filters.lotes, filters.otop, filters.contratos, filters.documentos].filter(x => x.length).length
  return (
    <section aria-label="Filtros globales" className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-end gap-2">
        <label className="min-w-[12rem] flex-1">
          <span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wide text-slate-500">Buscador global</span>
          <span className="flex h-9 items-center gap-1 rounded-lg border border-slate-300 px-2"><Search className="h-4 w-4 text-slate-400" aria-hidden />
            <input value={text} onChange={e => setText(e.target.value)} placeholder="Documento, producto, glosa, lote, OT/OP, contrato, cliente…"
              aria-label="Buscador global" className="min-w-0 flex-1 text-xs outline-none" /></span>
        </label>
        <label><span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wide text-slate-500">Desde</span>
          <input type="date" value={filters.from ?? ''} min={base.minDate ?? undefined} max={base.maxDate ?? undefined} onChange={e => set({ from: e.target.value || null })}
            className="h-9 rounded-lg border border-slate-300 px-2 text-xs" /></label>
        <label><span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wide text-slate-500">Hasta</span>
          <input type="date" value={filters.to ?? ''} min={base.minDate ?? undefined} max={base.maxDate ?? undefined} onChange={e => set({ to: e.target.value || null })}
            className="h-9 rounded-lg border border-slate-300 px-2 text-xs" /></label>
        <label><span className="mb-0.5 block text-[10px] font-bold uppercase tracking-wide text-slate-500">Unidad</span>
          <select value={filters.unidad ?? ''} onChange={e => set({ unidad: e.target.value || null })} className="h-9 rounded-lg border border-slate-300 bg-white px-2 text-xs">
            <option value="">Por separado ({analysis.unit ?? '—'} en gráficos)</option>
            {opts.unidades.map(u => <option key={u} value={u}>{u}</option>)}
          </select></label>
        <div className="flex gap-1">
          {active && <button type="button" onClick={() => setFilters(EMPTY_FILTERS)} className="flex h-9 items-center gap-1 rounded-lg border border-slate-300 px-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            <RotateCcw className="h-3.5 w-3.5" aria-hidden />Limpiar</button>}
          <SavedViews tab={tab} filters={filters} apply={(f, t) => { setFilters(f); if (t) setTab(t) }} />
          <button type="button" onClick={() => void reload()} title="Volver a leer los datos" className="flex h-9 items-center gap-1 rounded-lg border border-slate-300 px-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
            <RefreshCw className="h-3.5 w-3.5" aria-hidden />Actualizar</button>
        </div>
      </div>
      <button type="button" onClick={() => setMore(m => !m)} aria-expanded={more} className="mt-2 text-xs font-semibold text-[#002855] lg:hidden">
        {more ? 'Ocultar filtros' : `Más filtros${dimCount ? ` (${dimCount} activos)` : ''}`}</button>
      <div className={`mt-2 ${more ? 'grid' : 'hidden'} grid-cols-2 gap-2 sm:grid-cols-3 lg:grid lg:grid-cols-5 xl:grid-cols-9`}>
        <MultiSelect label="Área" options={['APT', 'APT_LB', 'DIST']} value={filters.areas} onChange={v => set({ areas: v as Area[] })} render={v => AREA_LABEL[v as Area]} />
        <MultiSelect label="Bodega" options={opts.bodegas} value={filters.bodegas} onChange={v => set({ bodegas: v })} />
        <MultiSelect label="Cliente" options={opts.clientes} value={filters.clientes} onChange={v => set({ clientes: v })} />
        <MultiSelect label="Producto" options={opts.productos} value={filters.productos} onChange={v => set({ productos: v })} render={p => glosa.get(p) ? `${p} · ${glosa.get(p)}` : p} />
        <MultiSelect label="Lote" options={opts.lotes} value={filters.lotes} onChange={v => set({ lotes: v })} />
        <MultiSelect label="OT / OP" options={opts.otop} value={filters.otop} onChange={v => set({ otop: v })} />
        <MultiSelect label="Contrato / pedido" options={opts.contratos} value={filters.contratos} onChange={v => set({ contratos: v })} />
        <MultiSelect label="Documento" options={opts.documentos} value={filters.documentos} onChange={v => set({ documentos: v })} />
        <div className="col-span-2 flex flex-col justify-end text-[11px] leading-tight text-slate-600 sm:col-span-1">
          <span>Corte: <b className="text-slate-800">{fmtDate(analysis.cutoff)}</b></span>
          <span>Actualizado: <b className="text-slate-800">{fmtDateTime(meta?.last_change_at ?? meta?.last_import_at)}</b></span>
        </div>
      </div>
    </section>
  )
}

interface SavedView { id: string; name: string; state: { filters: Filters; tab?: Tab }; shared: boolean; mine: boolean }

function SavedViews({ tab, filters, apply }: { tab: Tab; filters: Filters; apply: (f: Filters, t?: Tab) => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [open, setOpen] = useState(false)
  const [views, setViews] = useState<SavedView[]>([])
  const [name, setName] = useState('')
  const [shared, setShared] = useState(false)
  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('apa_views_list')
    if (!error) setViews((data ?? []) as SavedView[])
  }, [supabase])
  useEffect(() => { if (open) { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) } }, [open, load])
  const save = async () => {
    const { error } = await supabase.rpc('apa_view_save', { p_name: name, p_state: { filters, tab }, p_shared: shared })
    if (error) { toast.error(error.message); return }
    toast.success('Vista guardada'); setName(''); void load()
  }
  const del = async (id: string) => { await supabase.rpc('apa_view_delete', { p_id: id }); void load() }
  return (
    <div className="relative">
      <button type="button" aria-expanded={open} onClick={() => setOpen(o => !o)} className="flex h-9 items-center gap-1 rounded-lg border border-slate-300 px-2 text-xs font-semibold text-slate-700 hover:bg-slate-50">
        <Bookmark className="h-3.5 w-3.5" aria-hidden />Vistas</button>
      {open && <div className="absolute right-0 z-40 mt-1 w-80 max-w-[90vw] rounded-lg border border-slate-200 bg-white p-3 text-xs shadow-xl">
        <p className="font-bold text-slate-800">Vistas guardadas</p>
        <ul className="mt-1 max-h-56 space-y-1 overflow-y-auto">
          {views.length === 0 && <li className="text-slate-500">Aún no hay vistas.</li>}
          {views.map(v => <li key={v.id} className="flex items-center justify-between gap-2 rounded px-1 py-1 hover:bg-slate-50">
            <button type="button" className="min-w-0 flex-1 truncate text-left font-semibold text-[#002855]" onClick={() => { apply({ ...EMPTY_FILTERS, ...v.state.filters }, v.state.tab); setOpen(false) }}>
              {v.name}{v.shared && <span className="ml-1 font-normal text-slate-500">(compartida)</span>}</button>
            {v.mine && <button type="button" aria-label={`Eliminar vista ${v.name}`} onClick={() => void del(v.id)}><Trash2 className="h-3.5 w-3.5 text-slate-500" /></button>}
          </li>)}
        </ul>
        <div className="mt-2 border-t border-slate-100 pt-2">
          <input value={name} onChange={e => setName(e.target.value)} placeholder="Nombre de la vista actual" aria-label="Nombre de la vista" className="h-8 w-full rounded border border-slate-300 px-2" />
          <label className="mt-1 flex items-center gap-1"><input type="checkbox" checked={shared} onChange={e => setShared(e.target.checked)} />Compartir con el equipo</label>
          <button type="button" disabled={!name.trim()} onClick={() => void save()} className="mt-2 flex h-8 items-center gap-1 rounded bg-[#002855] px-3 font-semibold text-white disabled:opacity-50">
            <Save className="h-3.5 w-3.5" aria-hidden />Guardar filtros y pestaña</button>
        </div>
      </div>}
    </div>
  )
}
