"use client"
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { ArrowDownUp, Download, RefreshCw, Search } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { errorMessage, money } from '@/lib/caja'
import { ControlPresupuestalTabs } from '@/components/despacho/ControlPresupuestalTabs'
import { usePagination } from '@/lib/use-pagination'
import { DataTable } from '@/components/ui/data-table'
import { TablePagination } from '@/components/ui/table-pagination'

// Control presupuestal de transporte por OT: los saldos y niveles vienen del servidor.
// El corte temporal solo informa ejecutado con movimiento en el rango; los compromisos son vigentes, sin historia por fecha.
type Level = 'NORMAL' | 'ALERTA' | 'BLOQUEO' | 'EXCEDIDO' | 'SIN_PARTIDA'
type Position = {
  contract_id: string; code: string; client: string | null; type: string; status: string | null
  allocated_pen: number; reserved_pen: number; consumed_pen: number; used_pen: number; used_pct: number | null
  cap_pen: number; available_to_cap_pen: number; level: Level; operating_pct: number
  override: { pct: number; scope: string; until: string | null; reason: string | null } | null
  authorized_over_cap_pen?: number; pending_authorizations?: number
}
type Settings = { budget_alert_pct: number; budget_cap_pct: number }
type PeriodPosition = { contract_id: string; code: string; executed_pen: number; movement_count: number }
type SavingsSummary = { saving_total: number; validated_saving_total?: number; estimated_saving_total?: number; hours_cost_missing?: boolean | null; rows?: { contract_id: string | null; contract_code: string | null; root_code: string | null; client: string | null; dispatch_number: string; request_number: string; principal: boolean; state: string; valuation_status?: string; saving_pen: number | null }[] }
type SortKey = 'code' | 'client' | 'allocated_pen' | 'cap_pen' | 'consumed_pen' | 'reserved_pen' | 'available_to_cap_pen' | 'used_pct' | 'level'

const supabase = createClient()
const LEVEL: Record<Level, { label: string; cls: string }> = {
  NORMAL: { label: 'Normal', cls: 'bg-slate-100 text-slate-700' },
  ALERTA: { label: 'Alerta', cls: 'bg-amber-100 text-amber-900' },
  BLOQUEO: { label: 'Sobre el tope', cls: 'bg-orange-100 text-orange-900' },
  EXCEDIDO: { label: 'Excedido', cls: 'bg-red-100 text-red-800' },
  SIN_PARTIDA: { label: 'Sin partida', cls: 'bg-slate-100 text-slate-600' },
}
const LEVEL_ORDER: Record<Level, number> = { NORMAL: 0, ALERTA: 1, BLOQUEO: 2, EXCEDIDO: 3, SIN_PARTIDA: 4 }
const limaDate = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const firstDay = (day: string) => `${day.slice(0, 7)}-01`
const field = 'h-9 rounded-md border border-slate-300 bg-white px-2.5 text-sm text-slate-800 outline-none focus:border-[#002855] focus:ring-1 focus:ring-[#002855]'
const cell = 'px-2.5 py-2 text-right tabular-nums'

function exportCsv(rows: Position[], periodRows: PeriodPosition[], from: string, to: string) {
  const byOt = new Map(periodRows.map(r => [r.contract_id, Number(r.executed_pen)]))
  const head = ['OT', 'Cliente', 'Presupuesto vigente S/', 'Límite operativo S/', 'Ejecutado acumulado S/', `Ejecutado ${from} a ${to} S/`, 'Comprometido vigente S/', 'Consumo total S/', 'Consumo %', 'Disponible hasta el límite S/', 'Nivel']
  const quote = (v: unknown) => `"${String(v ?? '').replace(/"/g, '""')}"`
  const lines = rows.map(r => [r.code, r.client, r.allocated_pen, r.cap_pen, r.consumed_pen, byOt.get(r.contract_id) ?? 0, r.reserved_pen,
    r.used_pen, r.used_pct, r.available_to_cap_pen, LEVEL[r.level].label].map(quote).join(','))
  const url = URL.createObjectURL(new Blob(['\ufeff' + [head.map(quote).join(','), ...lines].join('\n')], { type: 'text/csv;charset=utf-8' }))
  const a = document.createElement('a'); a.href = url; a.download = `control-presupuestal-360-${limaDate()}.csv`; a.click(); URL.revokeObjectURL(url)
}

