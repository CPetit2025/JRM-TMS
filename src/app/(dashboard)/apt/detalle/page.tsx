'use client'

import { useEffect, useMemo, useState, type ReactNode } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { AlertTriangle, ArrowDown, ArrowUp, ArrowUpDown, ChevronLeft, ChevronRight, Download, Loader2 } from 'lucide-react'
import { aptApi } from '@/lib/apt/api'
import { exportAptXlsx } from '@/lib/apt/export'
import { fmtDate, fmtDias, fmtInt, fmtKg, fmtPct, fmtTn, TIPO_LABEL } from '@/lib/apt/format'
import { loteHref, useAptFilters } from '@/lib/apt/useAptFilters'
import type { AptCapa, AptDetail, AptFilters, AptGroupRow, AptLevel, AptTipoLote } from '@/lib/apt/types'
import { DiasBadge, EmptyState, ErrorBlock, EstadoBadge, InlineBar, LoadingBlock, TipoBadge } from '@/components/apt/ui'

// Detalle APT: matriz central por capa (movimiento FIFO) o agregada por NumRel, OP, producto, glosa, familia o IPT.
// Orden y paginación se resuelven en el servidor (apt_detail).

type Row = AptCapa | AptGroupRow
type Align = 'left' | 'right' | 'center'
interface Col<T> {
  key: string
  label: string
  sort?: string // columna válida para p_sort en apt_detail
  align?: Align
  className?: string
  render: (r: T, ctx: Ctx) => ReactNode
  excel: (r: T) => unknown
}
interface Ctx {
  filters: AptFilters
  alert: number
  heat: (field: 'tn_saldo' | 'tn_dias', v: number) => string
  maxSaldo: number
  drill: (r: AptGroupRow) => void
}

const LEVELS: Array<{ id: AptLevel; label: string; clave: string; plural: string }> = [
  { id: 'capa', label: 'Capa / movimiento', clave: 'Capa', plural: 'Capas' },
  { id: 'lote', label: 'NumRel padre', clave: 'NumRel padre', plural: 'NumRel padre' },
  { id: 'numrel_op', label: 'NumRel OP', clave: 'NumRel OP', plural: 'NumRel OP' },
  { id: 'producto', label: 'Producto', clave: 'Producto', plural: 'Productos' },
  { id: 'glosa', label: 'Glosa', clave: 'Glosa', plural: 'Glosas' },
  { id: 'familia', label: 'Familia', clave: 'Familia', plural: 'Familias' },
  { id: 'ipt', label: 'IPT', clave: 'IPT', plural: 'IPT' },
]
const PAGE_SIZES = [50, 100, 250]
const EXPORT_LIMIT = 20000
// Columnas de texto: al ordenar por primera vez van ascendentes; las numéricas y fechas, descendentes
const TEXT_SORTS = new Set(['lote', 'numrel_op', 'producto', 'glosa', 'ipt', 'clave', 'etiqueta', 'tipo', 'estado'])

const num = (v: unknown) => (v === null || v === undefined || v === '' ? null : Number(v))
const tn = (v: number | null | undefined) => (v === null || v === undefined ? null : Math.round(Number(v) * 1000) / 1000)

const LoteLink = ({ lote, filters, children }: { lote: string; filters: AptFilters; children?: ReactNode }) => (
  <Link href={loteHref(lote, filters)} className="font-bold text-[#002855] hover:text-[#cf152d] hover:underline">{children ?? lote}</Link>
)

