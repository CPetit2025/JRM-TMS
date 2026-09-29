'use client'

import { useEffect, useMemo, useRef, useState } from 'react'
import { Briefcase, ChevronDown, FileWarning, Layers, MapPin, Search, X } from 'lucide-react'

// Buscador de OT para solicitudes: agrupa cada OT madre (o independiente) con sus subcontratos y errores.
// Busca por código (también el de un hijo), cliente o destino. Elegir un hijo selecciona su OT madre y lo marca.

export type OtNode = {
  id: string
  code: string
  type: string
  parent_contract_id: string | null
  client_name: string | null
  destination_district: string | null
  destination_address: string | null
  allocated_pen: number | null
  balance_pen: number | null
}

const money = (n: number) => n.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const norm = (s: string | null | undefined) => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()

function TypeBadge({ type }: { type: string }) {
  if (type === 'SUBCONTRATO') return <span className="inline-flex items-center gap-1 rounded bg-purple-100 px-1.5 py-0.5 text-[10px] font-semibold text-purple-800"><Layers className="h-3 w-3" />Sub</span>
  if (type === 'ERROR') return <span className="inline-flex items-center gap-1 rounded bg-red-100 px-1.5 py-0.5 text-[10px] font-semibold text-red-800"><FileWarning className="h-3 w-3" />Error</span>
  if (type === 'OT_INDEPENDIENTE') return <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] font-semibold text-slate-700">OT indep.</span>
  return <span className="inline-flex items-center gap-1 rounded bg-blue-100 px-1.5 py-0.5 text-[10px] font-semibold text-blue-800"><Briefcase className="h-3 w-3" />Madre</span>
}

function Balance({ node }: { node: OtNode }) {
  const allocated = Number(node.allocated_pen || 0)
  const balance = Number(node.balance_pen || 0)
  if (!allocated && !balance) return <span className="text-[11px] text-slate-400">Sin partida</span>
  const cls = balance < 0 ? 'text-red-600' : allocated > 0 && balance / allocated < 0.15 ? 'text-amber-600' : 'text-emerald-700'
  return <span className={`text-xs font-semibold tabular-nums ${cls}`}>S/ {money(balance)}</span>
}

