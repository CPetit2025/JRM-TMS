'use client'

import { Suspense, useEffect, useMemo, useState, type FormEvent } from 'react'
import Link from 'next/link'
import { usePathname, useRouter, useSearchParams } from 'next/navigation'
import { AlertTriangle, CalendarDays, Download, Filter, GitBranch, Printer, RefreshCw, Search } from 'lucide-react'
import { aptApi, cleanFilters, flowApi, clearAptCache } from '@/lib/apt/api'
import type { GanttFilters, GanttResult, GanttRow } from '@/lib/apt/ganttTypes'
import type { FlowAlmacen, FlowTraceLote } from '@/lib/apt/flowTypes'
import { fmtDate, fmtDateTime, fmtDias, fmtInt, fmtTn } from '@/lib/apt/format'
import { ALMACEN_COLOR, FLOW_ALMACENES } from '@/lib/apt/flowColors'
import { exportAptXlsx } from '@/lib/apt/export'
import { traceHref } from '@/lib/apt/useFlowFilters'
import { ChartCard, EmptyState, ErrorBlock, KpiCard, LoadingBlock } from '@/components/apt/ui'
import { DataTable } from '@/components/ui/data-table'
import { GanttTimeline, STATE_LABEL, type GanttScale } from '@/components/apt/gantt/Timeline'
import { LotDetail } from '@/components/apt/gantt/LotDetail'

const PAGE_SIZE = 25
const INPUT = 'mt-1 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs text-slate-800 outline-none focus:border-[#002855] focus:ring-2 focus:ring-[#002855]/10'

function readFilters(raw: string | null): GanttFilters {
  try { const data: unknown = JSON.parse(raw || '{}'); return data && typeof data === 'object' && !Array.isArray(data) ? data as GanttFilters : {} } catch { return {} }
}

