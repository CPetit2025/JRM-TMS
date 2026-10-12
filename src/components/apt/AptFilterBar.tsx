'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Filter, RotateCcw, Save, SlidersHorizontal, X } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { aptApi, cleanFilters } from '@/lib/apt/api'
import { FLOW_ALMACENES, flowNodeLabel } from '@/lib/apt/flowColors'
import { ALERTA_LABEL, fmtDate, fmtTn, TIPO_LABEL } from '@/lib/apt/format'
import { useAptFilters } from '@/lib/apt/useAptFilters'
import type { AptEstado, AptFilterOptions, AptFilters, AptTipoLote } from '@/lib/apt/types'

// Todos los filtros avanzados se aplican juntos. Las vistas personales se guardan por identidad autenticada.

const TEXT_FIELDS: Array<{ key: 'producto' | 'glosa' | 'numrel_op' | 'ipt' | 'cliente'; label: string; placeholder: string }> = [
  { key: 'producto', label: 'Producto', placeholder: 'RAPO.20…' },
  { key: 'glosa', label: 'Glosa', placeholder: 'POSTE, VIGA…' },
  { key: 'numrel_op', label: 'NumRel OP', placeholder: '16325-S002-033' },
  { key: 'ipt', label: 'IPT', placeholder: '003-085…' },
  { key: 'cliente', label: 'Cliente (contiene)', placeholder: 'Razón social' },
]