const CAPA_COLS: Col<AptCapa>[] = [
  {
    key: 'lote', label: 'NumRel padre', sort: 'lote',
    render: (r, c) => (
      <div className="flex items-center gap-1.5">
        <LoteLink lote={r.lote} filters={c.filters} />
        {r.tipo !== 'CONTRATO' && <TipoBadge tipo={r.tipo} />}
      </div>
    ),
    excel: r => r.lote,
  },
  { key: 'numrel_op', label: 'NumRel OP', sort: 'numrel_op', render: r => r.numrel_op || '—', excel: r => r.numrel_op },
  { key: 'producto', label: 'Producto', sort: 'producto', className: 'font-mono text-[11px]', render: r => r.producto, excel: r => r.producto },
  {
    key: 'glosa', label: 'Glosa', sort: 'glosa',
    render: r => <span className="block max-w-[260px] truncate" title={r.glosa || ''}>{r.glosa || '—'}</span>, excel: r => r.glosa,
  },
  { key: 'ipt', label: 'IPT', sort: 'ipt', render: r => r.ipt || '—', excel: r => r.ipt },
  { key: 'fecha_ingreso', label: 'Fecha ingreso', sort: 'fecha_ingreso', render: r => fmtDate(r.fecha_ingreso), excel: r => r.fecha_ingreso },
  { key: 'fecha_entrega', label: 'FechaEntrega', sort: 'fecha_entrega', render: r => fmtDate(r.fecha_entrega), excel: r => r.fecha_entrega },
  { key: 'ultima_salida', label: 'Última salida', sort: 'last_out', render: r => fmtDate(r.ultima_salida), excel: r => r.ultima_salida },
  {
    key: 'cantidad', label: 'Cantidad', sort: 'cantidad', align: 'right',
    render: r => <>{fmtInt(r.cantidad)} <span className="text-[10px] text-slate-400">{r.unidad || ''}</span></>, excel: r => num(r.cantidad),
  },
  { key: 'unidad', label: 'Unidad', render: () => null, excel: r => r.unidad },
  { key: 'kg_in', label: 'Peso KG', sort: 'kg_in', align: 'right', render: r => fmtKg(r.kg_in), excel: r => num(r.kg_in) },
  { key: 'tn_in', label: 'TN ingresada', sort: 'kg_in', align: 'right', render: r => fmtTn(r.tn_in), excel: r => tn(r.tn_in) },
  { key: 'tn_out', label: 'TN despachada', sort: 'kg_out', align: 'right', render: r => fmtTn(r.tn_out), excel: r => tn(r.tn_out) },
  { key: 'kg_saldo', label: 'Saldo KG', sort: 'kg_saldo', align: 'right', render: r => fmtKg(r.kg_saldo), excel: r => num(r.kg_saldo) },
  {
    key: 'tn_saldo', label: 'Saldo TN', sort: 'kg_saldo', align: 'right',
    render: (r, c) => <span className={`rounded px-1.5 py-0.5 font-semibold ${c.heat('tn_saldo', r.tn_saldo)}`}>{fmtTn(r.tn_saldo)}</span>,
    excel: r => tn(r.tn_saldo),
  },
  { key: 'dias', label: 'Días APT', sort: 'dias', align: 'center', render: (r, c) => <DiasBadge dias={r.dias} alert={c.alert} />, excel: r => num(r.dias) },
  { key: 'rango', label: 'Rango aging', sort: 'rango_orden', render: r => <span className="whitespace-nowrap">{r.rango || '—'}</span>, excel: r => r.rango },
  {
    key: 'tn_dias', label: 'TN×Días', sort: 'tn_dias', align: 'right',
    render: (r, c) => <span className={`rounded px-1.5 py-0.5 font-semibold ${c.heat('tn_dias', r.tn_dias)}`}>{fmtTn(r.tn_dias)}</span>,
    excel: r => num(r.tn_dias),
  },
  {
    key: 'estado', label: 'Estado', sort: 'estado',
    render: r => (
      <div className="flex items-center gap-1">
        <EstadoBadge estado={r.estado} />
        {r.salida_antes_ingreso && (
          <span title="Hay salidas registradas antes de la fecha de ingreso de esta capa" aria-label="Salida antes del ingreso">
            <AlertTriangle className="h-3.5 w-3.5 text-violet-600" />
          </span>
        )}
      </div>
    ),
    excel: r => r.estado,
  },
  { key: 'salida_antes_ingreso', label: 'Salida antes del ingreso', render: () => null, excel: r => (r.salida_antes_ingreso ? 'Sí' : 'No') },
  { key: 'documento', label: 'Documento', render: () => null, excel: r => r.documento },
  { key: 'familia', label: 'Familia', render: () => null, excel: r => r.familia },
  { key: 'tipo', label: 'Tipo de lote', render: () => null, excel: r => TIPO_LABEL[r.tipo] || r.tipo },
]
// Columnas que solo van al Excel (la tabla las integra en otras celdas)
const CAPA_EXCEL_ONLY = new Set(['unidad', 'salida_antes_ingreso', 'documento', 'familia', 'tipo'])

