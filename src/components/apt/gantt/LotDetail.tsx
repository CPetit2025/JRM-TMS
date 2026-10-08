'use client'

import Link from 'next/link'
import { ArrowUpRight, X } from 'lucide-react'
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { fmtDate, fmtDateTime, fmtDias, fmtTn } from '@/lib/apt/format'
import type { GanttResult, GanttRow } from '@/lib/apt/ganttTypes'
import type { FlowTraceLote } from '@/lib/apt/flowTypes'
import { traceHref } from '@/lib/apt/useFlowFilters'
import { ALMACEN_COLOR } from '@/lib/apt/flowColors'
import { DataTable } from '@/components/ui/data-table'
import { ChartCard, LoadingBlock } from '@/components/apt/ui'
import { StateBadge } from './Timeline'

export function LotDetail({ row, series, loading, error, trace, traceError, cutoff, desde, hasta, onClose }: {
  row: GanttRow; series: GanttResult['serie']; loading: boolean; error: string | null
  trace: FlowTraceLote | null; traceError: string | null; cutoff: string | null; desde: string | null; hasta: string | null; onClose: () => void
}) {
  return <section id="gantt-lot-detail" className="scroll-mt-6 space-y-4 rounded-xl border border-[#002855]/20 bg-white p-4 shadow-sm md:p-5" aria-label={`Detalle del lote ${row.lote}`}>
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div><p className="text-[10px] font-bold uppercase tracking-widest text-slate-500">Trazabilidad del material</p><h2 className="mt-1 font-mono text-lg font-black text-[#002855]">{row.lote}</h2><p className="mt-1 text-xs text-slate-500">{row.ot ? `OT ${row.ot} · ` : ''}{row.cliente || 'Sin cliente identificado'} · {row.productos} productos</p></div>
      <div className="flex items-center gap-2"><StateBadge row={row} /><button type="button" aria-label="Cerrar detalle" onClick={onClose} className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><X className="h-4 w-4" /></button></div>
    </header>
    <div className="grid gap-4 xl:grid-cols-2">
      <ChartCard title="Evolución del saldo" subtitle={`TN al cierre diario · ventana ${fmtDate(desde)} – ${fmtDate(hasta)}`}>
        {loading ? <LoadingBlock label="Consultando evolución…" className="h-56" /> : error ? <p className="p-5 text-sm text-red-700">{error}</p> : !series.length ? <p className="p-8 text-center text-sm text-slate-500">Sin movimientos para construir la evolución.</p> : <>
          <div className="h-56 min-w-0"><ResponsiveContainer width="100%" height="100%"><AreaChart data={series} margin={{ top: 10, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#e2e8f0" vertical={false} /><XAxis dataKey="fecha" tickFormatter={v => fmtDate(String(v)).slice(0, 5)} tick={{ fontSize: 10 }} minTickGap={36} /><YAxis tick={{ fontSize: 10 }} width={42} />
            <Tooltip labelFormatter={v => fmtDate(String(v))} formatter={v => [`${fmtTn(Number(v))} TN`, 'Saldo']} />
            <Area dataKey="saldo_tn" type="stepAfter" stroke="#002855" fill="#002855" fillOpacity={0.1} strokeWidth={2} isAnimationActive={false} />
          </AreaChart></ResponsiveContainer></div>
          <p className="mt-2 text-[10px] text-slate-500">Saldo de movimientos ERP; puede mostrar negativos o diferencias frente a FIFO. Los traspasos entre almacenes no representan una nueva producción.</p>
        </>}
      </ChartCard>
      <ChartCard title="Conciliación del lote" subtitle={`Saldos al corte ${fmtDate(cutoff)} · entradas y motivos de salida separados`}>
        <dl className="grid grid-cols-2 gap-x-5 gap-y-3 text-xs">{[
          ['Entradas externas', row.ingresadas_tn], ['Stock previo', row.inicial_tn], ['Recibido de otros lotes', row.asignadas_tn], ['Cedido a otros lotes', row.cedidas_tn], ['Despachado por guía', row.despachadas_tn], ['Otras salidas', row.otras_salidas_tn], ['Saldo pendiente', row.saldo_tn], ['Saldo sin fecha de origen', row.saldo_sin_fecha_tn],
        ].map(([label, value]) => <div key={String(label)}><dt className="text-[10px] text-slate-500">{label}</dt><dd className="mt-1 font-bold tabular-nums text-[#002855]">{fmtTn(Number(value))} TN</dd></div>)}</dl>
        <p className="mt-4 rounded-lg bg-slate-50 p-3 text-[11px] text-slate-600">La salida de almacén y la conformidad en destino son hitos distintos. Este saldo no acredita por sí solo una entrega aprobada.</p>
      </ChartCard>
    </div>
    <div className="flex flex-wrap gap-2 text-xs"><Link href={traceHref(row.lote)} className="inline-flex items-center gap-1 rounded-lg border border-[#002855]/20 px-3 py-2 font-bold text-[#002855] hover:bg-slate-50">Ver cadena documental completa <ArrowUpRight className="h-3.5 w-3.5" /></Link><Link href={`/apt/flujo/kardex?k=${encodeURIComponent(JSON.stringify({ lote_exacto: row.lote, hasta: cutoff || undefined }))}`} className="rounded-lg border border-slate-200 px-3 py-2 font-bold text-slate-600 hover:bg-slate-50">Consultar Kardex</Link></div>
    <ChartCard title="Permanencia por etapa" subtitle={`${row.segmentos.length} de ${row.segmentos_total} segmentos · emparejamiento FIFO por producto y fecha`}>
      {row.segmentos_total > row.segmentos.length && <p className="mb-3 rounded-lg bg-amber-50 p-2 text-xs text-amber-800">Vista limitada. Consulte la cadena documental para profundizar en el recorrido.</p>}
      <div className="overflow-auto"><DataTable className="w-full text-xs" dense><thead className="bg-slate-50 text-[10px] uppercase text-slate-500"><tr>{['Almacén / producto', 'Ingreso a etapa', 'Hasta / corte', 'TN recibidas', 'TN pendientes', 'Tiempo', 'Estado'].map(t => <th key={t} className="whitespace-nowrap px-3 py-2 text-left">{t}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{row.segmentos.map((s, i) => <tr key={i}><td className="px-3 py-2"><span className="font-bold" style={{ color: ALMACEN_COLOR[s.almacen] }}>{s.almacen === 'ST' ? 'ST VENTAS' : s.almacen}</span><p className="text-[10px] text-slate-500">{s.producto}</p></td><td className="whitespace-nowrap px-3 py-2">{s.desde ? fmtDate(s.desde) : 'Stock previo · sin fecha'}</td><td className="whitespace-nowrap px-3 py-2">{fmtDate(s.hasta)}</td><td className="px-3 py-2 tabular-nums">{fmtTn(s.ingresadas_tn)}</td><td className="px-3 py-2 tabular-nums">{fmtTn(s.saldo_tn)}</td><td className="px-3 py-2">{s.dias === null ? 'Sin dato' : `${fmtDias(s.dias)} d`}</td><td className="px-3 py-2 text-[10px]">{s.abierto ? 'Abierto al corte' : 'Salida registrada'}<span className="block text-slate-400">Reconstrucción FIFO</span></td></tr>)}</tbody></DataTable></div>
    </ChartCard>
    <ChartCard title="Documentos y movimientos" subtitle={`${row.eventos.length} de ${row.eventos_total} eventos · valores diarios del ERP`}>
      <div className="gantt-scroll max-h-80 overflow-auto"><DataTable className="w-full text-xs" dense><thead className="sticky top-0 bg-slate-50 text-[10px] uppercase text-slate-500"><tr>{['Fecha', 'Movimiento', 'Almacén', 'Documento / vínculo', 'TN', 'Respaldo'].map(t => <th key={t} className="whitespace-nowrap px-3 py-2 text-left">{t}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{row.eventos.map((e, i) => <tr key={i}><td className="whitespace-nowrap px-3 py-2">{fmtDate(e.fecha)}</td><td className="px-3 py-2">{e.tipo.replaceAll('_', ' ')}<span className="block text-[10px] text-slate-500">{e.sentido}</span></td><td className="px-3 py-2">{e.almacen}</td><td className="px-3 py-2">{e.documento || 'Sin documento'}{e.lote_rel && <p className="text-[10px] text-slate-500">Lote relacionado: {e.lote_rel}</p>}</td><td className="whitespace-nowrap px-3 py-2 font-bold tabular-nums">{e.sentido === 'SALIDA' ? '−' : '+'}{fmtTn(e.tn)}</td><td className="px-3 py-2 text-[10px]">{e.precision === 'DOCUMENTAL' ? 'Movimiento documental' : 'Origen inferido'}</td></tr>)}</tbody></DataTable></div>
      {row.eventos_total > row.eventos.length && <p className="mt-3 text-xs text-amber-700">Se muestra una parte del historial. Use el Kardex para consultar todos los movimientos.</p>}
    </ChartCard>
    <ChartCard title="Vinculación con transporte" subtitle="Estado actual del TMS; puede ser posterior a la fecha de corte del material">
      {traceError ? <p className="text-xs text-amber-700">{traceError}</p> : !trace ? <LoadingBlock label="Consultando guías vinculadas…" className="h-16" /> : !trace.guias.filter(g => !cutoff || g.fecha <= cutoff).length ? <p className="text-xs text-slate-500">Sin guías registradas para este lote.</p> : <div className="overflow-auto"><DataTable className="w-full text-xs" dense><thead className="bg-slate-50 text-[10px] uppercase text-slate-500"><tr>{['Guía', 'Despacho TMS', 'Unidad', 'Estado', 'Salida', 'Llegada'].map(t => <th key={t} className="whitespace-nowrap px-3 py-2 text-left">{t}</th>)}</tr></thead><tbody className="divide-y divide-slate-100">{trace.guias.filter(g => !cutoff || g.fecha <= cutoff).map(g => { const t = trace.tms[g.documento.toUpperCase()]; return <tr key={g.documento}><td className="px-3 py-2"><Link href={traceHref(g.documento)} className="font-bold text-[#002855] underline">{g.documento}</Link></td><td className="px-3 py-2">{t?.numero || 'Sin vínculo registrado'}</td><td className="px-3 py-2">{t?.placa || '—'}</td><td className="px-3 py-2">{t?.estado?.replaceAll('_', ' ') || 'Sin dato'}</td><td className="whitespace-nowrap px-3 py-2">{fmtDateTime(t?.salida)}</td><td className="whitespace-nowrap px-3 py-2">{fmtDateTime(t?.llegada)}</td></tr> })}</tbody></DataTable></div>}
      <p className="mt-3 text-[10px] text-slate-500">La llegada o el estado del despacho no sustituyen la validación de la guía firmada por el Supervisor de Transporte.</p>
    </ChartCard>
  </section>
}
