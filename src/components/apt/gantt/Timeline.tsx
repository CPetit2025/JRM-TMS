'use client'

import { useMemo } from 'react'
import { ChevronDown, ChevronRight, Eye } from 'lucide-react'
import { ALMACEN_COLOR, FLOW_ALMACENES } from '@/lib/apt/flowColors'
import { fmtDate, fmtDias, fmtTn } from '@/lib/apt/format'
import type { GanttRow, GanttSegment, GanttEstado } from '@/lib/apt/ganttTypes'

export type GanttScale = 'dia' | 'semana' | 'mes'
export const STATE_LABEL: Record<GanttEstado, string> = {
  CON_SALDO: 'En almacén', PARCIAL: 'Despacho parcial', DESPACHADO: 'Despachado',
  SALIDA_NO_ENTREGA: 'Salida por otro motivo', RESIDUAL: 'Saldo en tolerancia',
}
const DAY = 86400000
const stamp = (v: string) => Date.parse(`${v.slice(0, 10)}T00:00:00Z`)

export function StateBadge({ row }: { row: GanttRow }) {
  const color = row.critico ? 'border-red-200 bg-red-50 text-red-700' : row.estado === 'DESPACHADO'
    ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : row.estado === 'PARCIAL'
      ? 'border-amber-200 bg-amber-50 text-amber-700' : 'border-slate-200 bg-slate-50 text-slate-700'
  return <span className={`inline-flex rounded-md border px-2 py-1 text-[10px] font-bold ${color}`}>{row.critico ? 'Permanencia crítica · ' : ''}{STATE_LABEL[row.estado]}</span>
}