function groupCols(level: AptLevel): Col<AptGroupRow>[] {
  const claveLabel = LEVELS.find(l => l.id === level)?.clave || 'Clave'
  const linkable = level === 'lote' || level === 'numrel_op'
  const counts: Array<{ k: 'capas' | 'lotes' | 'productos' | 'ops' | 'ipts'; label: string }> = (
    {
      lote: [{ k: 'productos', label: 'Productos' }, { k: 'ops', label: 'OP' }, { k: 'capas', label: 'Capas' }],
      numrel_op: [{ k: 'productos', label: 'Productos' }, { k: 'capas', label: 'Capas' }],
      producto: [{ k: 'lotes', label: 'Lotes' }, { k: 'capas', label: 'Capas' }],
      glosa: [{ k: 'productos', label: 'Productos' }, { k: 'lotes', label: 'Lotes' }, { k: 'capas', label: 'Capas' }],
      familia: [{ k: 'productos', label: 'Productos' }, { k: 'lotes', label: 'Lotes' }, { k: 'capas', label: 'Capas' }],
      ipt: [{ k: 'lotes', label: 'Lotes' }, { k: 'productos', label: 'Productos' }, { k: 'capas', label: 'Capas' }],
      capa: [],
    } as const
  )[level].slice()
  const cols: Col<AptGroupRow>[] = [
    {
      key: 'clave', label: claveLabel, sort: 'clave',
      render: (r, c) => {
        const main = level === 'lote'
          ? <LoteLink lote={r.clave} filters={c.filters} />
          : level === 'numrel_op'
            ? <button type="button" onClick={() => c.drill(r)} className="font-bold text-[#002855] hover:text-[#cf152d] hover:underline">{r.clave}</button>
            : (
              <button type="button" onClick={() => c.drill(r)} title="Ver las capas de este elemento"
                className={`max-w-[320px] truncate text-left font-semibold text-[#002855] hover:text-[#cf152d] hover:underline ${level === 'producto' ? 'font-mono text-[11px]' : ''}`}>
                {r.clave}
              </button>
            )
        return (
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">{main}{linkable && r.tipo && r.tipo !== 'CONTRATO' && <TipoBadge tipo={r.tipo} />}</div>
            {r.etiqueta && <p className="max-w-[320px] truncate text-[11px] text-slate-500" title={r.etiqueta}>{r.etiqueta}</p>}
          </div>
        )
      },
      excel: r => r.clave,
    },
  ]
  if (hasEtiqueta(level)) cols.push({ key: 'etiqueta', label: level === 'lote' || level === 'numrel_op' ? 'Glosa principal' : 'Glosa', render: () => null, excel: r => r.etiqueta })
  if (linkable) cols.push({ key: 'tipo', label: 'Tipo', render: () => null, excel: r => (r.tipo ? TIPO_LABEL[r.tipo as AptTipoLote] : null) })
  counts.forEach(({ k, label }) => cols.push({ key: k, label, sort: k, align: 'right', render: r => fmtInt(r[k]), excel: r => num(r[k]) }))
  cols.push(
    { key: 'primer_ingreso', label: 'Primer ingreso', sort: 'primer_ingreso', render: r => fmtDate(r.primer_ingreso), excel: r => r.primer_ingreso },
    { key: 'ultima_salida', label: 'Última salida', sort: 'ultima_salida', render: r => fmtDate(r.ultima_salida), excel: r => r.ultima_salida },
    { key: 'tn_in', label: 'TN ingresada', sort: 'kg_in', align: 'right', render: r => fmtTn(r.tn_in), excel: r => tn(r.tn_in) },
    { key: 'tn_out', label: 'TN despachada', sort: 'kg_out', align: 'right', render: r => fmtTn(r.tn_out), excel: r => tn(r.tn_out) },
    { key: 'pct_despachado', label: '% despachado', align: 'right', render: r => fmtPct(r.pct_despachado), excel: r => num(r.pct_despachado) },
    {
      key: 'tn_saldo', label: 'Saldo TN', sort: 'kg_saldo', align: 'right',
      render: (r, c) => (
        <div className="flex min-w-[96px] flex-col items-end gap-1">
          <span className={`rounded px-1.5 py-0.5 font-semibold ${c.heat('tn_saldo', r.tn_saldo)}`}>{fmtTn(r.tn_saldo)}</span>
          {r.tn_saldo > 0 && <InlineBar value={r.tn_saldo} max={c.maxSaldo} />}
        </div>
      ),
      excel: r => tn(r.tn_saldo),
    },
    {
      key: 'dias', label: 'Días saldo + antiguo', sort: 'dias', align: 'center',
      render: (r, c) => <DiasBadge dias={r.dias} alert={c.alert} />, excel: r => num(r.dias),
    },
    { key: 'aging_pond', label: 'Aging ponderado', sort: 'aging_pond', align: 'right', render: r => fmtDias(r.aging_pond), excel: r => num(r.aging_pond) },
    {
      key: 'dias_despacho_pond', label: 'Días prom. despacho', sort: 'dias_despacho_pond', align: 'right',
      render: r => fmtDias(r.dias_despacho_pond), excel: r => num(r.dias_despacho_pond),
    },
    {
      key: 'tn_dias', label: 'TN×Días', sort: 'tn_dias', align: 'right',
      render: (r, c) => <span className={`rounded px-1.5 py-0.5 font-semibold ${c.heat('tn_dias', r.tn_dias)}`}>{fmtTn(r.tn_dias)}</span>,
      excel: r => num(r.tn_dias),
    },
    { key: 'rango', label: 'Rango', sort: 'rango_orden', render: r => <span className="whitespace-nowrap">{r.rango || '—'}</span>, excel: r => r.rango },
    {
      key: 'estado', label: 'Estado', sort: 'estado',
      render: r => (
        <div className="flex items-center gap-1">
          <EstadoBadge estado={r.estado} />
          {r.capas_problema > 0 && (
            <span title={`${r.capas_problema} capa(s) con problema de información`} aria-label="Capas con problema de información">
              <AlertTriangle className="h-3.5 w-3.5 text-violet-600" />
            </span>
          )}
        </div>
      ),
      excel: r => r.estado,
    },
  )
  return cols
}
// En niveles agregados la etiqueta se muestra bajo la clave; en Excel va como columna propia
function hasEtiqueta(level: AptLevel) {
  return level === 'lote' || level === 'numrel_op' || level === 'producto' || level === 'ipt'
}
const GROUP_EXCEL_ONLY = new Set(['etiqueta', 'tipo'])

