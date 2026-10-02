'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Check, ChevronDown, Filter, RotateCcw, Search, SlidersHorizontal, X } from 'lucide-react'
import { aptApi } from '@/lib/apt/api'
import { fmtDate, fmtTn, TIPO_LABEL } from '@/lib/apt/format'
import { useAptFilters } from '@/lib/apt/useAptFilters'
import type { AptEstado, AptFilterOptions, AptFilters, AptTipoLote } from '@/lib/apt/types'

// Segmentadores del módulo APT. Los selectores aplican al instante; los campos de texto al presionar Enter o "Aplicar".

const TEXT_FIELDS: Array<{ key: 'producto' | 'glosa' | 'numrel_op' | 'ipt' | 'cliente'; label: string; placeholder: string }> = [
  { key: 'producto', label: 'Producto', placeholder: 'RAPO.20…' },
  { key: 'glosa', label: 'Glosa', placeholder: 'POSTE, VIGA…' },
  { key: 'numrel_op', label: 'NumRel OP', placeholder: '16325-S002-033' },
  { key: 'ipt', label: 'IPT', placeholder: '003-085…' },
  { key: 'cliente', label: 'Cliente (despachos)', placeholder: 'Razón social' },
]

function MultiSelect({ label, options, value, onChange, render, searchable = false, width = 'w-64' }: {
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
      <button type="button" onClick={() => setOpen(o => !o)}
        className={`flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold transition-colors ${
          sel.size ? 'border-[#002855] bg-[#002855]/5 text-[#002855]' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}>
        {label}
        {sel.size > 0 && <span className="rounded-full bg-[#002855] px-1.5 text-[10px] text-white">{sel.size}</span>}
        <ChevronDown className="h-3.5 w-3.5 opacity-60" />
      </button>
      {open && (
        <div className={`absolute left-0 top-10 z-40 ${width} rounded-xl border border-slate-200 bg-white p-2 shadow-xl`}>
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
}

function chipValue(k: string, v: unknown) {
  if (k === 'solo_saldo') return 'Sí'
  if (k.endsWith('_desde') || k.endsWith('_hasta')) return fmtDate(String(v))
  if (k === 'tipos' && Array.isArray(v)) return v.map(t => TIPO_LABEL[t as AptTipoLote] || t).join(', ')
  return Array.isArray(v) ? v.join(', ') : String(v)
}

export function AptFilterBar() {
  const { filters, setFilters, patchFilters } = useAptFilters()
  const [opts, setOpts] = useState<AptFilterOptions | null>(null)
  const [more, setMore] = useState(false)
  const [draft, setDraft] = useState<AptFilters>(filters)
  const [lastFilters, setLastFilters] = useState(filters)
  // Si los filtros cambian desde afuera (otra pestaña, un clic en un gráfico), el borrador se alinea
  if (lastFilters !== filters) { setLastFilters(filters); setDraft(filters) }

  useEffect(() => { aptApi.filterOptions().then(setOpts).catch(() => setOpts(null)) }, [])

  const applyDraft = () => setFilters({ ...filters, lote: draft.lote, contrato: draft.contrato, producto: draft.producto, glosa: draft.glosa,
    numrel_op: draft.numrel_op, ipt: draft.ipt, cliente: draft.cliente, dias_min: draft.dias_min,
    ingreso_desde: draft.ingreso_desde, ingreso_hasta: draft.ingreso_hasta, entrega_desde: draft.entrega_desde, entrega_hasta: draft.entrega_hasta })
  const onEnter = (e: React.KeyboardEvent) => { if (e.key === 'Enter') applyDraft() }
  const active = Object.entries(filters).filter(([, v]) => v !== undefined && v !== '' && !(Array.isArray(v) && !v.length))
  const lotes = opts?.lotes || []

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1.5 pr-1 text-xs font-bold uppercase tracking-wider text-slate-400">
          <Filter className="h-3.5 w-3.5" /> Filtros
        </div>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
          <input list="apt-lotes" value={draft.lote || ''} onChange={e => setDraft(d => ({ ...d, lote: e.target.value }))} onKeyDown={onEnter}
            onBlur={applyDraft} placeholder="Lote / NumRel (16188, 16325-S002…)"
            className="h-9 w-64 rounded-lg border border-slate-200 pl-8 pr-2 text-xs outline-none focus:border-[#002855] focus:ring-2 focus:ring-[#002855]/10" />
          <datalist id="apt-lotes">
            {lotes.slice(0, 2000).map(l => <option key={l.lote} value={l.lote}>{`${TIPO_LABEL[l.tipo]} · saldo ${fmtTn(l.tn_saldo)} TN`}</option>)}
          </datalist>
        </div>
        <select value={filters.contrato || ''} onChange={e => patchFilters({ contrato: e.target.value || undefined })}
          className="h-9 rounded-lg border border-slate-200 bg-white px-2 text-xs font-semibold text-slate-600 outline-none focus:border-[#002855]">
          <option value="">Contrato (OT madre)</option>
          {(opts?.contratos || []).map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <MultiSelect label="Tipo" options={['CONTRATO', 'SUBCONTRATO', 'ERROR']} value={filters.tipos}
          onChange={v => patchFilters({ tipos: v as AptTipoLote[] })} render={o => TIPO_LABEL[o as AptTipoLote]} width="w-48" />
        <MultiSelect label="Estado" options={opts?.estados || ['En APT', 'Salida parcial', 'Despachado', 'Sin salida identificada', 'Problema de información']}
          value={filters.estados} onChange={v => patchFilters({ estados: v as AptEstado[] })} />
        <MultiSelect label="Aging" options={opts?.rangos || []} value={filters.rangos} onChange={v => patchFilters({ rangos: v })} width="w-48" />
        <MultiSelect label="Familia" options={(opts?.familias || []).map(f => f.familia)} value={filters.familias} searchable
          onChange={v => patchFilters({ familias: v })}
          render={o => <span className="flex justify-between gap-2"><span>{o}</span><span className="text-slate-400">{fmtTn(opts?.familias.find(f => f.familia === o)?.tn_saldo)} TN</span></span>} />
        <label className={`flex h-9 cursor-pointer items-center gap-2 rounded-lg border px-3 text-xs font-semibold ${filters.solo_saldo ? 'border-[#002855] bg-[#002855]/5 text-[#002855]' : 'border-slate-200 text-slate-600'}`}>
          <input type="checkbox" className="accent-[#002855]" checked={!!filters.solo_saldo} onChange={e => patchFilters({ solo_saldo: e.target.checked || undefined })} />
          Solo con saldo en APT
        </label>
        <button type="button" onClick={() => setMore(m => !m)}
          className={`flex h-9 items-center gap-1.5 rounded-lg border px-3 text-xs font-semibold ${more ? 'border-slate-400 bg-slate-50 text-slate-800' : 'border-slate-200 text-slate-600 hover:border-slate-300'}`}>
          <SlidersHorizontal className="h-3.5 w-3.5" /> Más filtros
        </button>
        {active.length > 0 && (
          <button type="button" onClick={() => setFilters({})} className="ml-auto flex h-9 items-center gap-1.5 rounded-lg px-3 text-xs font-semibold text-slate-500 hover:bg-slate-50 hover:text-red-600">
            <RotateCcw className="h-3.5 w-3.5" /> Limpiar todo
          </button>
        )}
      </div>

      {more && (
        <div className="mt-3 grid grid-cols-1 gap-3 border-t border-slate-100 pt-3 sm:grid-cols-2 lg:grid-cols-4 xl:grid-cols-6">
          {TEXT_FIELDS.map(t => (
            <label key={t.key} className="text-[11px] font-semibold text-slate-500">
              {t.label}
              <input value={draft[t.key] || ''} onChange={e => setDraft(d => ({ ...d, [t.key]: e.target.value }))} onKeyDown={onEnter}
                placeholder={t.placeholder} className="mt-1 h-8 w-full rounded-md border border-slate-200 px-2 text-xs font-normal text-slate-800 outline-none focus:border-[#002855]" />
            </label>
          ))}
          <label className="text-[11px] font-semibold text-slate-500">
            Días en APT ≥
            <input type="number" min={0} value={draft.dias_min ?? ''} onChange={e => setDraft(d => ({ ...d, dias_min: e.target.value === '' ? undefined : Number(e.target.value) }))}
              onKeyDown={onEnter} className="mt-1 h-8 w-full rounded-md border border-slate-200 px-2 text-xs font-normal text-slate-800 outline-none focus:border-[#002855]" />
          </label>
          {([['ingreso_desde', 'Ingreso APT desde'], ['ingreso_hasta', 'Ingreso APT hasta'], ['entrega_desde', 'FechaEntrega desde'], ['entrega_hasta', 'FechaEntrega hasta']] as const).map(([k, l]) => (
            <label key={k} className="text-[11px] font-semibold text-slate-500">
              {l}
              <input type="date" value={draft[k] || ''} onChange={e => setDraft(d => ({ ...d, [k]: e.target.value || undefined }))}
                className="mt-1 h-8 w-full rounded-md border border-slate-200 px-2 text-xs font-normal text-slate-800 outline-none focus:border-[#002855]" />
            </label>
          ))}
          <div className="flex items-end gap-2">
            <MultiSelect label="DocRel" options={opts?.docrels || []} value={filters.docrels} onChange={v => patchFilters({ docrels: v })} />
          </div>
          <div className="flex items-end">
            <button type="button" onClick={applyDraft} className="h-8 w-full rounded-md bg-[#002855] px-3 text-xs font-bold text-white hover:bg-[#003a7a]">
              Aplicar
            </button>
          </div>
        </div>
      )}

      {active.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {active.map(([k, v]) => (
            <span key={k} className="inline-flex items-center gap-1 rounded-full border border-[#002855]/20 bg-[#002855]/5 py-0.5 pl-2.5 pr-1 text-[11px] text-[#002855]">
              <b>{CHIP_LABEL[k] || k}:</b> <span className="max-w-[16rem] truncate">{chipValue(k, v)}</span>
              <button type="button" onClick={() => setFilters({ ...filters, [k]: undefined })} className="rounded-full p-0.5 hover:bg-[#002855]/10" aria-label={`Quitar ${k}`}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
    </div>
  )
}