export function GanttTimeline({ rows, desde, hasta, cutoff, ageBasis, scale, expanded, toggle, selected, onSelect }: {
  rows: GanttRow[]; desde: string; hasta: string; cutoff: string; ageBasis: 'ALMACEN' | 'ORIGEN'; scale: GanttScale
  expanded: Set<string>; toggle: (ot: string) => void; selected: string | null; onSelect: (row: GanttRow) => void
}) {
  const groups = useMemo(() => {
    const map = new Map<string, GanttRow[]>()
    rows.forEach(r => { const key = r.ot ? `OT ${r.ot}` : 'Sin OT identificada'; map.set(key, [...(map.get(key) || []), r]) })
    return [...map.entries()]
  }, [rows])
  const start = stamp(desde), end = Math.max(start, stamp(hasta)), days = Math.max(1, Math.round((end - start) / DAY) + 1)
  const width = Math.max(680, Math.min(16000, days * ({ dia: 24, semana: 6, mes: 2 }[scale])))
  const step = scale === 'dia' ? Math.max(1, Math.ceil(days / (width / 54))) : scale === 'semana' ? 7 : 30
  const pos = (date: string) => Math.max(0, Math.min(100, ((stamp(date) - start) / (days * DAY)) * 100))
  const ticks: Array<{ date: string; left: number }> = []
  for (let i = 0; i < days; i += step) ticks.push({ date: new Date(start + i * DAY).toISOString().slice(0, 10), left: (i / days) * 100 })

  function Bars({ segments, row }: { segments: GanttSegment[]; row?: GanttRow }) {
    return <div className="relative h-[64px]" style={{ width }}>
      {ticks.map(t => <span key={t.date} className="absolute inset-y-0 border-l border-slate-100" style={{ left: `${t.left}%` }} />)}
      {segments.map((s, i) => {
        if (!s.desde || stamp(s.hasta) < start || stamp(s.desde) > end) return null
        const left = pos(s.desde), right = pos(s.hasta)
        return <span key={`${s.almacen}-${s.producto}-${s.desde}-${i}`} role="img"
          aria-label={`${s.almacen}: ${fmtDate(s.desde)} a ${fmtDate(s.hasta)}, ${fmtTn(s.ingresadas_tn)} TN; reconstrucción FIFO`}
          title={`${s.almacen} · ${s.producto}\n${fmtDate(s.desde)} → ${fmtDate(s.hasta)}${s.abierto ? ' · abierto al corte' : ''}\nIngreso a etapa: ${fmtTn(s.ingresadas_tn)} TN · Saldo: ${fmtTn(s.saldo_tn)} TN\nReconstrucción FIFO; las capas pueden superponerse.`}
          className={`absolute h-3.5 rounded-sm border border-white/30 opacity-85 ${s.abierto ? 'border-r-2 border-r-slate-700' : ''}`}
          style={{ left: `${left}%`, width: `${Math.max(0.2, right - left + 100 / days)}%`, maxWidth: `${100 - left}%`, top: 8 + FLOW_ALMACENES.indexOf(s.almacen) * 17, background: ALMACEN_COLOR[s.almacen] }} />
      })}
      {row?.eventos.filter(e => e.tipo === 'DESPACHO' && e.fecha && stamp(e.fecha) >= start && stamp(e.fecha) <= end).map((e, i) =>
        <span key={`e-${i}`} title={`Despacho · ${fmtDate(e.fecha)} · ${fmtTn(e.tn)} TN · ${e.documento || 'Sin documento'} · ${e.precision === 'DOCUMENTAL' ? 'Movimiento documental' : 'Origen inferido'}`}
          role="img" aria-label={`Despacho ${fmtDate(e.fecha)}: ${fmtTn(e.tn)} TN`}
          className="absolute top-12 z-10 h-2.5 w-2.5 rotate-45 border border-white bg-[#cf152d]" style={{ left: `${Math.min(99.5, pos(e.fecha!))}%` }} />)}
      {row?.fecha_entrega_min && stamp(row.fecha_entrega_min) >= start && stamp(row.fecha_entrega_min) <= end && <span
        role="img" aria-label={`Fecha de entrega ERP ${fmtDate(row.fecha_entrega_min)}`}
        title={`Referencia FechaEntrega ERP: ${fmtDate(row.fecha_entrega_min)}${row.fechas_entrega_total > 1 ? ` a ${fmtDate(row.fecha_entrega_max)} (${row.fechas_entrega_total} fechas)` : ''}; no acredita llegada.`}
        className="absolute inset-y-1 border-l-2 border-dashed border-violet-500" style={{ left: `${pos(row.fecha_entrega_min)}%` }} />}
    </div>
  }

  return <>
    <div className="gantt-scroll hidden max-h-[660px] overflow-auto rounded-xl border border-slate-200 xl:block">
      <table className="table-fixed border-separate border-spacing-0 text-xs" style={{ width: 705 + width }}><colgroup><col style={{ width: 220 }} /><col style={{ width: 85 }} /><col style={{ width: 85 }} /><col style={{ width: 85 }} /><col style={{ width: 170 }} /><col style={{ width }} /><col style={{ width: 60 }} /></colgroup>
        <thead className="sticky top-0 z-30 bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500"><tr>
          <th className="sticky left-0 z-40 border-b border-slate-200 bg-slate-50 px-4 py-3 text-left">OT / lote · cliente</th>
          <th className="sticky left-[220px] z-40 border-b border-slate-200 bg-slate-50 px-3 text-right">Ingreso¹ TN</th>
          <th className="sticky left-[305px] z-40 border-b border-slate-200 bg-slate-50 px-3 text-right">Despacho TN</th>
          <th className="sticky left-[390px] z-40 border-b border-slate-200 bg-slate-50 px-3 text-right">Saldo TN</th>
          <th className="sticky left-[475px] z-40 border-b border-r border-slate-200 bg-slate-50 px-3 text-left">Estado / permanencia</th>
          <th className="border-b border-slate-200 px-0 text-left"><div className="relative h-12 normal-case" style={{ width }}>
            {ticks.map(t => <span key={t.date} className="absolute bottom-2 whitespace-nowrap border-l border-slate-300 pl-1.5 font-medium" style={{ left: `${t.left}%` }}>{scale === 'mes' ? t.date.slice(0, 7) : fmtDate(t.date).slice(0, 5)}</span>)}
          </div></th>
          <th className="sticky right-0 z-40 border-b border-l border-slate-200 bg-slate-50 px-1">Detalle</th>
        </tr></thead>
        <tbody>{groups.map(([ot, lots]) => {
          const open = expanded.has(ot)
          return [<tr key={ot} className="bg-[#edf2f8]">
            <td className="sticky left-0 z-20 border-b border-slate-200 bg-[#edf2f8] px-4 py-2"><button type="button" onClick={() => toggle(ot)} aria-expanded={open} className="flex w-full items-center gap-2 text-left font-bold text-[#002855]">{open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}{ot}<span className="ml-auto text-[10px] font-normal">{lots.length} lote{lots.length !== 1 ? 's' : ''} en página</span></button></td>
            {[ 'ingresadas_tn', 'despachadas_tn', 'saldo_tn' ].map((k, i) => <td key={k} style={{ left: 220 + 85 * i }} className="sticky z-20 border-b border-slate-200 bg-[#edf2f8] px-3 text-right font-bold tabular-nums">{fmtTn(lots.reduce((n, r) => n + Number(r[k as keyof GanttRow]), 0))}</td>)}
            <td className="sticky left-[475px] z-20 border-b border-r border-slate-200 bg-[#edf2f8] px-3 text-[10px] text-slate-500">Resumen de página</td>
            <td className="border-b border-slate-200 p-0"><Bars segments={lots.flatMap(r => r.segmentos)} /></td><td className="sticky right-0 z-20 border-b border-l border-slate-200 bg-[#edf2f8]" />
          </tr>, ...(open ? lots.map(row => <tr key={row.lote} className={selected === row.lote ? 'bg-sky-50' : 'bg-white hover:bg-slate-50'}>
            <td className={`sticky left-0 z-20 border-b border-slate-100 px-4 py-3 ${selected === row.lote ? 'bg-sky-50' : 'bg-white'}`}><button type="button" onClick={() => onSelect(row)} className="block w-full text-left"><span className="font-mono font-bold text-[#002855]">{row.lote}</span><span className="mt-1 block max-w-[188px] truncate text-[10px] text-slate-500" title={row.cliente || ''}>{row.cliente || 'Sin cliente identificado'}</span></button></td>
            <td className={`sticky left-[220px] z-20 border-b border-slate-100 px-3 text-right tabular-nums ${selected === row.lote ? 'bg-sky-50' : 'bg-white'}`}>{fmtTn(row.ingresadas_tn)}</td><td className={`sticky left-[305px] z-20 border-b border-slate-100 px-3 text-right tabular-nums ${selected === row.lote ? 'bg-sky-50' : 'bg-white'}`}>{fmtTn(row.despachadas_tn)}</td><td className={`sticky left-[390px] z-20 border-b border-slate-100 px-3 text-right font-bold tabular-nums text-[#002855] ${selected === row.lote ? 'bg-sky-50' : 'bg-white'}`}>{fmtTn(row.saldo_tn)}</td>
            <td className={`sticky left-[475px] z-20 border-b border-r border-slate-100 px-3 ${selected === row.lote ? 'bg-sky-50' : 'bg-white'}`}><StateBadge row={row} /><span className="mt-1 block text-[10px] text-slate-500">{row.edad_ponderada === null ? 'Antigüedad sin dato' : `${fmtDias(row.edad_ponderada)} d · ${ageBasis === 'ALMACEN' ? 'etapa actual' : 'desde origen'}`}</span></td>
            <td className="border-b border-slate-100 p-0"><Bars segments={row.segmentos} row={row} /></td><td className={`sticky right-0 z-20 border-b border-l border-slate-100 px-2 ${selected === row.lote ? 'bg-sky-50' : 'bg-white'}`}><button type="button" onClick={() => onSelect(row)} aria-label={`Ver detalle de ${row.lote}`} className="rounded-lg border border-slate-200 p-2 text-[#002855] hover:bg-slate-100"><Eye className="h-4 w-4" /></button></td>
          </tr>) : [])]
        })}</tbody>
      </table>
    </div>
    <div className="space-y-3 xl:hidden">{rows.map(row => <button type="button" key={row.lote} onClick={() => onSelect(row)} className={`block w-full rounded-xl border bg-white p-4 text-left ${selected === row.lote ? 'border-[#002855] ring-1 ring-[#002855]' : 'border-slate-200'}`}>
      <div className="flex items-center justify-between gap-2"><span className="font-mono text-sm font-bold text-[#002855]">{row.lote}</span><Eye className="h-4 w-4 text-slate-400" /></div>
      <p className="mt-1 truncate text-xs text-slate-500">{row.ot ? `OT ${row.ot} · ` : ''}{row.cliente || 'Sin cliente identificado'}</p>
      <div className="my-3 grid grid-cols-3 gap-2 text-xs"><span>Ingreso¹<br /><b>{fmtTn(row.ingresadas_tn)} TN</b></span><span>Despacho<br /><b>{fmtTn(row.despachadas_tn)} TN</b></span><span>Saldo<br /><b className="text-[#002855]">{fmtTn(row.saldo_tn)} TN</b></span></div>
      <StateBadge row={row} /><p className="mt-2 text-[11px] text-slate-500">{fmtDate(row.primera_fecha)} → {fmtDate(row.saldo_tn > 0 ? cutoff : row.ultima_fecha)}{row.saldo_tn > 0 ? ' · abierto al corte' : ' · último movimiento'} · {row.edad_ponderada === null ? 'Antigüedad sin dato' : `${fmtDias(row.edad_ponderada)} d ${ageBasis === 'ALMACEN' ? 'en etapa actual' : 'desde origen'}`}</p>
      {row.fecha_entrega_min && <p className="mt-1 text-[10px] text-violet-700">Entrega ERP: {fmtDate(row.fecha_entrega_min)}{row.fechas_entrega_total > 1 ? ` – ${fmtDate(row.fecha_entrega_max)}` : ''}</p>}
      <div className="mt-3 flex flex-wrap gap-2">{FLOW_ALMACENES.filter(a => row.segmentos.some(s => s.almacen === a)).map(a => <span key={a} className="rounded px-2 py-1 text-[10px] font-bold text-white" style={{ background: ALMACEN_COLOR[a] }}>{a === 'ST' ? 'ST VENTAS' : a}</span>)}</div>
    </button>)}</div>
  </>
}