// Fondo graduado (ámbar → rojo suave) según el percentil del valor dentro de la página
function makeHeat(rows: Row[]) {
  const sorted = (field: 'tn_saldo' | 'tn_dias') =>
    rows.map(r => Number(r[field]) || 0).filter(v => v > 0).sort((a, b) => a - b)
  const s = { tn_saldo: sorted('tn_saldo'), tn_dias: sorted('tn_dias') }
  return (field: 'tn_saldo' | 'tn_dias', v: number) => {
    const arr = s[field]
    const val = Number(v) || 0
    if (val <= 0 || arr.length < 4) return ''
    let below = 0
    while (below < arr.length && arr[below] < val) below++
    const p = below / (arr.length - 1)
    if (p >= 0.9) return 'bg-red-100 text-red-800'
    if (p >= 0.75) return 'bg-orange-100 text-orange-800'
    if (p >= 0.5) return 'bg-amber-50 text-amber-800'
    return ''
  }
}

type LoadState = { key: string; data: AptDetail<Row> | null; error: string | null }

export default function AptDetallePage() {
  const { filters, patchFilters, filterKey } = useAptFilters()
  const [level, setLevel] = useState<AptLevel>('capa')
  const [sort, setSort] = useState('tn_dias')
  const [desc, setDesc] = useState(true)
  const [pageSize, setPageSize] = useState(100)
  // La página vuelve a 1 cuando cambian filtros o nivel (se guarda con la clave a la que pertenece)
  const baseKey = `${filterKey}|${level}`
  const [pageState, setPageState] = useState({ key: baseKey, page: 0 })
  const page = pageState.key === baseKey ? pageState.page : 0
  const setPage = (p: number) => setPageState({ key: baseKey, page: p })
  const [nonce, setNonce] = useState(0)
  const [alert, setAlert] = useState(60)
  const [exporting, setExporting] = useState(false)
  const [state, setState] = useState<LoadState>({ key: '', data: null, error: null })

  const reqKey = JSON.stringify([filterKey, level, sort, desc, pageSize, page, nonce])
  const loading = state.key !== reqKey

  useEffect(() => {
    aptApi.settings().then(s => setAlert(s.settings.alert_days || 60)).catch(() => undefined)
  }, [])

  useEffect(() => {
    let alive = true
    aptApi.detail<Row>(filters, level, sort, desc, pageSize, page * pageSize)
      .then(d => { if (alive) setState({ key: reqKey, data: d, error: null }) })
      .catch((e: Error) => { if (alive) setState({ key: reqKey, data: null, error: e.message }) })
    return () => { alive = false }
    // reqKey resume todas las dependencias de la consulta
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reqKey])

  const data = state.data && state.data.level === level ? state.data : null
  const rows = useMemo(() => data?.rows ?? [], [data])
  const isCapa = level === 'capa'
  const cols = useMemo(() => (isCapa ? CAPA_COLS : groupCols(level)) as Col<Row>[], [isCapa, level])
  const excelOnly = isCapa ? CAPA_EXCEL_ONLY : GROUP_EXCEL_ONLY
  const shownCols = cols.filter(c => !excelOnly.has(c.key))

  const ctx: Ctx = useMemo(() => ({
    filters,
    alert,
    heat: makeHeat(rows),
    maxSaldo: Math.max(0, ...rows.map(r => Number(r.tn_saldo) || 0)),
    drill: (r: AptGroupRow) => {
      const patch: Partial<AptFilters> =
        level === 'producto' ? { producto: r.clave }
          : level === 'glosa' ? { glosa: r.clave }
            : level === 'familia' ? { familias: [r.clave] }
              : level === 'numrel_op' ? { numrel_op: r.clave }
                : level === 'ipt' ? (r.clave === '(sin IPT)' ? {} : { ipt: r.clave })
                  : {}
      patchFilters(patch)
      setLevel('capa')
      setSort('tn_dias')
      setDesc(true)
    },
  }), [filters, alert, rows, level, patchFilters])

  const changeLevel = (l: AptLevel) => {
    if (l === level) return
    setLevel(l)
    setSort('tn_dias')
    setDesc(true)
  }
  const changeSort = (s: string) => {
    if (s === sort) setDesc(d => !d)
    else { setSort(s); setDesc(!TEXT_SORTS.has(s)) }
    setPage(0)
  }

  const exportExcel = async () => {
    setExporting(true)
    try {
      const d = await aptApi.detail<Row>(filters, level, sort, desc, EXPORT_LIMIT, 0)
      const out = d.rows.map(r => Object.fromEntries(cols.map(c => [c.label, c.excel(r)])))
      const name = LEVELS.find(l => l.id === level)?.label.replace(/[^\wÁÉÍÓÚáéíóúñÑ]+/g, '_') || level
      exportAptXlsx(`APT_detalle_${name}_${new Date().toISOString().slice(0, 10)}`, { [`Detalle ${LEVELS.find(l => l.id === level)?.clave}`]: out })
      if (d.total > EXPORT_LIMIT) toast.warning(`Se exportaron las primeras ${fmtInt(EXPORT_LIMIT)} de ${fmtInt(d.total)} filas`)
      else toast.success(`Exportadas ${fmtInt(d.rows.length)} filas`)
    } catch (e) {
      toast.error((e as Error).message)
    } finally {
      setExporting(false)
    }
  }

  const total = data?.total ?? 0
  const totals = data?.totals
  const pages = Math.max(1, Math.ceil(total / pageSize))
  const from = total ? page * pageSize + 1 : 0
  const to = Math.min(total, (page + 1) * pageSize)
  const pctDesp = totals && totals.tn_in > 0 ? (100 * totals.tn_out) / totals.tn_in : null

  return (
    <div className="space-y-4">
      {/* Nivel de análisis */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div role="tablist" aria-label="Nivel de detalle" className="inline-flex flex-wrap rounded-xl border border-slate-200 bg-white p-1 shadow-sm">
          {LEVELS.map(l => (
            <button key={l.id} type="button" role="tab" aria-selected={level === l.id} onClick={() => changeLevel(l.id)}
              className={`rounded-lg px-3 py-1.5 text-xs font-bold transition-colors ${
                level === l.id ? 'bg-[#002855] text-white shadow-sm' : 'text-slate-600 hover:bg-slate-100 hover:text-slate-900'}`}>
              {l.label}
            </button>
          ))}
        </div>
        <button type="button" onClick={exportExcel} disabled={exporting || !total}
          className="flex items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs font-bold text-slate-700 shadow-sm hover:border-[#002855] hover:text-[#002855] disabled:opacity-50">
          {exporting ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Download className="h-3.5 w-3.5" />} Exportar Excel
        </button>
      </div>

      {/* Barra resumen */}
      <div className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-slate-200 bg-slate-200 shadow-sm sm:grid-cols-3 lg:grid-cols-6">
        {[
          { label: LEVELS.find(l => l.id === level)?.plural || 'Filas', value: fmtInt(totals ? total : null), cls: 'text-slate-900' },
          { label: 'TN ingresada', value: fmtTn(totals?.tn_in), cls: 'text-[#002855]' },
          { label: 'TN despachada', value: fmtTn(totals?.tn_out), cls: 'text-teal-700' },
          { label: '% despachado', value: fmtPct(pctDesp), cls: 'text-slate-700' },
          { label: 'Saldo TN en APT', value: fmtTn(totals?.tn_saldo), cls: 'text-[#002855]' },
          { label: 'TN×Días', value: fmtTn(totals?.tn_dias), cls: 'text-[#cf152d]' },
        ].map(k => (
          <div key={k.label} className="bg-white px-4 py-3">
            <p className="text-[10px] font-bold uppercase tracking-wider text-slate-500">{k.label}</p>
            <p className={`mt-0.5 text-lg font-black tabular-nums ${k.cls}`}>{k.value}</p>
          </div>
        ))}
      </div>

      {state.error && !loading ? (
        <ErrorBlock message={state.error} onRetry={() => setNonce(n => n + 1)} />
      ) : !data && loading ? (
        <div className="rounded-xl border border-slate-200 bg-white shadow-sm"><LoadingBlock label="Cargando detalle…" /></div>
      ) : data && total === 0 ? (
        <EmptyState title={Object.keys(filters).length ? 'Ningún registro coincide con los filtros' : 'Aún no hay movimientos: cargue ENTRADA y SALIDA'}>
          {Object.keys(filters).length ? 'Ajuste o limpie los filtros para ver resultados.' : null}
        </EmptyState>
      ) : (
        <section className="relative rounded-xl border border-slate-200 bg-white shadow-sm">
          {loading && (
            <div className="absolute inset-x-0 top-0 z-30 h-0.5 overflow-hidden rounded-t-xl bg-slate-100">
              <div className="h-full w-1/3 animate-pulse bg-[#002855]" />
            </div>
          )}
          <div className={`max-h-[70vh] overflow-auto transition-opacity ${loading ? 'opacity-60' : ''}`}>
            <table className="w-full border-separate border-spacing-0 text-xs">
              <thead>
                <tr>
                  {shownCols.map((c, i) => (
                    <SortTh key={c.key} col={c} active={sort === c.sort} desc={desc} onSort={changeSort} first={i === 0} />
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={isCapa ? (r as AptCapa).id : (r as AptGroupRow).clave} className="group">
                    {shownCols.map((c, i) => (
                      <td key={c.key}
                        className={`whitespace-nowrap border-b border-slate-100 px-3 py-2 text-slate-700 group-hover:bg-slate-50 ${
                          c.align === 'right' ? 'text-right tabular-nums' : c.align === 'center' ? 'text-center' : ''} ${
                          i === 0 ? 'sticky left-0 z-10 bg-white' : ''} ${c.className || ''}`}>
                        {c.render(r, ctx)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 px-4 py-2.5 text-xs text-slate-500">
            <div className="flex items-center gap-2">
              <span>Mostrando <b className="tabular-nums text-slate-700">{fmtInt(from)}–{fmtInt(to)}</b> de <b className="tabular-nums text-slate-700">{fmtInt(total)}</b></span>
              <label className="flex items-center gap-1">
                <span className="sr-only">Filas por página</span>
                <select value={pageSize} onChange={e => { setPageSize(Number(e.target.value)); setPage(0) }}
                  className="h-7 rounded-md border border-slate-200 bg-white px-1.5 text-xs">
                  {PAGE_SIZES.map(s => <option key={s} value={s}>{s} por página</option>)}
                </select>
              </label>
            </div>
            <div className="flex items-center gap-1">
              <button type="button" aria-label="Página anterior" disabled={page === 0 || loading} onClick={() => setPage(page - 1)}
                className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 hover:bg-slate-50 disabled:opacity-40">
                <ChevronLeft className="h-4 w-4" />
              </button>
              <span className="px-2 tabular-nums">Página {page + 1} de {pages}</span>
              <button type="button" aria-label="Página siguiente" disabled={page + 1 >= pages || loading} onClick={() => setPage(page + 1)}
                className="flex h-7 w-7 items-center justify-center rounded-md border border-slate-200 hover:bg-slate-50 disabled:opacity-40">
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>
          </footer>
        </section>
      )}
      <p className="text-[11px] text-slate-400">
        Fondo graduado en Saldo TN y TN×Días: percentil dentro de la página (ámbar → rojo = mayor prioridad de liberación).
        Días: verde ≤ 15, ámbar hasta {alert}, rojo sobre el plazo de alerta.
      </p>
    </div>
  )
}

function SortTh({ col, active, desc, onSort, first }: {
  col: Col<Row>; active: boolean; desc: boolean; onSort: (s: string) => void; first: boolean
}) {
  const align = col.align === 'right' ? 'justify-end text-right' : col.align === 'center' ? 'justify-center text-center' : 'justify-start text-left'
  const Icon = active ? (desc ? ArrowDown : ArrowUp) : ArrowUpDown
  return (
    <th scope="col" aria-sort={active ? (desc ? 'descending' : 'ascending') : undefined}
      className={`sticky top-0 whitespace-nowrap border-b border-slate-200 bg-slate-50 px-3 py-2 text-[10px] font-bold uppercase tracking-wider text-slate-500 ${
        first ? 'left-0 z-20' : 'z-10'}`}>
      {col.sort ? (
        <button type="button" onClick={() => onSort(col.sort!)}
          className={`flex w-full items-center gap-1 uppercase ${align} ${active ? 'text-[#002855]' : 'hover:text-slate-800'}`}>
          {col.label}
          <Icon className={`h-3 w-3 shrink-0 ${active ? '' : 'opacity-40'}`} />
        </button>
      ) : (
        <span className={`flex ${align}`}>{col.label}</span>
      )}
    </th>
  )
}
