'use client'

import { useMemo } from 'react'
import {
  Bar, BarChart, CartesianGrid, Cell, ComposedChart, Legend, Line, Pie, PieChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts'
import { APT_COLORS, fmtDate, fmtDias, fmtInt, fmtPct, fmtTn } from '@/lib/apt/format'
import { ALMACEN_COLOR, FLOW_COLOR, ORIGEN_COLOR, movTipoColor, movTipoLabel } from '@/lib/apt/flowColors'
import { ORIGEN_LABEL, type FlowAdelantos, type FlowOrigen } from '@/lib/apt/flowTypes'
import { fmtAxis, periodoLabel, short } from '@/components/apt/dashCharts'
import { AXIS_TICK } from '@/components/apt/TfcShared'
import { HATCH_BG, isInicial } from './TrazaParts'

// Gráficos de la página "Adelantos y 540": asignación de contrato vs reasignación, movimientos del 540, origen del saldo y contratos

export const ASIG_COLOR = ALMACEN_COLOR['540']   // 540→ST asigna contrato
export const REASIG_COLOR = ALMACEN_COLOR['647'] // 647→ST reasigna OT
const ESPERA_COLOR = APT_COLORS.red

export const mesLabel = (m: string) => periodoLabel(m, 'mes')

// Último día del mes de una fecha aaaa-mm-dd
export function finDeMes(mes: string) {
  const [y, m] = mes.slice(0, 10).split('-').map(Number)
  return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)
}

type TipProps = { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }>; label?: unknown }

function Box({ title, rows, foot }: { title: string; rows: Array<[string, string, string?]>; foot?: string }) {
  return (
    <div className="min-w-[200px] rounded-lg border border-slate-200 bg-white px-3 py-2 text-xs shadow-lg">
      <p className="mb-1.5 font-bold text-slate-800">{title}</p>
      <div className="space-y-1">
        {rows.map(([k, v, c]) => (
          <div key={k} className="flex items-center justify-between gap-4">
            <span className="flex items-center gap-1.5 text-slate-600">{c && <span className="h-2 w-2 rounded-sm" style={{ background: c }} />}{k}</span>
            <span className="font-semibold tabular-nums text-slate-900">{v}</span>
          </div>
        ))}
      </div>
      {foot && <p className="mt-1.5 border-t border-slate-100 pt-1.5 text-[11px] text-slate-500">{foot}</p>}
    </div>
  )
}