function Filters({ initial, onApply }: { initial: GanttFilters; onApply: (f: GanttFilters) => void }) {
  const [draft, setDraft] = useState(initial)
  const [error, setError] = useState<string | null>(null)
  const [advanced, setAdvanced] = useState(!!(initial.desde || initial.hasta || initial.solo_criticos))
  const field = (key: 'ot' | 'lote' | 'cliente' | 'desde' | 'hasta' | 'corte', label: string, type = 'text', placeholder = '') => <label className="min-w-0 text-[10px] font-bold uppercase tracking-wide text-slate-500">{label}<input type={type} value={draft[key] || ''} placeholder={placeholder} className={INPUT} onChange={e => setDraft({ ...draft, [key]: e.target.value })} /></label>
  const submit = (e: FormEvent) => { e.preventDefault(); if (draft.desde && draft.hasta && draft.desde > draft.hasta) { setError('La fecha inicial debe ser anterior o igual a la final.'); return } if (draft.corte && draft.desde && draft.desde > draft.corte) { setError('El inicio del período no puede ser posterior al corte.'); return } setError(null); onApply(cleanFilters(draft)) }
  return <form onSubmit={submit} className="gantt-no-print rounded-xl border border-slate-200 bg-white p-3 shadow-sm">
    <div className="grid items-end gap-2 sm:grid-cols-3 xl:grid-cols-[0.7fr_0.9fr_1.1fr_0.9fr_1fr_1fr_auto]">
      {field('ot', 'OT madre', 'text', 'Ej. 16339')}{field('lote', 'Lote / NumRel', 'text', 'Buscar lote')}{field('cliente', 'Cliente', 'text', 'Nombre del cliente')}
      <label className="min-w-0 text-[10px] font-bold uppercase tracking-wide text-slate-500">Almacén<select value={draft.almacen || ''} className={INPUT} onChange={e => setDraft({ ...draft, almacen: e.target.value as FlowAlmacen || undefined })}><option value="">Todos</option>{FLOW_ALMACENES.map(a => <option key={a} value={a}>{a === 'ST' ? 'ST VENTAS' : a}</option>)}</select></label>
      <label className="min-w-0 text-[10px] font-bold uppercase tracking-wide text-slate-500">Estado<select value={draft.estado || ''} className={INPUT} onChange={e => setDraft({ ...draft, estado: e.target.value as GanttFilters['estado'] || undefined })}><option value="">Todos</option>{Object.entries(STATE_LABEL).map(([key, value]) => <option key={key} value={key}>{value}</option>)}</select></label>
      {field('corte', 'Fecha de corte', 'date')}
      <div className="flex items-end gap-1"><button type="submit" className="inline-flex items-center gap-1 rounded-lg bg-[#002855] px-3 py-2 text-xs font-bold text-white hover:bg-[#001a3a]"><Search className="h-3.5 w-3.5" />Aplicar</button><button type="button" onClick={() => { setDraft({}); setError(null); setAdvanced(false); onApply({}) }} className="rounded-lg border border-slate-200 px-2 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50">Limpiar</button></div>
    </div>
    <div className="mt-2 flex justify-end"><button type="button" aria-expanded={advanced} aria-controls="gantt-advanced-filters" onClick={() => setAdvanced(v => !v)} className="inline-flex items-center gap-1 text-[10px] font-bold text-[#002855] hover:underline"><Filter className="h-3 w-3" />{advanced ? 'Menos filtros' : 'Más filtros'}{!advanced && (draft.desde || draft.hasta || draft.solo_criticos) ? ' · activos' : ''}</button></div>
    {advanced && <div id="gantt-advanced-filters" className="mt-2 border-t border-slate-100 pt-3"><div className="grid gap-3 sm:grid-cols-3">
      {field('desde', 'Ventana desde', 'date')}{field('hasta', 'Ventana hasta', 'date')}
      <label className="flex items-center gap-2 self-end rounded-lg border border-slate-200 px-3 py-2 text-xs text-slate-600"><input type="checkbox" checked={!!draft.solo_criticos} onChange={e => setDraft({ ...draft, solo_criticos: e.target.checked })} />Solo permanencia crítica</label>
    </div><p className="mt-2 text-[10px] text-slate-500">La ventana selecciona recorridos que se superponen al período. Los saldos se calculan hasta el corte; el filtro de almacén selecciona lotes con paso por esa etapa y conserva su recorrido completo.</p></div>}

    {error && <p role="alert" className="mt-2 text-xs text-red-700">{error}</p>}
  </form>
}