export function MultiSelect({ label, options, value, onChange, render, searchable = false, width = 'w-64' }: {
  label: string; options: string[]; value: string[] | undefined; onChange: (v: string[]) => void
  render?: (o: string) => React.ReactNode; searchable?: boolean; width?: string
}) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const ref = useRef<HTMLDivElement>(null)
  const sel = useMemo(() => new Set(value || []), [value])
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  const shown = q ? options.filter(o => o.toLowerCase().includes(q.toLowerCase())) : options
  const toggle = (o: string) => {
    const next = new Set(sel)
    if (next.has(o)) next.delete(o)
    else next.add(o)
    onChange(options.filter(x => next.has(x)))
  }
  return (
    <div ref={ref} className="relative">
      <button type="button" aria-expanded={open} aria-label={label} onClick={() => setOpen(o => !o)}
        className={`flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors ${
          sel.size ? 'border-[#002855] bg-[#002855]/5 text-[#002855]' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}>
        {label}
        {sel.size > 0 && <span className="rounded-full bg-[#002855] px-1.5 text-[10px] text-white">{sel.size}</span>}
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </button>
      {open && (
        <div className={`absolute left-0 top-10 z-40 max-w-[calc(100vw-3rem)] ${width} rounded-xl border border-slate-200 bg-white p-2 shadow-xl`}>
          {searchable && (
            <input autoFocus value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar…"
              className="mb-2 h-8 w-full rounded-md border border-slate-200 px-2 text-xs outline-none focus:border-[#002855]" />
          )}
          <div className="max-h-64 overflow-y-auto">
            {shown.length === 0 && <p className="p-2 text-xs text-slate-400">Sin opciones</p>}
            {shown.map(o => (
              <button key={o} type="button" onClick={() => toggle(o)}
                className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-slate-50">
                <span className={`flex h-4 w-4 shrink-0 items-center justify-center rounded border ${sel.has(o) ? 'border-[#002855] bg-[#002855] text-white' : 'border-slate-300'}`}>
                  {sel.has(o) && <Check className="h-3 w-3" />}
                </span>
                <span className="min-w-0 flex-1 truncate">{render ? render(o) : o}</span>
              </button>
            ))}
          </div>
          {sel.size > 0 && (
            <button type="button" onClick={() => onChange([])} className="mt-1 w-full rounded-md py-1 text-[11px] font-semibold text-slate-500 hover:bg-slate-50">
              Limpiar selección
            </button>
          )}
        </div>
      )}
    </div>
  )
}

const CHIP_LABEL: Record<string, string> = {
  lote: 'Lote', lotes: 'Lotes', contrato: 'Contrato', tipos: 'Tipo', numrel_op: 'NumRel OP', producto: 'Producto', glosa: 'Glosa', ipt: 'IPT',
  familias: 'Familia', estados: 'Estado', rangos: 'Aging', docrels: 'DocRel', ingreso_desde: 'Ingreso desde', ingreso_hasta: 'Ingreso hasta',
  entrega_desde: 'FechaEntrega desde', entrega_hasta: 'FechaEntrega hasta', cliente: 'Cliente', solo_saldo: 'Solo con saldo', dias_min: 'Días ≥',
  productos: 'Producto', glosas: 'Glosa', alertas: 'Alertas', clientes: 'Cliente', contratos: 'OT', almacenes: 'Almacén de ingreso',
}

function chipValue(k: string, v: unknown) {
  if (k === 'solo_saldo') return 'Sí'
  if (k.endsWith('_desde') || k.endsWith('_hasta')) return fmtDate(String(v))
  if (k === 'tipos' && Array.isArray(v)) return v.map(t => TIPO_LABEL[t as AptTipoLote] || t).join(', ')
  if (k === 'alertas' && Array.isArray(v)) return v.map(a => ALERTA_LABEL[a] || a).join(', ')
  if (k === 'almacenes' && Array.isArray(v)) return v.map(flowNodeLabel).join(', ')
  return Array.isArray(v) ? v.join(', ') : String(v)
}

type SavedView = { name: string; filters: AptFilters }

export function AptFilterBar() {
  const { filters, setFilters } = useAptFilters()
  const [opts, setOpts] = useState<AptFilterOptions | null>(null)
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState<AptFilters>(filters)
  const [views, setViews] = useState<SavedView[]>([])
  const [owner, setOwner] = useState<string | null>(null)
  const [viewName, setViewName] = useState('')
  const [error, setError] = useState('')
  const dialogRef = useRef<HTMLDialogElement>(null)
  const inputClass = 'mt-1 h-10 w-full rounded-lg border border-slate-200 bg-white px-3 text-sm font-normal text-slate-800 outline-none focus:border-[#002855] focus:ring-2 focus:ring-[#002855]/10'

  useEffect(() => { aptApi.filterOptions().then(setOpts).catch(() => setOpts(null)) }, [])
  useEffect(() => {
    let alive = true
    const client = createClient()
    const load = (id: string | undefined) => {
      if (!alive) return
      setOwner(id || null)
      setViews([])
      if (!id) return
      try {
        const parsed = JSON.parse(localStorage.getItem(`apt:views:v1:${id}`) || '[]')
        if (Array.isArray(parsed)) setViews(parsed.filter(v => typeof v?.name === 'string' && v.filters && typeof v.filters === 'object' && !Array.isArray(v.filters)).slice(0, 12))
      } catch { /* Ignore damaged or unavailable browser storage. */ }
    }
    void client.auth.getUser().then(({ data }) => load(data.user?.id)).catch(() => load(undefined))
    const { data: { subscription } } = client.auth.onAuthStateChange((_event, session) => load(session?.user.id))
    return () => { alive = false; subscription.unsubscribe() }
  }, [])
  useEffect(() => {
    if (open) dialogRef.current?.showModal()
    else dialogRef.current?.close()
  }, [open])

  const active = Object.entries(cleanFilters(filters))
  const edit = () => { setDraft(filters); setError(''); setOpen(true) }
  const patchDraft = (patch: Partial<AptFilters>) => setDraft(current => ({ ...current, ...patch }))
  const apply = () => {
    if ((draft.ingreso_desde && draft.ingreso_hasta && draft.ingreso_desde > draft.ingreso_hasta) ||
      (draft.entrega_desde && draft.entrega_hasta && draft.entrega_desde > draft.entrega_hasta)) {
      setError('La fecha desde debe ser anterior o igual a la fecha hasta.'); return
    }
    setFilters(cleanFilters(draft)); setOpen(false)
  }
  const persist = (next: SavedView[]) => {
    if (!owner) return
    try { localStorage.setItem(`apt:views:v1:${owner}`, JSON.stringify(next)); setViews(next); setError('') }
    catch { setError('El navegador no permite guardar esta vista.') }
  }
  const save = () => {
    const name = viewName.trim().slice(0, 60)
    if (!name) { setError('Escribe un nombre para la vista.'); return }
    if (views.length >= 12 && !views.some(v => v.name === name)) { setError('Puedes guardar hasta 12 vistas personales.'); return }
    persist([...views.filter(v => v.name !== name), { name, filters: cleanFilters(filters) }]); setViewName('')
  }

  return (
    <section className="sticky top-0 z-30 rounded-xl border border-slate-200 bg-white/95 p-3 shadow-sm backdrop-blur" aria-label="Filtros del análisis APT">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-[#002855]" />
          <div><p className="text-xs font-bold text-[#002855]">Contexto del análisis</p><p className="text-[11px] text-slate-500">{active.length ? `${active.length} filtros aplicados` : 'Todos los registros del modelo'}</p></div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {views.length > 0 && <select aria-label="Aplicar vista personal" value="" onChange={e => { const view = views[Number(e.target.value)]; if (view) setFilters(view.filters) }} className="h-10 max-w-48 rounded-lg border border-slate-200 bg-white px-2 text-xs"><option value="">Mis vistas…</option>{views.map((v, i) => <option key={v.name} value={i}>{v.name}</option>)}</select>}
          {active.length > 0 && <button type="button" onClick={() => setFilters({})} className="flex h-10 items-center gap-1 rounded-lg px-2 text-xs text-slate-600 hover:bg-slate-100"><RotateCcw className="h-3.5 w-3.5" /> Limpiar</button>}
          <button type="button" onClick={edit} className="flex h-10 items-center gap-2 rounded-lg bg-[#002855] px-4 text-xs font-bold text-white hover:bg-[#003a7a]"><SlidersHorizontal className="h-4 w-4" /> Filtros y vistas</button>
        </div>
      </div>
      {active.length > 0 && <div className="mt-2 flex max-h-24 flex-wrap gap-1.5 overflow-y-auto">{active.map(([k, v]) => <span key={k} className="inline-flex max-w-full items-center gap-1 rounded-full border border-blue-100 bg-blue-50 py-1 pl-2.5 pr-1 text-[11px] text-[#002855]"><b>{CHIP_LABEL[k] || k}:</b><span className="max-w-48 truncate" title={chipValue(k, v)}>{chipValue(k, v)}</span><button type="button" onClick={() => setFilters({ ...filters, [k]: undefined })} className="rounded-full p-1 hover:bg-blue-100" aria-label={`Quitar ${CHIP_LABEL[k] || k}`}><X className="h-3 w-3" /></button></span>)}</div>}
      <dialog ref={dialogRef} onCancel={() => setOpen(false)} onClose={() => setOpen(false)} aria-labelledby="apt-filter-title" className="fixed inset-0 m-0 h-dvh max-h-dvh w-full max-w-none border-0 bg-white p-0 text-slate-900 backdrop:bg-slate-950/40 sm:inset-y-0 sm:left-auto sm:right-0 sm:w-[560px]">
        <div className="flex h-full flex-col">
          <header className="flex items-center justify-between border-b border-slate-200 px-5 py-4"><div><h2 id="apt-filter-title" className="font-bold text-[#002855]">Filtros del análisis</h2><p className="text-xs text-slate-500">Selecciona el alcance y aplica todos los cambios juntos.</p></div><button type="button" aria-label="Cerrar filtros" onClick={() => setOpen(false)} className="rounded-lg p-2 hover:bg-slate-100"><X className="h-5 w-5" /></button></header>
          <div className="flex-1 space-y-6 overflow-y-auto p-5">
            <section className="space-y-3"><h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">OT y material</h3>
              <label className="block text-xs font-semibold">Lote / NumRel<input list="apt-lotes" value={draft.lote || ''} onChange={e => patchDraft({ lote: e.target.value })} placeholder="Ej. 16325-S002" className={inputClass} /><datalist id="apt-lotes">{(opts?.lotes || []).slice(0, 2000).map(l => <option key={l.lote} value={l.lote}>{`${TIPO_LABEL[l.tipo]} · ${fmtTn(l.tn_saldo)} TN`}</option>)}</datalist></label>
              <label className="block text-xs font-semibold">OT madre<select value={draft.contrato || ''} onChange={e => patchDraft({ contrato: e.target.value || undefined })} className={inputClass}><option value="">Todas las OT</option>{(opts?.contratos || []).map(c => <option key={c} value={c}>{c}</option>)}</select></label>
              <div className="flex flex-wrap gap-2"><MultiSelect label="Tipo" options={['CONTRATO', 'SUBCONTRATO', 'ERROR', 'GARANTIA']} value={draft.tipos} onChange={v => patchDraft({ tipos: v as AptTipoLote[] })} render={o => TIPO_LABEL[o as AptTipoLote]} /><MultiSelect label="Familia" options={(opts?.familias || []).map(f => f.familia)} value={draft.familias} searchable onChange={v => patchDraft({ familias: v })} /><MultiSelect label="Cliente" options={(opts?.clientes || []).map(c => c.cliente)} value={draft.clientes} searchable onChange={v => patchDraft({ clientes: v })} /></div>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">{TEXT_FIELDS.map(t => <label key={t.key} className="text-xs font-semibold">{t.label}<input value={draft[t.key] || ''} onChange={e => patchDraft({ [t.key]: e.target.value })} placeholder={t.placeholder} className={inputClass} /></label>)}</div>
            </section>
            <section className="space-y-3"><h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Saldo y permanencia</h3><p className="text-xs text-slate-500">Almacén del ingreso original. Para la ubicación después de traspasos consulta Flujo multi-almacén.</p><div className="flex flex-wrap gap-2"><MultiSelect label="Almacén de ingreso" options={FLOW_ALMACENES} value={draft.almacenes} onChange={v => patchDraft({ almacenes: v as AptFilters['almacenes'] })} render={flowNodeLabel} /><MultiSelect label="Estado" options={opts?.estados || ['En APT', 'Salida parcial', 'Despachado', 'Sin salida identificada', 'Problema de información']} value={draft.estados} onChange={v => patchDraft({ estados: v as AptEstado[] })} /><MultiSelect label="Antigüedad" options={opts?.rangos || []} value={draft.rangos} onChange={v => patchDraft({ rangos: v })} /><MultiSelect label="Alertas" options={['problema_info', 'posible_cruce']} value={draft.alertas} onChange={v => patchDraft({ alertas: v as AptFilters['alertas'] })} render={o => ALERTA_LABEL[o]} /><MultiSelect label="DocRel" options={opts?.docrels || []} value={draft.docrels} onChange={v => patchDraft({ docrels: v })} /></div><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!draft.solo_saldo} onChange={e => patchDraft({ solo_saldo: e.target.checked || undefined })} /> Solo material con saldo</label><label className="block text-xs font-semibold">Antigüedad mínima (días)<input type="number" min={0} value={draft.dias_min ?? ''} onChange={e => patchDraft({ dias_min: e.target.value === '' ? undefined : Math.max(0, Number(e.target.value)) })} className={inputClass} /></label></section>
            <section className="space-y-3"><h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Fechas de los registros</h3><p className="text-xs leading-relaxed text-slate-500">Estas fechas seleccionan ingresos o FechaEntrega del ERP. El corte del inventario se muestra en el encabezado y se administra en Cargas y parámetros; no cambia al filtrar.</p><div className="grid grid-cols-2 gap-3">{([['ingreso_desde', 'Ingreso desde'], ['ingreso_hasta', 'Ingreso hasta'], ['entrega_desde', 'FechaEntrega desde'], ['entrega_hasta', 'FechaEntrega hasta']] as const).map(([key, label]) => <label key={key} className="text-xs font-semibold">{label}<input type="date" value={draft[key] || ''} onChange={e => patchDraft({ [key]: e.target.value || undefined })} className={inputClass} /></label>)}</div></section>
            {owner && <section className="space-y-3 border-t border-slate-200 pt-4"><h3 className="text-xs font-bold uppercase tracking-wide text-slate-500">Vistas personales en este navegador</h3><p className="text-xs text-slate-500">Guarda los filtros actualmente aplicados. Cada usuario tiene sus propias vistas.</p><div className="flex gap-2"><input aria-label="Nombre de vista" maxLength={60} value={viewName} onChange={e => setViewName(e.target.value)} placeholder="Ej. Saldo OT Lima" className="h-10 min-w-0 flex-1 rounded-lg border border-slate-200 px-3 text-sm" /><button type="button" onClick={save} className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 text-xs font-semibold"><Save className="h-4 w-4" /> Guardar</button></div>{views.map(v => <div key={v.name} className="flex items-center justify-between gap-2 text-xs"><button type="button" onClick={() => { setDraft(v.filters); setError('') }} className="truncate font-semibold text-[#002855]">{v.name}</button><button type="button" aria-label={`Eliminar vista ${v.name}`} onClick={() => persist(views.filter(view => view.name !== v.name))} className="p-2 text-slate-500"><X className="h-3.5 w-3.5" /></button></div>)}</section>}
          </div>
          <footer className="border-t border-slate-200 bg-white p-4">{error && <p role="alert" className="mb-2 text-xs text-red-700">{error}</p>}<div className="flex gap-2"><button type="button" onClick={() => { setDraft({}); setError('') }} className="h-11 rounded-lg border border-slate-200 px-4 text-sm">Restablecer</button><button type="button" onClick={apply} className="h-11 flex-1 rounded-lg bg-[#002855] px-4 text-sm font-bold text-white">Aplicar filtros</button></div></footer>
        </div>
      </dialog>
    </section>
  )
}
