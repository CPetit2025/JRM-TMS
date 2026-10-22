'use client'

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { createClient } from '@/lib/supabase/client'
import type { AreaRule } from '@/lib/apt-analitica/catalog'
import { DEFAULT_AREAS } from '@/lib/apt-analitica/catalog'
import { fromDatasetRow, type Catalogs } from '@/lib/apt-analitica/dataset'
import { analyze, buildBase, cutoffOf, type Analysis, type Base } from '@/lib/apt-analitica/analysis'
import { runFifo, type FifoResult } from '@/lib/apt-analitica/engine'
import { DEFAULT_SETTINGS, EMPTY_FILTERS, type Area, type Commitment, type DocClass, type Filters, type Link, type Movement, type OpeningBalance,
  type Receipt, type Settings, type UnitConversion } from '@/lib/apt-analitica/types'

// Estado compartido de la analítica: datos cargados de la base, filtros globales (en la URL, para volver con el mismo
// contexto), pestaña, detalle abierto («drill») y cálculos memorizados. Todas las pestañas leen de aquí.

export type Tab = 'resumen' | 'apt' | 'dist' | 'traza' | 'calidad' | 'explorador' | 'cargas' | 'config'
export const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'resumen', label: 'Resumen ejecutivo' }, { id: 'apt', label: 'APT' }, { id: 'dist', label: 'Distribución' },
  { id: 'traza', label: 'Trazabilidad' }, { id: 'calidad', label: 'Calidad de datos' }, { id: 'explorador', label: 'Explorador' },
  { id: 'cargas', label: 'Cargas' }, { id: 'config', label: 'Configuración' },
]

export interface Meta {
  can_operate: boolean
  can_admin: boolean
  settings: Settings
  areas: Array<AreaRule & { updated_at?: string }>
  classes: Record<string, DocClass>
  class_rows: Array<{ tipo: string; clase: DocClass; confirmed: boolean }>
  conversions: Array<UnitConversion & { id: string; note: string | null }>
  links: Array<Link & { rule: string | null; updated_at: string }>
  openings: OpeningBalance[]
  commitments: Commitment[]
  receipts: Receipt[]
  imports_active: number
  last_import_at: string | null
  last_change_at: string | null
  discarded: number
  outside_scope: number
  bodegas_sin_area: string[]
}

export interface ImportRow {
  id: string; source_type: string; file_name: string; file_hash: string; file_size: number | null; period_from: string | null; period_to: string | null
  cutoff: string | null; rows_total: number; rows_accepted: number; rows_rejected: number; rows_review: number; rows_discarded: number
  status: 'ACTIVA' | 'REVERTIDA'; warnings: string[]; created_at: string; created_by: string | null; reverted_at: string | null; revert_reason: string | null; reverted_by: string | null
}

export interface Drill { label: string; ids: number[]; from: Tab }

interface Ctx {
  status: 'loading' | 'ready' | 'error'
  error: string | null
  progress: string | null
  meta: Meta | null
  imports: ImportRow[]
  files: Map<string, string>
  base: Base
  cat: Catalogs
  settings: Settings
  fifo: FifoResult
  analysis: Analysis
  filters: Filters
  setFilters: (f: Filters) => void
  tab: Tab
  setTab: (t: Tab) => void
  drill: Drill | null
  openDrill: (label: string, ids: number[]) => void
  closeDrill: () => void
  rawRow: number | null
  setRawRow: (id: number | null) => void
  reload: () => Promise<void>
  /** Análisis con el alcance de un área (APT o Distribución) cuando el filtro global no fija áreas */
  analyzeFor: (areas: Area[]) => Analysis
  unconfirmedAreas: string[]
}

const AnaliticaContext = createContext<Ctx | null>(null)
export const useAnalitica = () => {
  const c = useContext(AnaliticaContext)
  if (!c) throw new Error('useAnalitica fuera de AnaliticaProvider')
  return c
}

function parseFilters(raw: string | null): Filters {
  if (!raw) return EMPTY_FILTERS
  try {
    const f = JSON.parse(raw) as Partial<Filters>
    return { ...EMPTY_FILTERS, ...f }
  } catch { return EMPTY_FILTERS }
}
const isTab = (t: string | null): t is Tab => !!t && TABS.some(x => x.id === t)