export default function ControlPresupuestalPage() {
  const today = useMemo(() => limaDate(), [])
  const [from, setFrom] = useState(() => firstDay(limaDate()))
  const [to, setTo] = useState(today)
  const [rows, setRows] = useState<Position[] | null>(null)
  const [periodRows, setPeriodRows] = useState<PeriodPosition[]>([])
  const [periodExecuted, setPeriodExecuted] = useState<number | null>(null)
  const [savings, setSavings] = useState<SavingsSummary | null>(null)
  const [settings, setSettings] = useState<Settings>({ budget_alert_pct: 70, budget_cap_pct: 80 })
  const [level, setLevel] = useState<Level | ''>('')
  const [q, setQ] = useState('')
  const [sort, setSort] = useState<{ key: SortKey; direction: 'asc' | 'desc' }>({ key: 'used_pct', direction: 'desc' })
  const [loading, setLoading] = useState(false)
  const router = useRouter()

  const load = useCallback(async () => {
    const start = Date.parse(`${from}T00:00:00Z`), end = Date.parse(`${to}T00:00:00Z`)
    if (!from || !to || !Number.isFinite(start) || !Number.isFinite(end) || end < start || (end - start) / 86400000 > 366) {
      toast.error('Seleccione un período válido de hasta 366 días'); return
    }
    setLoading(true)
    const [positionResult, periodResult, savingsResult] = await Promise.all([
      supabase.rpc('budget_positions'),
      supabase.rpc('budget_portfolio_period', { p_from: from, p_to: to }),
      supabase.rpc('consolidation_savings_classified', { p_from: from, p_to: to }),
    ])
    setLoading(false)
    if (positionResult.error || !positionResult.data?.success) {
      toast.error(positionResult.error ? errorMessage(positionResult.error) : positionResult.data?.error); setRows([]); return
    }
    setRows(positionResult.data.rows as Position[])
    if (positionResult.data.settings) setSettings(positionResult.data.settings as Settings)
    if (periodResult.error || !periodResult.data?.success) {
      setPeriodRows([]); setPeriodExecuted(null)
      toast.error(periodResult.error ? errorMessage(periodResult.error) : periodResult.data?.error)
    } else {
      setPeriodRows(periodResult.data.rows as PeriodPosition[])
      setPeriodExecuted(Number(periodResult.data.executed_total_pen ?? 0))
    }
    if (savingsResult.error || !savingsResult.data?.success) {
      setSavings(null)
      toast.error(savingsResult.error ? errorMessage(savingsResult.error) : savingsResult.data?.error)
    } else setSavings(savingsResult.data as SavingsSummary)
  }, [from, to])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])

  const searched = useMemo(() => (rows || []).filter(r => !q.trim() || `${r.code} ${r.client || ''}`.toLowerCase().includes(q.trim().toLowerCase())), [rows, q])
  const shown = useMemo(() => {
    const filtered = searched.filter(r => !level || r.level === level)
    return filtered.sort((a, b) => {
      let result: number
      if (sort.key === 'level') result = LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level]
      else if (sort.key === 'code' || sort.key === 'client') result = String(a[sort.key] || '').localeCompare(String(b[sort.key] || ''), 'es', { numeric: true, sensitivity: 'base' })
      else result = Number(a[sort.key] ?? -1) - Number(b[sort.key] ?? -1)
      return result * (sort.direction === 'asc' ? 1 : -1)
    })
  }, [searched, level, sort])
  const pg = usePagination(shown, "control-presupuestal")
  const byOt = useMemo(() => new Map(periodRows.map(r => [r.contract_id, Number(r.executed_pen)])), [periodRows])
  const filteredSaving = useMemo(() => {
    if (!savings?.rows) return savings?.saving_total ?? null
    return savings.rows.filter(r => {
      const matchesSearch = !q.trim() || `${r.dispatch_number} ${r.request_number} ${r.contract_code || ''} ${r.root_code || ''} ${r.client || ''}`.toLowerCase().includes(q.trim().toLowerCase())
      const matchesLevel = !level || (r.contract_id != null && searched.some(position => position.contract_id === r.contract_id && position.level === level))
      return matchesSearch && matchesLevel && !r.principal && r.valuation_status === 'VALIDADO'
    }).reduce((total, row) => total + Number(row.saving_pen || 0), 0)
  }, [savings, q, level, searched])
  const sum = (key: 'allocated_pen' | 'cap_pen' | 'reserved_pen' | 'consumed_pen' | 'used_pen' | 'available_to_cap_pen') => shown.reduce((n, r) => n + Number(r[key] || 0), 0)
  const count = (l: Level) => searched.filter(r => r.level === l).length
  const toggle = (l: Level) => setLevel(cur => cur === l ? '' : l)
  const changeSort = (key: SortKey) => setSort(cur => ({ key, direction: cur.key === key && cur.direction === 'asc' ? 'desc' : 'asc' }))
  const sortButton = (key: SortKey, label: string, right = false) => <button type="button" onClick={() => changeSort(key)} className={`inline-flex items-center gap-1 ${right ? 'justify-end' : ''} hover:text-[#002855]`}>{label}<ArrowDownUp aria-hidden className={`h-3 w-3 ${sort.key === key ? 'text-[#002855]' : 'text-slate-400'}`} /></button>

  const statusFilter = (key: Level | '', label: string, value: number, cls: string) => <button type="button" onClick={() => key ? toggle(key) : setLevel('')}
    aria-pressed={level === key} className={`min-w-0 border-b-2 px-2.5 py-2 text-left transition-colors ${level === key ? 'border-[#002855] bg-blue-50/60' : 'border-transparent hover:bg-slate-50'}`}>
    <span className="block truncate text-[11px] font-medium text-slate-500">{label}</span><span className={`block text-lg font-semibold tabular-nums ${cls}`}>{rows === null ? '—' : value}</span></button>

  return <div className="min-w-0 space-y-3">
    <PageHeader showTitle title="Control presupuestal 360°" description={`Cartera financiera de transporte por OT · Alerta desde ${settings.budget_alert_pct} % · límite operativo ${settings.budget_cap_pct} %`}
      actions={<><button type="button" onClick={() => void load()} disabled={loading} className="flex h-9 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm hover:bg-slate-50 disabled:opacity-50"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Actualizar</button>
        <button type="button" disabled={!shown.length} onClick={() => exportCsv(shown, periodRows, from, to)} className="flex h-9 items-center gap-2 rounded-md border border-slate-300 bg-white px-3 text-sm hover:bg-slate-50 disabled:opacity-50"><Download className="h-4 w-4" />Exportar</button></>} />
    <ControlPresupuestalTabs active="ot" />

    <section aria-label="Indicadores de cartera" className="grid grid-cols-2 divide-x divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white sm:grid-cols-3 sm:divide-y-0 lg:grid-cols-6">
      {statusFilter('', 'OT monitoreadas', searched.length, 'text-slate-900')}
      {statusFilter('NORMAL', `Normales · < ${settings.budget_alert_pct} %`, count('NORMAL'), 'text-slate-900')}
      {statusFilter('ALERTA', `En alerta · ${settings.budget_alert_pct}–${settings.budget_cap_pct} %`, count('ALERTA'), 'text-amber-800')}
      {statusFilter('BLOQUEO', `Sobre el límite · > ${settings.budget_cap_pct}–100 %`, count('BLOQUEO'), 'text-orange-800')}
      {statusFilter('EXCEDIDO', 'Presupuesto excedido · > 100 %', count('EXCEDIDO'), 'text-red-700')}
      <button type="button" onClick={() => router.push('/despacho/control-presupuestal/ahorro')} className="min-w-0 border-b-2 border-transparent px-2.5 py-2 text-left hover:bg-slate-50">
        <span className="block truncate text-[11px] font-medium text-slate-500">Ahorro validado · período</span><span className="block truncate text-lg font-semibold tabular-nums text-emerald-800">{filteredSaving == null ? '—' : `${money(Number(filteredSaving))}`}</span></button>
    </section>

    <section aria-label="Resumen monetario" className="grid grid-cols-2 gap-x-4 gap-y-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 sm:grid-cols-3 lg:grid-cols-6">
      {[
        ['Presupuesto vigente', sum('allocated_pen')], ['Límite operativo', sum('cap_pen')], ['Ejecutado acumulado', sum('consumed_pen')],
        ['Comprometido vigente', sum('reserved_pen')], ['Disponible hasta el límite', sum('available_to_cap_pen')],
      ].map(([label, value]) => <div key={String(label)} className="min-w-0"><p className="truncate text-[10px] font-medium text-slate-500">{label}</p><p className="truncate text-sm font-semibold tabular-nums text-slate-900">{money(Number(value))}</p></div>)}
      <div className="min-w-0"><p className="truncate text-[10px] font-medium text-slate-500">Ejecutado en período</p><p className="truncate text-sm font-semibold tabular-nums text-slate-900">{periodExecuted == null ? '—' : `${money(shown.reduce((total, row) => total + (byOt.get(row.contract_id) || 0), 0))}`}</p></div>
    </section>

    <div className="flex flex-wrap items-end gap-2 rounded-lg border border-slate-200 bg-white p-2.5">
      <label className="relative min-w-52 flex-1 sm:max-w-sm"><span className="sr-only">Buscar OT o cliente</span><Search aria-hidden className="absolute left-2.5 top-2.5 h-4 w-4 text-slate-400" />
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Buscar OT o cliente…" className={`${field} w-full pl-8`} /></label>
      <label className="text-[10px] font-semibold text-slate-500">Desde<input type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} className={`${field} mt-0.5 block`} /></label>
      <label className="text-[10px] font-semibold text-slate-500">Hasta<input type="date" value={to} min={from || undefined} max={today} onChange={e => setTo(e.target.value)} className={`${field} mt-0.5 block`} /></label>
      <label className="text-[10px] font-semibold text-slate-500">Estado presupuestal<select value={level} onChange={e => setLevel(e.target.value as Level | '')} className={`${field} mt-0.5 block`}>
        <option value="">Todos los estados</option>{Object.entries(LEVEL).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}</select></label>
      <span className="pb-1 text-[10px] text-slate-500">El período filtra ejecutado con movimiento y ahorro. El comprometido, asignado y disponible son vigentes.</span>
    </div>

    {savings?.hours_cost_missing && <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">El ahorro excluye servicios con costo por hora pendiente; revisa la pestaña «Ahorro por consolidación» para ver la cobertura y completarlos.</p>}

    <section aria-label="Cartera financiera de órdenes de trabajo" className="overflow-hidden rounded-lg border border-slate-200 bg-white">
      <div className="flex items-center justify-between border-b border-slate-200 px-3 py-2"><div><h2 className="text-sm font-semibold text-slate-900">Cartera de OT</h2><p className="text-[10px] text-slate-500">Importes en soles · consumo = ejecutado acumulado + comprometido vigente</p></div><span className="text-xs tabular-nums text-slate-500">{shown.length} de {searched.length}</span></div>
      {rows === null ? <p className="p-8 text-center text-sm text-slate-500">Cargando cartera…</p> : !shown.length ? <p className="p-8 text-center text-sm text-slate-500">No hay OT para los filtros seleccionados.</p> : <>
        <div className="space-y-2 p-2 lg:hidden">{pg.pageRows.map(r => <article key={r.contract_id} className="rounded-md border border-slate-200 p-2.5">
          <div className="flex items-start justify-between gap-3"><div className="min-w-0"><Link href={`/despacho/control-presupuestal/${r.contract_id}`} className="font-semibold text-[#002855] underline">{r.code}</Link><p className="truncate text-xs text-slate-600">{r.client || 'Sin cliente'}</p></div><span className={`shrink-0 rounded px-2 py-0.5 text-[10px] font-semibold ${LEVEL[r.level].cls}`}>{LEVEL[r.level].label}</span></div>
          <div className="mt-2 grid grid-cols-2 gap-x-3 gap-y-1 text-xs sm:grid-cols-3"><span className="text-slate-500">Presupuesto <b className="float-right text-slate-800">{money(Number(r.allocated_pen))}</b></span><span className="text-slate-500">Límite <b className="float-right text-slate-800">{money(Number(r.cap_pen))}</b></span>
            <span className="text-slate-500">Ejecutado <b className="float-right text-slate-800">{money(Number(r.consumed_pen))}</b></span><span className="text-slate-500">Comprometido <b className="float-right text-slate-800">{money(Number(r.reserved_pen))}</b></span>
            <span className="text-slate-500">Disponible al límite <b className={`float-right ${Number(r.available_to_cap_pen) < 0 ? 'text-red-700' : 'text-slate-800'}`}>{money(Number(r.available_to_cap_pen))}</b></span><span className="text-slate-500">Consumo <b className="float-right text-slate-800">{r.used_pct == null ? '—' : `${r.used_pct} %`}</b></span></div>
          {['ALERTA', 'BLOQUEO'].includes(r.level) && <Link href={`/despacho/control-presupuestal/pendientes?solicitar=${r.contract_id}&codigo=${encodeURIComponent(r.code)}`} className="mt-2 inline-block text-xs font-semibold text-[#002855] underline">Solicitar autorización</Link>}
        </article>)}</div>
        <div className="hidden overflow-x-auto lg:block"><DataTable dense sortable={false} className="w-full table-fixed text-xs">
          <colgroup><col className="w-[8%]"/><col className="w-[16%]"/><col className="w-[10%]"/><col className="w-[10%]"/><col className="w-[9%]"/><col className="w-[10%]"/><col className="w-[11%]"/><col className="w-[8%]"/><col className="w-[9%]"/><col className="w-[9%]"/></colgroup>
          <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500"><tr>
            <th className="px-2.5 py-2 text-left">{sortButton('code', 'OT')}</th><th className="px-2.5 py-2 text-left">{sortButton('client', 'Cliente')}</th>
            <th className={`${cell} whitespace-nowrap`}>{sortButton('allocated_pen', 'Presupuesto', true)}</th><th className={`${cell} whitespace-nowrap`}>{sortButton('cap_pen', 'Límite 80 %', true)}</th>
            <th className={`${cell} whitespace-nowrap`}>{sortButton('consumed_pen', 'Ejecutado', true)}</th><th className={`${cell} whitespace-nowrap`}>{sortButton('reserved_pen', 'Comprometido', true)}</th>
            <th className={`${cell} whitespace-nowrap`}>{sortButton('available_to_cap_pen', 'Disponible al límite', true)}</th><th className={`${cell} whitespace-nowrap`}>{sortButton('used_pct', 'Consumo', true)}</th>
            <th className="px-2.5 py-2 text-left">{sortButton('level', 'Riesgo')}</th><th className="px-2.5 py-2 text-right">Análisis</th>
          </tr></thead><tbody className="divide-y divide-slate-100">{pg.pageRows.map(r => <tr key={r.contract_id} className="hover:bg-slate-50">
            <td className="px-2.5 py-2"><Link href={`/despacho/control-presupuestal/${r.contract_id}`} className="font-semibold text-[#002855] underline">{r.code}</Link>{r.override && <span title={r.override.reason || undefined} className="block truncate text-[9px] text-slate-500">Margen pactado {r.override.pct} %</span>}</td>
            <td className="px-2.5 py-2"><span className="block truncate" title={r.client || undefined}>{r.client || '—'}</span></td>
            <td className={cell}>{money(Number(r.allocated_pen))}</td><td className={cell}>{money(Number(r.cap_pen))}</td>
            <td className={cell}><Link href={`/despacho/control-presupuestal/movimientos?ot=${r.contract_id}&efecto=EJECUTADO`} className="underline decoration-dotted">{money(Number(r.consumed_pen))}</Link></td>
            <td className={cell}><Link href={`/despacho/control-presupuestal/movimientos?ot=${r.contract_id}&efecto=COMPROMETIDO`} className="underline decoration-dotted">{money(Number(r.reserved_pen))}</Link></td>
            <td className={`${cell} ${Number(r.available_to_cap_pen) < 0 ? 'font-semibold text-red-700' : ''}`}>{money(Number(r.available_to_cap_pen))}</td>
            <td className={cell}>{r.used_pct == null ? '—' : `${r.used_pct} %`}</td><td className="px-2.5 py-2"><span className={`whitespace-nowrap rounded px-1.5 py-0.5 text-[10px] font-semibold ${LEVEL[r.level].cls}`}>{LEVEL[r.level].label}</span>
              {Number(r.authorized_over_cap_pen) > 0 && <span className="mt-1 block text-[9px] text-slate-500">Autorizado {money(Number(r.authorized_over_cap_pen))}</span>}{Number(r.pending_authorizations) > 0 && <Link href="/despacho/control-presupuestal/pendientes" className="mt-1 block text-[9px] font-semibold text-amber-800 underline">{r.pending_authorizations} pendiente(s)</Link>}</td>
            <td className="px-2.5 py-2 text-right"><Link href={`/despacho/control-presupuestal/${r.contract_id}`} className="font-semibold text-[#002855] underline">Analizar</Link>
              {['ALERTA', 'BLOQUEO'].includes(r.level) && <Link href={`/despacho/control-presupuestal/pendientes?solicitar=${r.contract_id}&codigo=${encodeURIComponent(r.code)}`} className="mt-1 block text-[9px] text-slate-600 underline">Autorizar</Link>}</td>
          </tr>)}</tbody></DataTable></div>
        <TablePagination total={pg.total} page={pg.page} pageSize={pg.pageSize} onPageChange={pg.setPage} onPageSizeChange={pg.setPageSize} itemLabel="OT" compact />
      </>}
    </section>
    <p className="text-[10px] leading-4 text-slate-500">El límite operativo protege el margen de la partida; superarlo no significa que el presupuesto total se haya agotado. “Ejecutado en período” suma movimientos con fecha en el rango y sustento en las fuentes existentes; “ejecutado acumulado” refleja la posición registrada. El responsable de OT no se filtra porque la partida no tiene un responsable asignado.</p>
  </div>
}