function GanttPage() {
  const sp = useSearchParams(), router = useRouter(), pathname = usePathname()
  const raw = sp.get('g') || '', filters = useMemo(() => readFilters(raw), [raw])
  const page = Math.max(0, Number.parseInt(sp.get('pg') || '0', 10) || 0)
  const [nonce, setNonce] = useState(0), [scale, setScale] = useState<GanttScale>('semana')
  const [expanded, setExpanded] = useState<Set<string> | null>(null)
  const [selection, setSelection] = useState<{ key: string; row: GanttRow } | null>(null)
  const reqKey = `${raw}|${page}|${nonce}`
  const [res, setRes] = useState<{ key: string; data: GanttResult | null; error: string | null } | null>(null)
  const [detail, setDetail] = useState<{ key: string; data: GanttResult | null; error: string | null; trace: FlowTraceLote | null; traceError: string | null } | null>(null)
  useEffect(() => {
    let alive = true
    aptApi.gantt(filters, PAGE_SIZE, page * PAGE_SIZE).then(data => { if (alive) setRes({ key: reqKey, data, error: null }) }).catch((e: unknown) => { if (alive) setRes({ key: reqKey, data: null, error: e instanceof Error ? e.message : 'No se pudo obtener la trazabilidad.' }) })
    return () => { alive = false }
  }, [filters, page, reqKey])
  useEffect(() => { const refresh = () => setNonce(n => n + 1); window.addEventListener('apt:updated', refresh); return () => window.removeEventListener('apt:updated', refresh) }, [])
  const selected = selection?.key === reqKey ? selection.row : null
  const detailKey = selected ? `${reqKey}|${selected.lote}` : ''
  useEffect(() => {
    if (!selected) return
    let alive = true
    Promise.allSettled([aptApi.gantt({ ...filters, lote_exacto: selected.lote }, 1, 0), flowApi.trace(selected.lote)]).then(([stock, trace]) => {
      if (!alive) return
      setDetail({ key: detailKey, data: stock.status === 'fulfilled' ? stock.value : null, error: stock.status === 'rejected' ? String(stock.reason instanceof Error ? stock.reason.message : stock.reason) : null, trace: trace.status === 'fulfilled' && trace.value.modo === 'lote' ? trace.value : null, traceError: trace.status === 'rejected' ? 'No fue posible consultar las guías vinculadas al TMS.' : trace.status === 'fulfilled' && trace.value.modo !== 'lote' ? 'No hay una ficha exacta para este lote.' : null })
    })
    return () => { alive = false }
  }, [selected, filters, detailKey])
  const navigate = (f: GanttFilters, pg = 0) => { const qs = new URLSearchParams(sp.toString()); const clean = cleanFilters(f); if (Object.keys(clean).length) qs.set('g', JSON.stringify(clean)); else qs.delete('g'); if (pg) qs.set('pg', String(pg)); else qs.delete('pg'); router.replace(`${pathname}${qs.size ? `?${qs}` : ''}`, { scroll: false }) }
  const current = res?.key === reqKey ? res : null, d = current?.data, dt = detail?.key === detailKey ? detail : null
  const toggle = (ot: string) => setExpanded(prev => { const next = new Set(prev || (d?.filas || []).map(r => r.ot ? `OT ${r.ot}` : 'Sin OT identificada')); if (next.has(ot)) next.delete(ot); else next.add(ot); return next })
  const select = (row: GanttRow) => { setSelection({ key: reqKey, row }); setTimeout(() => document.getElementById('gantt-lot-detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50) }
  const doExport = () => {
    if (!d) return
    exportAptXlsx(`APT_Gantt_${d.cutoff || 'sin_corte'}_pagina_${page + 1}`, {
      Alcance: [{ Corte: d.cutoff, 'Datos hasta': d.data_max, 'Último recálculo': d.rebuilt_at, Filtros: JSON.stringify(filters), 'Lotes filtrados': d.total, 'Lotes exportados': d.filas.length, Página: page + 1, 'Alcance de filas': 'Solo página consultada; indicadores del conjunto filtrado', 'Base de antigüedad': d.age_basis, 'Umbral días': d.alert_days }],
      Indicadores: [d.kpis],
      Lotes: d.filas.map(r => ({ OT: r.ot, Lote: r.lote, Cliente: r.cliente, 'Entradas externas TN': r.ingresadas_tn, 'Stock previo TN': r.inicial_tn, 'Asignadas TN': r.asignadas_tn, 'Cedidas TN': r.cedidas_tn, 'Despachadas TN': r.despachadas_tn, 'Otras salidas TN': r.otras_salidas_tn, 'Saldo TN': r.saldo_tn, 'Saldo sin fecha TN': r.saldo_sin_fecha_tn, 'Antigüedad ponderada': r.edad_ponderada, Estado: STATE_LABEL[r.estado], 'TN×días saldo': r.tn_dias, 'Inicio conocido': r.primera_fecha, 'Entrega ERP desde': r.fecha_entrega_min, 'Entrega ERP hasta': r.fecha_entrega_max })),
      Etapas: d.filas.flatMap(r => r.segmentos.map(s => ({ Lote: r.lote, ...s }))),
      Eventos: d.filas.flatMap(r => r.eventos.map(e => ({ Lote: r.lote, ...e }))),
      Prioridades: d.prioridades.map(r => ({ ...r })),
    })
  }
  const start = d?.desde || d?.data_min, end = d?.hasta || d?.cutoff
  return <div id="apt-gantt-report" className="space-y-4">
    <style>{`@media print { body * { visibility: hidden; } #apt-gantt-report, #apt-gantt-report * { visibility: visible; } #apt-gantt-report { position: absolute; left: 0; top: 0; width: 100%; } #apt-gantt-report .gantt-no-print, #apt-gantt-report .gantt-no-print * { display: none !important; } #apt-gantt-report section { break-inside: auto; } #apt-gantt-report .gantt-scroll { max-height: none !important; overflow: visible !important; } @page { size: A3 landscape; margin: 12mm; } }`}</style>
    <header className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div><p className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-widest text-[#cf152d]"><GitBranch className="h-3.5 w-3.5" />JRM · Analítica SCM</p><h1 className="mt-1 text-xl font-black text-[#002855]">Trazabilidad de OT y lotes</h1><p className="mt-1 text-xs text-slate-500">Tiempo, toneladas y permanencia · desde el ingreso registrado hasta la salida del material.</p></div>
      <div className="gantt-no-print flex flex-wrap gap-2"><button type="button" onClick={() => { clearAptCache(); setNonce(n => n + 1) }} className="rounded-lg border border-slate-200 p-2.5 text-slate-500 hover:bg-slate-50" aria-label="Actualizar consulta"><RefreshCw className="h-4 w-4" /></button><button type="button" onClick={doExport} disabled={!d} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-[#002855] disabled:opacity-40"><Download className="h-4 w-4" />Excel · página</button><button type="button" onClick={() => window.print()} disabled={!d} className="inline-flex items-center gap-2 rounded-lg border border-slate-200 px-3 py-2 text-xs font-bold text-[#002855] disabled:opacity-40"><Printer className="h-4 w-4" />Imprimir / PDF</button></div>
    </header>
    <Filters key={raw} initial={filters} onApply={f => navigate(f)} />
    {!current ? <LoadingBlock label="Consultando recorridos y saldos…" /> : current.error ? <ErrorBlock message={current.error} onRetry={() => setNonce(n => n + 1)} /> : d && <>
      <div className="flex flex-wrap gap-x-5 gap-y-2 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-[11px] text-slate-600"><span className="flex items-center gap-1 font-bold text-[#002855]"><CalendarDays className="h-3.5 w-3.5" />Corte efectivo: {fmtDate(d.cutoff)}</span><span>Datos: {fmtDate(d.data_min)} – {fmtDate(d.data_max)}</span><span>Recálculo: {fmtDateTime(d.rebuilt_at)}</span><span>Alerta: ≥ {d.alert_days} días · <Link href="/apt/cargas" className="underline">Parámetros APT</Link></span></div>
      {d.requested_cutoff && d.requested_cutoff !== d.cutoff && <p className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800"><AlertTriangle className="h-4 w-4 shrink-0" />El corte solicitado ({fmtDate(d.requested_cutoff)}) excede el alcance del modelo. Se utiliza {fmtDate(d.cutoff)}.</p>}
      {d.data_max && d.model_cutoff && d.data_max > d.model_cutoff && <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">Hay movimientos hasta {fmtDate(d.data_max)} posteriores al corte del modelo ({fmtDate(d.model_cutoff)}). Revise cargas y recálculo antes de interpretar el saldo como actualizado.</p>}
      {d.model_pending && <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">Hay una carga aplicada pendiente de recalcular{d.last_upload_at ? ` (${fmtDateTime(d.last_upload_at)})` : ''}. Los saldos corresponden al último modelo, recalculado el {fmtDateTime(d.rebuilt_at)}. <Link href="/apt/cargas" className="font-bold underline">Revisar recálculo</Link></p>}
      <p className="text-[10px] text-slate-500">Indicadores y saldos al corte {fmtDate(d.cutoff)} · ventana visual {fmtDate(d.desde)} – {fmtDate(d.hasta)}. La última fecha del gráfico puede ser anterior al corte.</p>
      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
        <KpiCard label="TN pendientes" value={fmtTn(d.kpis.saldo_tn)} unit="TN" tone="navy" hint="Todos los lotes filtrados · tres almacenes" />
        <KpiCard label="Lotes con saldo" value={fmtInt(d.kpis.abiertas)} hint={`${fmtInt(d.kpis.ot)} OT · ${fmtInt(d.kpis.lotes)} lotes filtrados`} />
        <KpiCard label={d.age_basis === 'ALMACEN' ? 'Permanencia en etapa' : 'Antigüedad del saldo'} value={fmtDias(d.kpis.edad_ponderada)} unit="días" hint={d.age_basis === 'ALMACEN' ? 'Desde el ingreso al almacén · ponderada por TN' : 'Desde origen conocido · ponderada por TN'} />
        <KpiCard label="TN críticas" value={fmtTn(d.kpis.criticas_tn)} unit="TN" tone="crit" hint={`Saldo con permanencia de ${d.alert_days} días o más`} />
        <KpiCard label="TN despachadas" value={fmtTn(d.kpis.despachadas_tn)} unit="TN" tone="ok" hint="Salida por guía · conformidad se valida por separado" />
      </div>
      {(d.kpis.sin_fecha_tn > 0 || d.cobertura.some(c => c.sin_peso > 0)) && <p className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">Calidad de datos: {fmtTn(d.kpis.sin_fecha_tn)} TN sin fecha de origen · {fmtInt(d.cobertura.reduce((n, c) => n + c.sin_peso, 0))} filas sin peso en la cobertura cargada. Los valores desconocidos no se consideran antigüedad cero.</p>}
      <ChartCard title="Recorrido del material" subtitle="OT → lote · las TN y los hitos conservan su significado por separado" actions={<div className="gantt-no-print flex flex-wrap gap-2"><button type="button" onClick={() => setExpanded(new Set(d.filas.map(r => r.ot ? `OT ${r.ot}` : 'Sin OT identificada')))} className="rounded-lg border border-slate-200 px-2 py-1.5 text-[10px] font-bold text-slate-600">Desplegar OT</button><button type="button" onClick={() => setExpanded(new Set())} className="rounded-lg border border-slate-200 px-2 py-1.5 text-[10px] font-bold text-slate-600">Contraer</button><div className="hidden overflow-hidden rounded-lg border border-slate-200 lg:flex">{(['dia', 'semana', 'mes'] as const).map(s => <button type="button" key={s} onClick={() => setScale(s)} aria-pressed={scale === s} className={`px-3 py-1.5 text-[10px] font-bold ${scale === s ? 'bg-[#002855] text-white' : 'bg-white text-slate-600'}`}>{s === 'dia' ? 'Días' : s === 'semana' ? 'Semanas' : 'Meses'}</button>)}</div></div>}>
        <div className="mb-3 flex flex-wrap items-center gap-3 text-[10px] text-slate-600">{FLOW_ALMACENES.map(a => <span key={a} className="flex items-center gap-1"><i className="h-2.5 w-4 rounded-sm" style={{ background: ALMACEN_COLOR[a] }} />{a === 'ST' ? 'ST VENTAS' : a}</span>)}<span className="flex items-center gap-1"><i className="h-2 w-2 rotate-45 bg-[#cf152d]" />Despacho por guía</span><span className="flex items-center gap-1"><i className="h-3 border-l-2 border-dashed border-violet-500" />FechaEntrega ERP</span><span>Etapas reconstruidas FIFO · origen sin fecha en detalle</span></div>
        <div className="gantt-no-print">{!d.filas.length || !start || !end ? <EmptyState title="Sin recorridos para esta consulta">Cambie los filtros o revise la cobertura de cargas en APT.</EmptyState> : <GanttTimeline rows={d.filas} desde={start} hasta={end} cutoff={d.cutoff || end} ageBasis={d.age_basis} scale={scale} expanded={expanded || new Set(d.filas.map(r => r.ot ? `OT ${r.ot}` : 'Sin OT identificada'))} toggle={toggle} selected={selected?.lote || null} onSelect={select} />}</div>
        <div className="hidden print:block"><DataTable dense><thead><tr>{['OT / lote', 'Cliente', 'Ingresadas TN', 'Despachadas TN', 'Saldo TN', 'Estado', 'Recorrido conocido'].map(t => <th key={t}>{t}</th>)}</tr></thead><tbody>{d.filas.map(r => <tr key={r.lote}><td>{r.ot ? `OT ${r.ot} / ` : ''}{r.lote}</td><td>{r.cliente || 'Sin cliente'}</td><td>{fmtTn(r.ingresadas_tn)}</td><td>{fmtTn(r.despachadas_tn)}</td><td>{fmtTn(r.saldo_tn)}</td><td>{STATE_LABEL[r.estado]}</td><td>{r.segmentos.slice(0, 12).map((s, i) => <p key={i}>{s.almacen}: {s.desde ? fmtDate(s.desde) : 'Stock previo'} → {fmtDate(s.hasta)} · {fmtTn(s.saldo_tn)} TN pendientes · FIFO</p>)}{r.segmentos_total > 12 && <p>Recorrido resumido; consultar la ventana para el detalle.</p>}</td></tr>)}</tbody></DataTable></div>
        <p className="mt-3 text-[10px] text-slate-500">¹ Entradas externas: producción, devoluciones e ingresos desde fuera del alcance. Stock previo y reasignaciones se muestran en detalle. Las barras pueden superponerse cuando existen varias capas o productos.</p>
        <div className="mt-3 flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-3 text-xs"><span className="text-slate-500">{d.total ? `${d.offset + 1}–${d.offset + d.filas.length}` : '0'} de {fmtInt(d.total)} lotes · indicadores del conjunto filtrado · resumen OT y exportación de esta página</span><div className="gantt-no-print flex gap-2"><button type="button" disabled={!page} onClick={() => navigate(filters, page - 1)} className="rounded-lg border border-slate-200 px-3 py-1.5 font-semibold text-[#002855] disabled:opacity-40">Anterior</button><button type="button" disabled={d.offset + d.filas.length >= d.total} onClick={() => navigate(filters, page + 1)} className="rounded-lg border border-slate-200 px-3 py-1.5 font-semibold text-[#002855] disabled:opacity-40">Siguiente</button></div></div>
      </ChartCard>
      {selected && <LotDetail row={selected} series={dt?.data?.serie || []} loading={!dt} error={dt?.error || null} trace={dt?.trace || null} traceError={dt?.traceError || null} cutoff={d.cutoff} desde={dt?.data?.desde || d.desde} hasta={dt?.data?.hasta || d.hasta} onClose={() => setSelection(null)} />}
      <ChartCard title="Prioridades de liberación" subtitle="Conjunto filtrado · ordenado por impacto del saldo · TN×días no es acumulación histórica">
        {!d.prioridades.length ? <p className="p-3 text-xs text-slate-500">Sin saldos pendientes en esta consulta.</p> : <div className="overflow-auto"><DataTable className="w-full text-xs" dense><thead className="bg-slate-50 text-[10px] uppercase text-slate-500"><tr>{['OT / lote', 'Cliente', 'Saldo TN', 'Días', 'Motivo', 'Detalle'].map(t => <th key={t} className="px-3 py-2 text-left">{t}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{d.prioridades.map(p => <tr key={p.lote}><td className="whitespace-nowrap px-3 py-3 font-mono font-bold text-[#002855]">{p.lote}<span className="block text-[10px] font-normal text-slate-500">{p.ot ? `OT ${p.ot}` : 'Sin OT identificada'}</span></td><td className="max-w-60 px-3 py-3 text-slate-500">{p.cliente || 'Sin cliente identificado'}</td><td className="px-3 py-3 font-bold tabular-nums">{fmtTn(p.saldo_tn)}</td><td className="px-3 py-3 tabular-nums">{fmtDias(p.dias)}</td><td className="px-3 py-3 text-[11px] text-slate-600">{p.motivo}</td><td className="px-3 py-3"><Link href={traceHref(p.lote)} className="whitespace-nowrap rounded-lg border border-slate-200 px-3 py-2 font-bold text-[#002855]">Ver trazabilidad</Link></td></tr>)}</tbody></DataTable></div>}
      </ChartCard>
    </>}
  </div>
}

export default function Page() { return <Suspense fallback={<LoadingBlock label="Cargando trazabilidad…" />}><GanttPage /></Suspense> }
