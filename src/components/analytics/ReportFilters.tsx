'use client'

import { useMemo, useState } from 'react'
import { Bookmark, Check, RotateCcw, SlidersHorizontal } from 'lucide-react'
import { applies, defaults, emptyDimensions, filterRows, presetRange, validateRange, type AnalysisRow, type Filters, type Perspective } from '@/lib/analytics/model'

export interface SavedView { name: string; section: Perspective; filters: Filters }
const LABELS: Partial<Record<keyof Filters, string>> = { client: 'Cliente', contract: 'Contrato / OT', plate: 'Unidad / activo', driver: 'Conductor', status: 'Estado', route: 'Origen → destino', site: 'Sede', lot: 'Lote', family: 'Familia', search: 'Buscar en el resultado', incident: 'Incidencias' }
export function ReportFilters({ filters, section, rows, onApply, onDirty, views, onSave, onLoad, onDelete }: {
  filters: Filters; section: Perspective; rows: AnalysisRow[]; onApply: (f: Filters) => void; onDirty: (dirty: boolean) => void
  views: SavedView[]; onSave: (name: string, f: Filters) => void; onLoad: (view: SavedView) => void; onDelete: (name: string) => void
}) {
  const [draft, setDraft] = useState(filters)
  const [name, setName] = useState('')
  const dirty = JSON.stringify(draft) !== JSON.stringify(filters)
  const error = validateRange(draft)
  const keys = applies(section)
  const options = useMemo(() => {
    const result: Partial<Record<keyof Filters, string[]>> = {}
    for (const key of keys) {
      if (['search', 'lot', 'family', 'incident'].includes(key) || (section === 'apt' && ['client', 'contract'].includes(key))) continue
      const candidates = filterRows(rows, { ...draft, [key]: '' })
      const field = key as keyof Pick<AnalysisRow, 'client' | 'contract' | 'plate' | 'driver' | 'status' | 'route' | 'site'>
      const values = candidates.flatMap(r => field === 'client' ? r.clients || [r.client] : field === 'contract' ? r.contracts || [r.contract] : field === 'route' ? r.routes || [r.route] : [r[field]])
      result[key] = [...new Set([...values, draft[key]].filter(Boolean))].sort((a, b) => a.localeCompare(b, 'es'))
    }
    return result
  }, [rows, draft, keys, section])
  const patch = (next: Partial<Filters>) => {
    const updated = { ...draft, ...next }
    setDraft(updated); onDirty(JSON.stringify(updated) !== JSON.stringify(filters))
  }
  const field = 'mt-1 min-h-11 min-w-0 w-full max-w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-base text-slate-800 sm:text-sm focus:border-[#002855]'
  return (
    <section aria-label="Filtros del reporte" className="space-y-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 text-sm font-semibold text-[#002855]"><SlidersHorizontal className="h-4 w-4" />Período y alcance</h2>
        <div className="flex flex-wrap gap-1">{[['today', 'Hoy'], ['week', 'Semana'], ['month', 'Mes'], ['quarter', 'Trimestre']].map(([id, label]) => <button key={id} onClick={() => patch(presetRange(id))} className="min-h-11 rounded-lg border px-3 py-1 text-xs hover:bg-slate-50 sm:min-h-0 sm:py-2">{label}</button>)}</div>
      </div>
      <form onSubmit={e => { e.preventDefault(); if (!error) { onDirty(false); onApply(draft) } }} className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="min-w-0 text-xs font-medium text-slate-600">Desde<input type="date" className={field} value={draft.from} onChange={e => patch({ from: e.target.value })} required /></label>
          <label className="min-w-0 text-xs font-medium text-slate-600">Hasta<input type="date" className={field} value={draft.to} onChange={e => patch({ to: e.target.value })} required /></label>
          <label className="min-w-0 text-xs font-medium text-slate-600">Comparar con<select className={field} value={draft.compare} onChange={e => patch({ compare: e.target.value as Filters['compare'] })}>
            <option value="previous">Período anterior (igual duración)</option><option value="year">Mismo período, año anterior</option><option value="none">Sin comparación</option>
          </select></label>
          {keys.map(key => <label key={key} className="min-w-0 text-xs font-medium text-slate-600">{LABELS[key]}
            {key === 'incident' ? <select className={field} value={draft.incident} onChange={e => patch({ incident: e.target.value })}><option value="">Todos los viajes</option><option value="only">Solo con incidencias</option></select> : key === 'plate' ? <><input list="analytics-assets" className={field} value={draft.plate} onChange={e => patch({ plate: e.target.value })} placeholder="Todas o código exacto" /><datalist id="analytics-assets">{options.plate?.map(v => <option key={v} value={v} />)}</datalist></> : options[key] ? <select className={field} value={draft[key]} onChange={e => patch({ [key]: e.target.value })}><option value="">Todos</option>{options[key]?.map(v => <option key={v} value={v}>{v}</option>)}</select>
              : <input className={field} value={draft[key]} onChange={e => patch({ [key]: e.target.value })} placeholder={key === 'search' ? 'Código, nombre o detalle' : 'Buscar por nombre o código'} />}
          </label>)}
        </div>
        {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-slate-500">{section === 'apt' ? 'APT filtra la fecha de ingreso; el saldo corresponde al corte de datos.' : section === 'eficiencia' ? 'Eficiencia usa los meses completos que contiene el rango.' : 'Fechas interpretadas en Lima. Cada perspectiva muestra sus filtros disponibles.'}</p>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => { onDirty(false); onApply({ ...defaults(), ...emptyDimensions }) }} className="flex min-h-11 items-center gap-1 rounded-lg border px-3 py-2 text-sm"><RotateCcw className="h-4 w-4" />Restablecer</button>
            <button type="submit" disabled={!!error} className="flex min-h-11 items-center gap-1 rounded-lg bg-[#002855] px-4 py-2 text-sm font-semibold text-white disabled:opacity-40"><Check className="h-4 w-4" />Aplicar filtros</button>
          </div>
        </div>
      </form>
      {dirty && <p role="status" className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-800">Hay cambios pendientes. Aplique los filtros para actualizar resultados y habilitar exportaciones.</p>}
      <div className="flex flex-wrap items-center gap-2 border-t pt-3 text-xs">
        <Bookmark className="h-4 w-4 text-slate-500" /><span className="text-slate-600">Mis vistas</span>
        {views.map(v => <span key={v.name} className="inline-flex min-w-0 max-w-full rounded-lg border"><button onClick={() => { onDirty(false); onLoad(v) }} className="min-h-11 min-w-0 break-all px-2 py-1 text-left hover:bg-slate-50 sm:min-h-0">{v.name}</button><button aria-label={`Eliminar vista ${v.name}`} onClick={() => onDelete(v.name)} className="min-h-11 min-w-11 shrink-0 border-l px-2 text-slate-400 sm:min-h-0 sm:min-w-0">×</button></span>)}
        <input aria-label="Nombre de la vista" className="min-h-11 min-w-0 max-w-full rounded-lg border px-2 py-1 text-base sm:text-xs" maxLength={60} value={name} onChange={e => setName(e.target.value)} placeholder="Nombre de esta vista" />
        <button disabled={!name.trim() || dirty} onClick={() => { onSave(name.trim(), filters); setName('') }} className="min-h-11 px-2 font-semibold text-[#002855] disabled:text-slate-400">Guardar vista</button>
      </div>
    </section>
  )
}
