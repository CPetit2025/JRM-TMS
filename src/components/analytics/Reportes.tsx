'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { BarChart3, ChevronRight, Loader2, RefreshCw } from 'lucide-react'
import { usePermissions } from '@/hooks/usePermissions'
import { createClient } from '@/lib/supabase/client'
import { comparisonRange, forPerspective, parseFilters, PERSPECTIVES, type Dataset, type Perspective } from '@/lib/analytics/model'
import { filteredDataset, loadDataset } from '@/lib/analytics/api'
import { AnalysisPanel, MetricCard } from './AnalysisPanel'
import { ReportFilters, type SavedView } from './ReportFilters'
import DesempenoPanel from './DesempenoPanel'

interface Result { section: Perspective; current?: Dataset; previous?: Dataset | null; error?: string; comparisonError?: string }
export default function Reportes() {
  const router = useRouter(), params = useSearchParams()
  const { hasAccess, isLoaded } = usePermissions()
  const visible = useMemo(() => PERSPECTIVES.filter(p => p.id === 'desempeno' || p.permissions.some(hasAccess)), [hasAccess])
  const requested = params.get('section')
  const section = visible.find(x => x.id === requested)?.id || visible[0]?.id || 'desempeno'
  const filters = useMemo(() => forPerspective(parseFilters(params.get('f')), section), [params, section])
  const filterKey = JSON.stringify(filters)
  const [nonce, setNonce] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [result, setResult] = useState<{ key: string; items: Result[]; loaded: string } | null>(null)
  const [userId, setUserId] = useState('')
  const [views, setViews] = useState<SavedView[]>([])
  const [viewError, setViewError] = useState('')
  const key = `${section}|${filterKey}|${nonce}`
  const data = result?.key === key ? result : null
  const domains = useMemo(() => section === 'resumen' ? visible.filter(p => !['resumen', 'desempeno'].includes(p.id)).map(p => p.id) : [section], [section, visible])

  useEffect(() => {
    let alive = true
    createClient().auth.getUser().then(({ data: auth }) => {
      if (!alive || !auth.user) return
      setUserId(auth.user.id)
      try {
        const saved: unknown = JSON.parse(localStorage.getItem(`jrm:analytics:views:${auth.user.id}`) || '[]')
        if (Array.isArray(saved)) setViews(saved.filter(v => v && typeof v.name === 'string' && v.name.length <= 60 && PERSPECTIVES.some(p => p.id === v.section) && v.filters).slice(0, 20).map(v => ({ name: v.name, section: v.section, filters: parseFilters(JSON.stringify(v.filters)) })))
      } catch { /* Una preferencia dañada no bloquea la consulta. */ }
    })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    if (!isLoaded || section === 'desempeno') return
    let alive = true
    const previous = comparisonRange(filters)
    Promise.all(domains.map(async p => {
      const pair = await Promise.allSettled([
        loadDataset(p, filters),
        previous ? loadDataset(p, { ...filters, ...previous }) : Promise.resolve(null),
      ])
      const item: Result = { section: p }
      if (pair[0].status === 'fulfilled') item.current = pair[0].value
      else item.error = pair[0].reason instanceof Error ? pair[0].reason.message : 'No se pudo consultar la fuente.'
      if (pair[1].status === 'fulfilled') item.previous = pair[1].value
      else item.comparisonError = pair[1].reason instanceof Error ? pair[1].reason.message : 'No se pudo consultar la comparación.'
      return item
    })).then(items => { if (alive) setResult({ key, items, loaded: new Date().toLocaleString('es-PE', { timeZone: 'America/Lima' }) }) })
    return () => { alive = false }
  }, [key, section, domains, filters, isLoaded])
  const navigate = useCallback((p: Perspective, f = filters) => {
    const next = new URLSearchParams(params.toString())
    next.set('section', p); next.set('f', JSON.stringify(forPerspective(f, p)))
    if (p !== section) { next.delete('tab'); next.delete('kmonth') }
    setDirty(false)
    router.replace(`/reportes?${next}`, { scroll: false })
  }, [filters, params, router, section])
  const saveViews = (next: SavedView[]) => {
    if (!userId) { setViewError('No se pudo identificar su sesión para guardar la vista.'); return }
    try { localStorage.setItem(`jrm:analytics:views:${userId}`, JSON.stringify(next)); setViews(next); setViewError('') }
    catch { setViewError('El navegador no permite guardar vistas. Puede conservar el enlace con sus filtros.') }
  }
  const focused = data?.items.find(x => x.section === section)
  const current = focused?.current ? filteredDataset(section, focused.current, filters) : null
  const previous = focused?.previous ? filteredDataset(section, focused.previous, filters) : null
  const scope = [...(focused?.current?.rows || []), ...(focused?.previous?.rows || [])]
  const activeFilters = Object.entries(filters).filter(([k, v]) => v && !['from', 'to', 'compare'].includes(k))
  const title = PERSPECTIVES.find(p => p.id === section)?.label || 'Reportes'
  if (!isLoaded) return <div className="flex justify-center p-12"><Loader2 className="h-6 w-6 animate-spin" /></div>
  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div><p className="text-xs font-bold uppercase tracking-[.18em] text-[#cf152d]">Supply Chain Management</p><h1 className="mt-1 flex items-center gap-2 text-2xl font-extrabold text-[#002855]"><BarChart3 className="h-7 w-7" />Reportes y Analítica</h1><p className="mt-1 text-sm text-slate-500">Del resultado al sustento: operación, costos, activos y desempeño según su acceso.</p></div>
        {section !== 'desempeno' && <button onClick={() => setNonce(n => n + 1)} className="flex items-center gap-2 rounded-lg border bg-white px-3 py-2 text-sm"><RefreshCw className="h-4 w-4" />Actualizar</button>}
      </header>
      <nav aria-label="Perspectivas analíticas" className="flex gap-1 overflow-x-auto border-b border-slate-200">{visible.map(p => <button key={p.id} onClick={() => navigate(p.id)} aria-current={section === p.id ? 'page' : undefined} className={`shrink-0 border-b-2 px-4 py-3 text-sm ${section === p.id ? 'border-[#cf152d] font-semibold text-[#002855]' : 'border-transparent text-slate-500 hover:text-[#002855]'}`}>{p.label}</button>)}</nav>
      {section === 'desempeno' ? <DesempenoPanel /> : <>
        <ReportFilters key={`${section}|${filterKey}`} filters={filters} section={section} rows={scope} onApply={f => navigate(section, f)} onDirty={setDirty}
          views={views.filter(v => visible.some(p => p.id === v.section))} onSave={(name, f) => saveViews([...views.filter(v => v.name !== name), { name, section, filters: f }].slice(-20))}
          onLoad={v => navigate(v.section, v.filters)} onDelete={name => saveViews(views.filter(v => v.name !== name))} />
        {viewError && <p role="alert" className="text-sm text-amber-700">{viewError}</p>}
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600"><span className="rounded-full bg-slate-200 px-3 py-1">{filters.from} → {filters.to}</span>
          {activeFilters.map(([k, v]) => <button key={k} title="Quitar filtro" onClick={() => navigate(section, { ...filters, [k]: '' })} className="rounded-full bg-blue-50 px-3 py-1 text-[#002855]">{v} ×</button>)}
          {comparisonRange(filters) && <span>Comparación: {comparisonRange(filters)?.from} → {comparisonRange(filters)?.to}</span>}
          {data && <span className="ml-auto">Actualizado: {data.loaded} (Lima)</span>}
        </div>
        {!data ? <div role="status" className="flex items-center justify-center gap-2 rounded-xl border bg-white p-12 text-sm text-slate-500"><Loader2 className="h-5 w-5 animate-spin" />Consultando fuentes y comparación…</div>
          : section === 'resumen' ? <div className="space-y-5">{data.items.map(item => {
            const label = PERSPECTIVES.find(p => p.id === item.section)?.label || item.section
            const d = item.current ? filteredDataset(item.section, item.current, filters) : null
            return <section key={item.section} className="space-y-3 rounded-2xl border bg-slate-50 p-4"><div className="flex items-center justify-between"><h2 className="font-semibold text-[#002855]">{label}</h2><button onClick={() => navigate(item.section)} className="flex items-center gap-1 text-sm font-semibold text-[#002855]">Explorar<ChevronRight className="h-4 w-4" /></button></div>
              {item.error ? <p role="alert" className="text-sm text-red-700">No disponible: {item.error}</p> : d && <><p className="text-xs text-slate-500">{d.source} · {d.basis}</p><div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">{d.metrics.map(m => <MetricCard key={m.key} metric={m} previous={item.previous ? filteredDataset(item.section, item.previous, filters).metrics.find(x => x.key === m.key) : undefined} onClick={() => navigate(item.section)} />)}</div></>}
              {item.comparisonError && <p className="text-xs text-amber-700">Comparación no disponible: {item.comparisonError}</p>}
            </section>
          })}<p className="text-xs text-slate-500">Cada bloque conserva su unidad y base de cálculo. No se construye un índice general mezclando rentabilidad, disponibilidad y desempeño.</p></div>
          : focused?.error ? <div role="alert" className="rounded-xl border border-red-200 bg-red-50 p-6 text-sm text-red-800"><p>{focused.error}</p><button onClick={() => setNonce(n => n + 1)} className="mt-2 font-semibold">Reintentar</button></div>
          : current && <>{focused?.comparisonError && <p role="alert" className="text-sm text-amber-700">Comparación no disponible: {focused.comparisonError}. Actualice para reintentar.</p>}<AnalysisPanel key={key} section={section} title={title} data={current} previous={previous} filters={filters} blocked={dirty || !!focused?.comparisonError} onFilter={patch => navigate(section, { ...filters, ...patch })} /></>}
      </>}
    </div>
  )
}