// 1. Asignación vs reasignación por mes, con días de espera sin contrato (línea)
export function AsignacionMensual({ data, onMes }: { data: FlowAdelantos['mensual']; onMes: (mes: string) => void }) {
  const rows = useMemo(() => [...data].sort((a, b) => a.mes.localeCompare(b.mes)), [data])
  return (
    <ResponsiveContainer width="100%" height={290}>
      <ComposedChart data={rows} margin={{ top: 10, right: 4, left: 0, bottom: 0 }}
        onClick={(s: { activeLabel?: unknown } | null) => { if (s?.activeLabel) onMes(String(s.activeLabel)) }}>
        <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="mes" tickFormatter={mesLabel} tick={AXIS_TICK} axisLine={false} tickLine={false} />
        <YAxis yAxisId="tn" tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={fmtAxis} width={44} />
        <YAxis yAxisId="d" orientation="right" tick={AXIS_TICK} axisLine={false} tickLine={false} width={36} tickFormatter={v => `${v} d`} />
        <Tooltip cursor={{ fill: '#f1f5f9' }} content={(a: TipProps) => {
          const r = a.active && a.payload?.length ? (a.payload[0].payload as FlowAdelantos['mensual'][number]) : null
          return r && <Box title={mesLabel(r.mes)} rows={[
            ['Asignación de contrato', `${fmtTn(r.asignacion_tn)} TN`, ASIG_COLOR], ['Reasignación OT→OT', `${fmtTn(r.reasignacion_tn)} TN`, REASIG_COLOR],
            ['Espera sin contrato', r.dias_espera === null ? 'sin dato' : `${fmtDias(r.dias_espera)} días`, ESPERA_COLOR],
          ]} foot="Clic para filtrar el mes. Días ponderados por TN; no hay dato cuando lo asignado era stock previo (sin fecha)." />
        }} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
        <Bar yAxisId="tn" dataKey="asignacion_tn" name="Asignación de contrato (540→ST)" fill={ASIG_COLOR} radius={[3, 3, 0, 0]} maxBarSize={28} cursor="pointer" />
        <Bar yAxisId="tn" dataKey="reasignacion_tn" name="Reasignación OT→OT (647→ST)" fill={REASIG_COLOR} radius={[3, 3, 0, 0]} maxBarSize={28} cursor="pointer" />
        <Line yAxisId="d" dataKey="dias_espera" name="Días de espera" stroke={ESPERA_COLOR} strokeWidth={2} dot={{ r: 3 }} connectNulls />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// 2. 540 mes a mes: ingresos (+) y salidas (−) por tipo, y el stock previo del 540 que terminó despachado
const ING_ORDER = ['DESDE_647', 'DESDE_ST', 'DESDE_540', 'PRODUCCION', 'DEVOLUCION', 'OTRO_ALMACEN']
const SAL_ORDER = ['HACIA_ST', 'HACIA_647', 'HACIA_540', 'CONSUMO', 'DESPACHO', 'OTRO_ALMACEN']
const ordered = (keys: Set<string>, order: string[]) => [...keys].sort((a, b) => {
  const ia = order.indexOf(a), ib = order.indexOf(b)
  return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib)
})
// El ingreso 540→540 (cambio de lote dentro del 540) se pinta claro para no confundirlo con la salida
const salColor = (t: string) => (t === 'HACIA_540' ? '#fcd34d' : movTipoColor(t))
const ingColor = (t: string) => (t === 'DESDE_540' ? '#fcd34d' : t === 'OTRO_ALMACEN' ? '#cbd5e1' : movTipoColor(t))

export function Movimientos540({ data, onMes }: { data: FlowAdelantos['mensual_540']; onMes: (mes: string) => void }) {
  const { rows, ing, sal } = useMemo(() => {
    const ingK = new Set<string>(), salK = new Set<string>()
    data.forEach(m => { Object.keys(m.ingresos || {}).forEach(k => ingK.add(k)); Object.keys(m.salidas || {}).forEach(k => salK.add(k)) })
    const rows = [...data].sort((a, b) => a.mes.localeCompare(b.mes)).map(m => {
      const r: Record<string, number | string> = { mes: m.mes, inicial_despachado_tn: m.inicial_despachado_tn }
      Object.entries(m.ingresos || {}).forEach(([k, v]) => { r[`i_${k}`] = v })
      Object.entries(m.salidas || {}).forEach(([k, v]) => { r[`s_${k}`] = -v })
      return r
    })
    return { rows, ing: ordered(ingK, ING_ORDER), sal: ordered(salK, SAL_ORDER) }
  }, [data])
  return (
    <ResponsiveContainer width="100%" height={310}>
      <ComposedChart data={rows} stackOffset="sign" margin={{ top: 10, right: 4, left: 0, bottom: 0 }}
        onClick={(s: { activeLabel?: unknown } | null) => { if (s?.activeLabel) onMes(String(s.activeLabel)) }}>
        <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" vertical={false} />
        <XAxis dataKey="mes" tickFormatter={mesLabel} tick={AXIS_TICK} axisLine={false} tickLine={false} />
        <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={v => fmtAxis(Math.abs(Number(v)))} width={44} />
        <ReferenceLine y={0} stroke="#94a3b8" />
        <Tooltip cursor={{ fill: '#f1f5f9' }} content={(a: TipProps) => {
          const r = a.active && a.payload?.length ? (a.payload[0].payload as Record<string, number | string>) : null
          if (!r) return null
          const rws: Array<[string, string, string?]> = []
          ing.forEach(k => { if (r[`i_${k}`]) rws.push([`↑ ${movTipoLabel(k)}`, `${fmtTn(Number(r[`i_${k}`]))} TN`, ingColor(k)]) })
          sal.forEach(k => { if (r[`s_${k}`]) rws.push([`↓ ${movTipoLabel(k)}`, `${fmtTn(-Number(r[`s_${k}`]))} TN`, salColor(k)]) })
          rws.push(['Stock previo 540 despachado', `${fmtTn(Number(r.inicial_despachado_tn))} TN`, '#475569'])
          return <Box title={mesLabel(String(r.mes))} rows={rws} foot="Arriba: lo que entra al 540. Abajo: lo que sale. La línea es stock antiguo del 540 que llegó al cliente ese mes." />
        }} />
        <Legend iconType="circle" iconSize={8} wrapperStyle={{ fontSize: 11 }} />
        {ing.map(k => <Bar key={`i_${k}`} dataKey={`i_${k}`} stackId="m" name={`Ingreso ${movTipoLabel(k).toLowerCase()}`} fill={ingColor(k)} maxBarSize={32} cursor="pointer" />)}
        {sal.map(k => <Bar key={`s_${k}`} dataKey={`s_${k}`} stackId="m" name={`Salida ${movTipoLabel(k).toLowerCase()}`} fill={salColor(k)} maxBarSize={32} cursor="pointer" />)}
        <Line dataKey="inicial_despachado_tn" name="Stock previo 540 despachado" stroke="#475569" strokeDasharray="5 3" strokeWidth={2} dot={{ r: 3 }} />
      </ComposedChart>
    </ResponsiveContainer>
  )
}

// 3. Composición del saldo que queda en 540 por origen (dona)
export function Saldo540Donut({ data }: { data: FlowAdelantos['saldo_540_origen'] }) {
  const rows = useMemo(() => [...data].filter(d => d.tn > 0).sort((a, b) => b.tn - a.tn), [data])
  const total = rows.reduce((s, r) => s + r.tn, 0)
  if (!rows.length) return <p className="flex h-56 items-center justify-center text-sm text-slate-500">El 540 no tiene saldo al corte.</p>
  return (
    <div className="flex flex-col items-center gap-4 sm:flex-row">
      <div className="relative h-52 w-52 shrink-0">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={rows} dataKey="tn" nameKey="origen" innerRadius="62%" outerRadius="95%" paddingAngle={1.5} stroke="#fff" isAnimationActive={false}>
              {rows.map(r => <Cell key={r.origen} fill={ORIGEN_COLOR[r.origen] || '#94a3b8'} />)}
            </Pie>
            <Tooltip content={(a: TipProps) => {
              const r = a.active && a.payload?.length ? (a.payload[0].payload as FlowAdelantos['saldo_540_origen'][number]) : null
              return r && <Box title={ORIGEN_LABEL[r.origen] || r.origen} rows={[
                ['TN', fmtTn(r.tn)], ['% del saldo', fmtPct(total ? (r.tn / total) * 100 : null)], ['Lotes', fmtInt(r.lotes)],
              ]} />
            }} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="text-xl font-black tabular-nums text-slate-900">{fmtTn(total)}</span>
          <span className="text-[10px] font-bold uppercase tracking-wider text-slate-400">TN en 540</span>
        </div>
      </div>
      <ul className="w-full space-y-2 text-xs">
        {rows.map(r => (
          <li key={r.origen} className="flex items-center justify-between gap-3">
            <span className="flex items-center gap-2 text-slate-700">
              <span className="h-3 w-3 rounded-sm border border-slate-200" style={isInicial(r.origen) ? { background: HATCH_BG } : { background: ORIGEN_COLOR[r.origen as FlowOrigen] }} />
              {ORIGEN_LABEL[r.origen] || r.origen}
            </span>
            <span className="tabular-nums text-slate-500"><b className="text-slate-800">{fmtTn(r.tn)}</b> TN · {fmtInt(r.lotes)} lotes · {fmtPct(total ? (r.tn / total) * 100 : null)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

// 4. Contratos que recibieron asignaciones (top por TN). Clic abre la trazabilidad del contrato.
export function ContratosBars({ data, onSelect, top = 12 }: { data: FlowAdelantos['contratos']; onSelect: (contrato: string) => void; top?: number }) {
  const rows = useMemo(() => [...data].sort((a, b) => b.tn - a.tn).slice(0, top), [data, top])
  return (
    <ResponsiveContainer width="100%" height={Math.max(180, rows.length * 26 + 20)}>
      <BarChart data={rows} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
        <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" horizontal={false} />
        <XAxis type="number" tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={fmtAxis} />
        <YAxis type="category" dataKey="contrato" tick={{ ...AXIS_TICK, fontFamily: 'monospace' }} axisLine={false} tickLine={false} width={92} />
        <Tooltip cursor={{ fill: '#f1f5f9' }} content={(a: TipProps) => {
          const r = a.active && a.payload?.length ? (a.payload[0].payload as FlowAdelantos['contratos'][number]) : null
          return r && <Box title={r.contrato} rows={[
            ['TN recibidas', fmtTn(r.tn)], ['Lotes de origen', fmtInt(r.lotes_origen)], ['Primera', fmtDate(r.primera)], ['Última', fmtDate(r.ultima)],
            ['Tipo', r.clase === 'ASIGNACION' ? 'Asignación' : 'Reasignación', r.clase === 'ASIGNACION' ? ASIG_COLOR : REASIG_COLOR],
          ]} foot={`${short(r.cliente, 60)} · clic para ver la trazabilidad`} />
        }} />
        <Bar dataKey="tn" radius={[0, 3, 3, 0]} maxBarSize={18} cursor="pointer" onClick={(d: { payload?: unknown }) => {
          const p = d?.payload as { contrato?: string } | undefined
          if (p?.contrato) onSelect(p.contrato)
        }}>
          {rows.map(r => <Cell key={`${r.contrato}-${r.clase}`} fill={r.clase === 'ASIGNACION' ? ASIG_COLOR : REASIG_COLOR} />)}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}

// Resumen de consumos internos por almacén y DocRel (barras inline)
export function ConsumoResumen({ data }: { data: FlowAdelantos['consumos_resumen'] }) {
  const rows = useMemo(() => [...data].sort((a, b) => b.tn - a.tn), [data])
  const max = rows.reduce((m, r) => Math.max(m, r.tn), 0)
  const total = rows.reduce((s, r) => s + r.tn, 0)
  if (!rows.length) return <p className="text-sm text-slate-500">Sin consumos internos en el periodo.</p>
  return (
    <ul className="space-y-2.5">
      {rows.map(r => (
        <li key={`${r.almacen}-${r.docrel}`} className="text-xs">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="flex min-w-0 items-center gap-2">
              <span className="rounded px-1.5 py-0.5 text-[10px] font-bold text-white" style={{ background: ALMACEN_COLOR[r.almacen] }}>{r.almacen}</span>
              <span className="truncate font-semibold text-slate-700" title={r.docrel}>{r.docrel || '(sin DocRel)'}</span>
            </span>
            <span className="whitespace-nowrap tabular-nums text-slate-500"><b className="text-slate-800">{fmtTn(r.tn)}</b> TN · {fmtInt(r.filas)} filas · {fmtPct(total ? (r.tn / total) * 100 : null)}</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-slate-100">
            <div className="h-1.5 rounded-full" style={{ width: `${max ? Math.max(2, (r.tn / max) * 100) : 0}%`, background: FLOW_COLOR.CONSUMO }} />
          </div>
        </li>
      ))}
    </ul>
  )
}
