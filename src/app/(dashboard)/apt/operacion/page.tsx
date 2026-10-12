'use client'

import { Suspense, useEffect, useState } from 'react'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, ClipboardCheck, RefreshCw } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { useOperationalFilters } from '@/lib/apt/useOperationalFilters'
import { StockObservationPanel } from '@/components/apt/operations/StockObservationPanel'
import { ReadinessEditor } from '@/components/apt/operations/ReadinessEditor'
import type { OperationalReadiness, OperationalSourceRow } from '@/lib/apt/operations'
import { cleanFilters } from '@/lib/apt/api'
import { useAptOperationalQuery } from '@/lib/apt/useAptOperationalQuery'
import type { AptOperationalFilters } from '@/lib/apt/types'
import { fmtDate, fmtDateTime, fmtDias, fmtInt, fmtTn } from '@/lib/apt/format'
import { OperationalReportButton } from '@/components/apt/reports/OperationalReportButton'
import { OperationsTable } from '@/components/apt/operations/OperationsTable'
import { OperationalFilterBar } from '@/components/apt/OperationalFilterBar'
import { ChartCard, ErrorBlock, KpiCard, LoadingBlock } from '@/components/apt/ui'
import { TablePagination } from '@/components/ui/table-pagination'

function OperationsPage() {
  const sp = useSearchParams(), router = useRouter(), pathname = usePathname()
  const { filters, filterKey: raw } = useOperationalFilters()
  const page = Math.max(1, Number.parseInt(sp.get('page') || '1', 10) || 1)
  const sizeRaw = Number.parseInt(sp.get('size') || '25', 10)
  const size = [25, 50, 100].includes(sizeRaw) ? sizeRaw : 25
  const query = useAptOperationalQuery(filters, raw, size, page)
  const key = query.key
  const navigate = (next: AptOperationalFilters, nextPage = 1, nextSize = size) => {
    const qs = new URLSearchParams(sp.toString()), cleaned = cleanFilters(next)
    if (Object.keys(cleaned).length) qs.set('of', JSON.stringify(cleaned)); else qs.delete('of')
    if (nextPage > 1) qs.set('page', String(nextPage)); else qs.delete('page')
    if (nextSize !== 25) qs.set('size', String(nextSize)); else qs.delete('size')
    router.replace(`${pathname}${qs.size ? `?${qs}` : ''}`, { scroll: false })
  }
  const d = query.data
  const [readiness, setReadiness] = useState<{ key: string; rows: OperationalReadiness[]; canEdit: boolean; error: string | null } | null>(null)
  const [editing, setEditing] = useState<{ key: string; row: OperationalSourceRow } | null>(null)
  useEffect(() => {
    if (!d || !query.usable || !key) return
    let active = true
    if (!d.meta.composition_available) return
    createClient().rpc('apt_readiness_list', { p_keys: d.rows.map(row => ({ almacen: row.almacen, lote: row.lote, producto: '*' })) }).then(({ data, error }) => {
      if (!active) return
      if (error || !data?.success) setReadiness({ key, rows: [], canEdit: false, error: error?.message || data?.error || 'No se pudieron consultar las revisiones.' })
      else setReadiness({ key, rows: data.rows, canEdit: data.can_edit, error: null })
    })
    return () => { active = false }
  }, [d, key, query.usable])
  const reviewed = readiness?.key === key ? readiness : null
  const editingKey = `${key}|${query.receivedAt}`
  const saveReadiness = async (value: Record<string, unknown>) => {
    if (!query.usable) throw new Error('Actualice la consulta antes de guardar una revisión.')
    const { data, error } = await createClient().rpc('apt_readiness_save', { p: value })
    if (error || !data?.success) throw new Error(error?.message || data?.error || 'No se pudo guardar.')
    query.refresh()
  }
  return <div className="space-y-4">
    <header className="flex flex-wrap items-start justify-between gap-3"><div><h2 className="flex items-center gap-2 text-xl font-bold text-[#002855]"><ClipboardCheck className="h-5 w-5" />Control operativo APT</h2><p className="mt-1 text-sm text-slate-500">Saldo por ubicación, calidad de información y próximas revisiones.</p></div><button onClick={query.refresh} disabled={query.loading || !query.authenticated} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 text-xs font-semibold text-[#002855] disabled:opacity-50"><RefreshCw className="h-4 w-4" />Actualizar</button></header>
    <OperationalFilterBar filters={filters} onApply={next => navigate(next)} cutoffLabel={d?.meta.cutoff || undefined} />
    {query.loading && !d && <div role="status" className="rounded-xl border border-slate-200 bg-white p-5"><p className="text-sm font-semibold text-[#002855]">{query.retrying ? 'La consulta está tardando. Reintentando una vez…' : 'Consultando saldos y calidad…'}</p><div aria-hidden="true" className="mt-4 grid animate-pulse gap-3 sm:grid-cols-4">{[1,2,3,4].map(item => <div key={item} className="h-20 rounded-lg bg-slate-100" />)}</div></div>}
    {!query.authenticated && <p role="status" className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">{query.sessionChecked ? 'La sesión no está disponible. Vuelva a iniciar sesión para consultar Control operativo APT.' : 'Verificando el acceso a Control operativo APT…'}</p>}
    {!!query.error && !d && <ErrorBlock message={query.error instanceof Error ? query.error.message : 'No se pudo consultar el control operativo.'} onRetry={query.refresh} />}
    {d && (query.loading || query.error) && <div role="status" className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900"><div><p className="font-semibold">{query.loading ? (query.retrying ? 'La actualización está tardando. Reintentando una vez…' : 'Actualizando la consulta…') : 'No se pudo actualizar la consulta.'}</p><p className="mt-1 text-xs">Última consulta: {fmtDateTime(new Date(query.receivedAt!).toISOString())}. Estas cifras aún no se han actualizado; las revisiones y los reportes están suspendidos.</p></div>{!query.loading && <button onClick={query.refresh} className="min-h-10 rounded-lg border border-amber-300 bg-white px-3 text-xs font-semibold">Volver a consultar</button>}</div>}
    {d && <>
      <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-600"><div className="flex flex-wrap gap-x-5 gap-y-1"><span><b>Corte:</b> {fmtDate(d.meta.cutoff)}</span><span><b>Último movimiento:</b> {fmtDate(d.meta.data_max)}</span><span><b>Cálculo:</b> {fmtDateTime(d.meta.flow_rebuilt_at)}</span><span><b>Fuente:</b> movimientos documentales</span></div><p className="mt-2 text-slate-500">El saldo reconstruido no certifica existencia física, autorización de salida ni entrega conforme. La antigüedad no determina disponibilidad.</p></div>
      {!d.meta.model_fresh && <div role="alert" className="flex gap-2 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" /><p>Hay movimientos pendientes de incorporar al cálculo. Revise Cargas y parámetros antes de tomar decisiones con estas cifras.</p></div>}
      {(d.quality.missing_weight_rows > 0 || d.quality.temporal_anomaly_rows > 0 || d.quality.negative_balance_rows > 0) && <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-900"><b>Calidad del alcance:</b> {fmtInt(d.quality.missing_weight_rows)} filas sin peso · {fmtInt(d.quality.temporal_anomaly_rows)} anomalías temporales · {fmtInt(d.quality.negative_balance_rows)} saldos negativos. Revise el detalle de calidad; estas excepciones no equivalen a bloqueos operativos registrados.</div>}
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4"><KpiCard label="Saldo documental" value={fmtTn(d.kpis.stock_tn)} unit="TN" hint="Todo el alcance seleccionado" /><KpiCard label="Saldo de apertura inferido" value={d.kpis.inferred_opening_tn === null ? 'No evaluable' : fmtTn(d.kpis.inferred_opening_tn)} unit={d.kpis.inferred_opening_tn === null ? undefined : 'TN'} tone="warn" hint="Requiere conciliación con ERP" /><KpiCard label="Antigüedad ponderada" value={fmtDias(d.kpis.weighted_age_days)} hint="Del saldo con origen conocido" /><KpiCard label="Lote / ubicación" value={fmtInt(d.total)} hint="Registros de saldo; un lote puede ocupar varias ubicaciones" /></div>
      <ChartCard title="Revisiones por lote y ubicación" subtitle="El orden refleja el saldo del modelo. No constituye una autorización ni una prioridad de despacho." actions={query.usable ? <OperationalReportButton summary={d} filters={filters} disabled={!d.meta.model_fresh} /> : <button disabled className="min-h-11 rounded-xl border border-slate-200 px-4 text-sm text-slate-400">Reporte · esperando actualización</button>} bodyClassName="!p-0">
        {reviewed?.error && <p role="alert" className="p-3 text-xs text-red-700">{reviewed.error}</p>}
        {!d.meta.composition_available && <p className="p-3 text-xs text-slate-500">Corte histórico: las revisiones actuales de disponibilidad no se muestran sobre saldos anteriores.</p>}
        <OperationsTable rows={d.rows} fresh={d.meta.model_fresh} cutoff={d.meta.cutoff} alertDays={d.meta.alert_days} rebuiltAt={d.meta.flow_rebuilt_at} readiness={reviewed?.rows} canEdit={query.usable && !!reviewed?.canEdit && d.meta.model_fresh && d.meta.composition_available} onEdit={row => setEditing({ key: editingKey, row })} />
        <TablePagination total={d.total} page={page} pageSize={size} onPageChange={next => navigate(filters, next)} onPageSizeChange={next => navigate(filters, 1, next)} itemLabel="registros lote / ubicación" compact />
      </ChartCard>
      {(filters.ot || filters.clientes?.length) && <p className="text-xs text-slate-500">La conciliación inferior consulta observaciones por corte, almacén y lote exacto; los filtros de OT y cliente de la tabla superior no se aplican a esa muestra.</p>}
      <StockObservationPanel cutoff={d.meta.cutoff} almacen={filters.almacen} lote={filters.lote} canEdit={query.usable && !!reviewed?.canEdit && d.meta.model_fresh} />
    </>}
    {editing && editing.key === editingKey && query.usable && <ReadinessEditor key={`${editing.row.almacen}|${editing.row.lote}`} row={editing.row} current={reviewed?.rows.find(row => row.almacen === editing.row.almacen && row.lote === editing.row.lote)} onSave={saveReadiness} onClose={() => setEditing(null)} />}
  </div>
}

export default function AptOperationsPage() { return <Suspense fallback={<LoadingBlock />}><OperationsPage /></Suspense> }