export function AnaliticaProvider({ children }: { children: ReactNode }) {
  const supabase = useMemo(() => createClient(), [])
  const router = useRouter()
  const pathname = usePathname()
  const params = useSearchParams()
  const [status, setStatus] = useState<Ctx['status']>('loading')
  const [error, setError] = useState<string | null>(null)
  const [progress, setProgress] = useState<string | null>(null)
  const [meta, setMeta] = useState<Meta | null>(null)
  const [imports, setImports] = useState<ImportRow[]>([])
  const [rows, setRows] = useState<unknown[][]>([])
  const [drill, setDrill] = useState<Drill | null>(null)
  const [rawRow, setRawRow] = useState<number | null>(null)
  const loadSeq = useRef(0)

  // Filtros y pestaña viven en el estado (fuente de verdad) y se reflejan en la URL para compartir y volver con el mismo contexto
  const [filters, setFiltersState] = useState<Filters>(() => parseFilters(params.get('f')))
  const [tab, setTabState] = useState<Tab>(() => isTab(params.get('v')) ? params.get('v') as Tab : 'resumen')
  useEffect(() => {
    const q = new URLSearchParams()
    if (tab !== 'resumen') q.set('v', tab)
    const compact = Object.fromEntries(Object.entries(filters).filter(([, v]) => Array.isArray(v) ? v.length : v !== null && v !== ''))
    if (Object.keys(compact).length) q.set('f', JSON.stringify(compact))
    const next = `${pathname}${q.size ? `?${q}` : ''}`
    if (next !== `${pathname}${window.location.search}`) router.replace(next, { scroll: false })
  }, [filters, tab, pathname, router])
  const setFilters = useCallback((f: Filters) => setFiltersState(f), [])
  const setTab = useCallback((t: Tab) => setTabState(t), [])

  const reload = useCallback(async () => {
    const seq = ++loadSeq.current
    // Una recarga con datos ya cargados no desmonta las pantallas (se conserva el estado de cada pestaña)
    setStatus(st => st === 'ready' ? st : 'loading'); setError(null); setProgress('Leyendo configuración…')
    try {
      const [{ data: m, error: e1 }, { data: imps, error: e3 }] = await Promise.all([supabase.rpc('apa_meta'), supabase.rpc('apa_imports_list')])
      if (e1) throw e1
      if (e3) throw e3
      const all: unknown[][] = []
      let after = 0
      for (let i = 0; i < 200; i++) {
        setProgress(`Leyendo movimientos… ${all.length.toLocaleString('es-PE')}`)
        const { data, error: e2 } = await supabase.rpc('apa_dataset_page', { p_after: after, p_limit: 10000, p_scope: 'AREAS' })
        if (e2) throw e2
        const page = data as { rows: unknown[][]; last_id: number | null; done: boolean }
        all.push(...page.rows)
        if (page.done || page.last_id === null) break
        after = page.last_id
      }
      if (seq !== loadSeq.current) return
      setMeta(m as Meta); setImports((imps ?? []) as ImportRow[]); setRows(all); setStatus('ready'); setProgress(null)
    } catch (e) {
      if (seq !== loadSeq.current) return
      setError(e instanceof Error ? e.message : (e as { message?: string })?.message ?? 'No se pudo leer la información'); setStatus('error'); setProgress(null)
    }
  }, [supabase])
  useEffect(() => { const t = window.setTimeout(() => void reload(), 0); return () => window.clearTimeout(t) }, [reload])

  const cat: Catalogs = useMemo(() => ({ areas: meta?.areas?.length ? meta.areas : DEFAULT_AREAS, classes: meta?.classes ?? {} }), [meta])
  const movements: Movement[] = useMemo(() => rows.map(r => fromDatasetRow(r as never, cat)), [rows, cat])
  const base = useMemo(() => buildBase(movements), [movements])
  const settings: Settings = useMemo(() => meta?.settings ? { ...DEFAULT_SETTINGS, ...meta.settings } : DEFAULT_SETTINGS, [meta])
  const cutoff = cutoffOf(base, filters)
  const openings = useMemo(() => (meta?.openings ?? []).map(o => ({ ...o, cantidad: Number(o.cantidad) })), [meta])
  const fifo = useMemo(() => runFifo(base.accepted, openings, { sameDayOrder: settings.sameDayOrder }, cutoff), [base, openings, settings.sameDayOrder, cutoff])
  const unconfirmedAreas = useMemo(() => cat.areas.filter(a => a.area && !a.confirmed).map(a => a.bodega), [cat])
  const opts = useMemo(() => ({ unconfirmedAreas, hasOpenings: openings.length > 0, openings,
    commitments: (meta?.commitments ?? []).map(c => ({ ...c, cantidad: Number(c.cantidad) })),
    links: meta?.links ?? [], receipts: (meta?.receipts ?? []).map(r => ({ ...r, aceptada: Number(r.aceptada) })) }), [meta, openings, unconfirmedAreas])
  const analysis = useMemo(() => analyze(base, fifo, filters, settings, opts), [base, fifo, filters, settings, opts])
  const cache = useRef(new Map<string, Analysis>())
  useEffect(() => { cache.current.clear() }, [analysis])
  const analyzeFor = useCallback((tabAreas: Area[]) => {
    // La pestaña de un área siempre mira su área; con filtro de área global se intersecta (puede quedar vacía)
    const areas = filters.areas.length ? tabAreas.filter(a => filters.areas.includes(a)) : tabAreas
    const k = areas.join(',') || '(ninguna)'
    const hit = cache.current.get(k)
    if (hit) return hit
    const a = analyze(base, fifo, { ...filters, areas: areas.length ? areas : ['__none__' as Area] }, settings, opts)
    cache.current.set(k, a)
    return a
  }, [base, fifo, filters, settings, opts])

  const openDrill = useCallback((label: string, ids: number[]) => { setDrill({ label, ids, from: tab }); setTabState('explorador') }, [tab])
  const closeDrill = useCallback(() => { const from = drill?.from ?? 'resumen'; setDrill(null); setTabState(from) }, [drill])

  const files = useMemo(() => new Map(imports.map(i => [i.id, i.file_name])), [imports])
  const value: Ctx = { status, error, progress, meta, imports, files, base, cat, settings, fifo, analysis, filters, setFilters, tab, setTab, drill, openDrill, closeDrill,
    rawRow, setRawRow, reload, analyzeFor, unconfirmedAreas }
  return <AnaliticaContext.Provider value={value}>{children}</AnaliticaContext.Provider>
}