export function OtPicker({ nodes, value, onSelect, onClear, disabled }: {
  nodes: OtNode[]
  value: string
  onSelect: (rootId: string, childId?: string) => void
  onClear: () => void
  disabled?: boolean
}) {
  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const { roots, children } = useMemo(() => {
    const kids = new Map<string, OtNode[]>()
    nodes.forEach(n => { if (n.parent_contract_id) kids.set(n.parent_contract_id, [...(kids.get(n.parent_contract_id) || []), n]) })
    kids.forEach(list => list.sort((a, b) => a.code.localeCompare(b.code, 'es', { numeric: true })))
    return { roots: nodes.filter(n => !n.parent_contract_id), children: kids }
  }, [nodes])

  const results = useMemo(() => {
    const terms = norm(query).split(/\s+/).filter(Boolean)
    const text = (n: OtNode) => norm([n.code, n.client_name, n.destination_district, n.destination_address].join(' '))
    const matches = (n: OtNode) => terms.every(t => text(n).includes(t))
    return roots
      .map(root => {
        const kids = children.get(root.id) || []
        const kidHits = terms.length ? kids.filter(matches) : []
        return { root, kids, kidHits, hit: !terms.length || matches(root) || kidHits.length > 0 }
      })
      .filter(r => r.hit)
      // Coincidencia exacta de código primero
      .sort((a, b) => Number(norm(b.root.code) === norm(query)) - Number(norm(a.root.code) === norm(query)))
      .slice(0, 40)
  }, [roots, children, query])

  const selected = roots.find(r => r.id === value)
  const choose = (rootId: string, childId?: string) => { onSelect(rootId, childId); setOpen(false); setQuery('') }

  if (selected && !open) {
    const kids = children.get(selected.id) || []
    return (
      <div className="flex items-center gap-3 rounded-lg border border-blue-200 bg-blue-50/50 px-3 py-2">
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-bold text-slate-900">{selected.code}</span>
            <TypeBadge type={selected.type} />
            <span className="truncate text-sm text-[#002855]">{selected.client_name || 'Sin cliente'}</span>
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-3 text-xs text-slate-500">
            {(selected.destination_district || selected.destination_address) && (
              <span className="inline-flex items-center gap-1"><MapPin className="h-3 w-3" />{[selected.destination_district, selected.destination_address].filter(Boolean).join(' · ')}</span>
            )}
            {kids.length > 0 && <span>{kids.filter(k => k.type === 'SUBCONTRATO').length} sub · {kids.filter(k => k.type === 'ERROR').length} errores</span>}
            <span>Saldo: <Balance node={selected} /></span>
          </div>
        </div>
        {!disabled && <>
          <button type="button" onClick={() => setOpen(true)} className="text-xs font-medium text-[#002855] hover:underline">Cambiar</button>
          <button type="button" onClick={onClear} className="rounded p-1 text-slate-400 hover:bg-white hover:text-red-600" title="Quitar OT" aria-label="Quitar OT"><X className="h-4 w-4" /></button>
        </>}
      </div>
    )
  }

  return (
    <div ref={box} className="relative">
      <div className="relative">
        <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
        <input
          type="text"
          value={query}
          disabled={disabled}
          onFocus={() => setOpen(true)}
          onChange={e => { setQuery(e.target.value); setOpen(true) }}
          onKeyDown={e => {
            if (e.key === 'Escape') setOpen(false)
            if (e.key === 'Enter') { e.preventDefault(); if (results[0]) choose(results[0].root.id, results[0].kidHits.length === 1 ? results[0].kidHits[0].id : undefined) }
          }}
          placeholder="Buscar OT por código (madre, sub o error), cliente o destino…"
          className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-9 text-slate-900 outline-none focus:ring-2 focus:ring-[#002855]"
        />
        <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
      </div>
      {open && (
        <div className="absolute z-50 mt-1 max-h-80 w-full overflow-y-auto rounded-lg border border-slate-200 bg-white shadow-lg">
          {results.length === 0 ? <p className="p-3 text-sm text-slate-500">Sin OT activas que coincidan.</p> : results.map(({ root, kids, kidHits }) => (
            <div key={root.id} className="border-b border-slate-100 last:border-0">
              <button type="button" onClick={() => choose(root.id)} className="flex w-full items-start gap-3 px-3 py-2 text-left hover:bg-blue-50">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold text-slate-900">{root.code}</span>
                    <TypeBadge type={root.type} />
                    <span className="truncate text-sm text-[#002855]">{root.client_name || 'Sin cliente'}</span>
                  </div>
                  {(root.destination_district || root.destination_address) && (
                    <div className="mt-0.5 flex items-center gap-1 truncate text-xs text-slate-500"><MapPin className="h-3 w-3 shrink-0" />{[root.destination_district, root.destination_address].filter(Boolean).join(' · ')}</div>
                  )}
                </div>
                <Balance node={root} />
              </button>
              {(kidHits.length ? kidHits : kids).map(kid => (
                <button key={kid.id} type="button" onClick={() => choose(root.id, kid.id)}
                  className={`flex w-full items-center gap-2 py-1.5 pl-8 pr-3 text-left text-sm hover:bg-blue-50 ${kidHits.includes(kid) ? 'bg-amber-50/60' : ''}`}>
                  <span className="text-slate-300">↳</span>
                  <span className="font-medium text-slate-700">{kid.code}</span>
                  <TypeBadge type={kid.type} />
                  <span className="min-w-0 flex-1 truncate text-xs text-slate-500">{kid.destination_district || kid.destination_address || ''}</span>
                  {Number(kid.allocated_pen || 0) > 0 && <Balance node={kid} />}
                </button>
              ))}
              {kidHits.length > 0 && kids.length > kidHits.length && (
                <p className="pb-1.5 pl-8 text-[11px] text-slate-400">+{kids.length - kidHits.length} componentes más en esta OT</p>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
