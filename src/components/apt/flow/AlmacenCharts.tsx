'use client'

import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { APT_COLORS, agingColor, fmtDec1, fmtTn } from '@/lib/apt/format'
import { ALMACEN_COLOR, FLOW_ALMACENES, STOCK_INICIAL_COLOR, movTipoColor, movTipoLabel } from '@/lib/apt/flowColors'
import { ALMACEN_LABEL, type FlowAlmacen, type FlowStock } from '@/lib/apt/flowTypes'
import { fmtAxis } from '@/components/apt/dashCharts'
import { AXIS_TICK, FlowTip, LegendDot, mesLabel, semanaLabel } from './ResumenShared'

// Gráficos de la pantalla "Stock por almacén"

type TipArgs = { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }
const tipRow = <T,>(a: TipArgs): T | null => (a.active && a.payload?.length ? (a.payload[0].payload as T) : null)

// 1. Evolución semanal del saldo por almacén (áreas apiladas)
export function AlmacenSerie({ data, active }: { data: FlowStock['serie']; active?: FlowAlmacen }) {
  if (!data.length) return <p className="py-16 text-center text-sm text-slate-400">Sin saldo semanal en el periodo.</p>
  return (
    <>
      <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
        {FLOW_ALMACENES.map(a => <LegendDot key={a} color={ALMACEN_COLOR[a]} label={ALMACEN_LABEL[a]} />)}
      </div>
      <ResponsiveContainer width="100%" height={280}>
        <AreaChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
          <defs>
            {FLOW_ALMACENES.map(a => (
              <linearGradient key={a} id={`alm-serie-${a}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={ALMACEN_COLOR[a]} stopOpacity={0.75} />
                <stop offset="100%" stopColor={ALMACEN_COLOR[a]} stopOpacity={0.35} />
              </linearGradient>
            ))}
          </defs>
          <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="fecha" tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={semanaLabel} minTickGap={18} />
          <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={fmtAxis} width={44} />
          <Tooltip content={a => {
            const r = tipRow<FlowStock['serie'][number]>(a)
            if (!r) return null
            const tot = FLOW_ALMACENES.reduce((s, x) => s + Number(r[x] || 0), 0)
            return <FlowTip title={`Saldo al cierre de la semana · ${semanaLabel(r.fecha)}`} rows={[
              ...FLOW_ALMACENES.map(x => [ALMACEN_LABEL[x], `${fmtTn(r[x])} TN · ${fmtDec1(tot > 0 ? (Number(r[x]) / tot) * 100 : 0)} %`, ALMACEN_COLOR[x]] as [string, string, string]),
              ['Total', `${fmtTn(tot)} TN`],
            ]} />
          }} />
          {FLOW_ALMACENES.map(a => (
            <Area key={a} type="monotone" dataKey={a} stackId="s" stroke={ALMACEN_COLOR[a]} strokeWidth={active === a ? 2.5 : 1.2}
              fill={`url(#alm-serie-${a})`} fillOpacity={!active || active === a ? 1 : 0.35} />
          ))}
        </AreaChart>
      </ResponsiveContainer>
    </>
  )
}

// 2. Aging por almacén: barras horizontales apiladas por rango
export function AlmacenAging({ data, active, onSelect }: { data: FlowStock['aging']; active?: FlowAlmacen; onSelect?: (a: FlowAlmacen) => void }) {
  const rangos = Array.from(new Map(data.map(r => [r.rango, r.orden])).entries()).sort((a, b) => a[1] - b[1]).map(([r]) => r)
  const conFecha = rangos.filter(r => data.find(x => x.rango === r)!.orden >= 0)
  const color = (r: string) => {
    const i = conFecha.indexOf(r)
    return i < 0 ? STOCK_INICIAL_COLOR : agingColor(i, Math.max(conFecha.length, 2))
  }
  type Row = { almacen: FlowAlmacen; label: string; total: number } & Record<string, number | string>
  const rows: Row[] = FLOW_ALMACENES.map(a => {
    const r: Row = { almacen: a, label: ALMACEN_LABEL[a], total: 0 }
    rangos.forEach(g => { const v = data.filter(x => x.almacen === a && x.rango === g).reduce((s, x) => s + Number(x.tn), 0); r[g] = v; r.total += v })
    return r
  }).filter(r => r.total > 0)
  if (!rows.length) return <p className="py-16 text-center text-sm text-slate-400">Sin saldo a la fecha de corte.</p>
  return (
    <>
      <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
        {rangos.map(g => <LegendDot key={g} color={color(g)} label={g} hatch={!conFecha.includes(g)} />)}
      </div>
      <ResponsiveContainer width="100%" height={Math.max(150, rows.length * 62 + 30)}>
        <BarChart data={rows} layout="vertical" margin={{ top: 4, right: 12, left: 0, bottom: 0 }} barCategoryGap="22%">
          <defs>
            <pattern id="alm-aging-ini" patternUnits="userSpaceOnUse" width={6} height={6} patternTransform="rotate(45)">
              <rect width={6} height={6} fill="#f1f5f9" />
              <rect width={3} height={6} fill="#94a3b8" />
            </pattern>
          </defs>
          <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" horizontal={false} />
          <XAxis type="number" tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={fmtAxis} />
          <YAxis type="category" dataKey="label" tick={{ ...AXIS_TICK, fontWeight: 700 }} axisLine={false} tickLine={false} width={92} />
          <Tooltip cursor={{ fill: '#f1f5f9' }} content={a => {
            const r = tipRow<Row>(a)
            return r && <FlowTip title={`Aging · ${r.label}`} subtitle="Días desde la producción; el stock previo no tiene fecha real." rows={[
              ...rangos.filter(g => Number(r[g]) > 0).map(g =>
                [g, `${fmtTn(Number(r[g]))} TN · ${fmtDec1((Number(r[g]) / r.total) * 100)} %`, color(g)] as [string, string, string]),
              ['Total', `${fmtTn(r.total)} TN`],
            ]} />
          }} />
          {rangos.map(g => (
            <Bar key={g} dataKey={g} stackId="a" fill={conFecha.includes(g) ? color(g) : 'url(#alm-aging-ini)'}
              cursor={onSelect ? 'pointer' : undefined} onClick={(_, i) => onSelect?.(rows[i]?.almacen)}>
              {rows.map(r => <Cell key={r.almacen} fillOpacity={!active || active === r.almacen ? 1 : 0.35} />)}
            </Bar>
          ))}
        </BarChart>
      </ResponsiveContainer>
    </>
  )
}

// 3. Ingresos vs salidas por mes de un almacén (barras divergentes)
export function AlmacenMovimientos({ data, almacen }: { data: FlowStock['movimientos']; almacen: FlowAlmacen }) {
  const rowsAlm = data.filter(m => m.almacen === almacen)
  const tiposIn = Array.from(new Set(rowsAlm.filter(m => m.sentido === 'INGRESO').map(m => m.tipo)))
  const tiposOut = Array.from(new Set(rowsAlm.filter(m => m.sentido === 'SALIDA').map(m => m.tipo)))
  const meses = Array.from(new Set(rowsAlm.map(m => m.mes))).sort()
  type Row = { mes: string; label: string; ingreso: number; salida: number } & Record<string, number | string>
  const rows: Row[] = meses.map(mes => {
    const r: Row = { mes, label: mesLabel(mes), ingreso: 0, salida: 0 }
    tiposIn.forEach(t => { r[`in_${t}`] = 0 })
    tiposOut.forEach(t => { r[`out_${t}`] = 0 })
    rowsAlm.filter(m => m.mes === mes).forEach(m => {
      const v = Number(m.tn)
      if (m.sentido === 'INGRESO') { r[`in_${m.tipo}`] = Number(r[`in_${m.tipo}`]) + v; r.ingreso += v }
      else { r[`out_${m.tipo}`] = Number(r[`out_${m.tipo}`]) - v; r.salida += v }
    })
    return r
  })
  if (!rows.length) return <p className="py-12 text-center text-sm text-slate-400">Sin movimientos en {ALMACEN_LABEL[almacen]}.</p>
  return (
    <>
      <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <span className="font-bold text-slate-400">Ingresos ▲</span>
        {tiposIn.map(t => <LegendDot key={`i${t}`} color={movTipoColor(t)} label={movTipoLabel(t)} />)}
        <span className="ml-2 font-bold text-slate-400">Salidas ▼</span>
        {tiposOut.map(t => <LegendDot key={`o${t}`} color={movTipoColor(t)} label={movTipoLabel(t)} hatch />)}
      </div>
      <ResponsiveContainer width="100%" height={260}>
        <BarChart data={rows} stackOffset="sign" margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
          <defs>
            {tiposOut.map(t => (
              <pattern key={t} id={`alm-mov-${almacen}-${t}`} patternUnits="userSpaceOnUse" width={6} height={6} patternTransform="rotate(45)">
                <rect width={6} height={6} fill={movTipoColor(t)} fillOpacity={0.35} />
                <rect width={3.5} height={6} fill={movTipoColor(t)} />
              </pattern>
            ))}
          </defs>
          <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} />
          <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={v => fmtAxis(Math.abs(v))} width={44} />
          <ReferenceLine y={0} stroke="#94a3b8" />
          <Tooltip cursor={{ fill: '#f1f5f9' }} content={a => {
            const r = tipRow<Row>(a)
            return r && <FlowTip title={`${ALMACEN_LABEL[almacen]} · ${r.label}`} rows={[
              ...tiposIn.filter(t => Number(r[`in_${t}`]) > 0).map(t => [`▲ ${movTipoLabel(t)}`, `${fmtTn(Number(r[`in_${t}`]))} TN`, movTipoColor(t)] as [string, string, string]),
              ...tiposOut.filter(t => Number(r[`out_${t}`]) < 0).map(t => [`▼ ${movTipoLabel(t)}`, `${fmtTn(-Number(r[`out_${t}`]))} TN`, movTipoColor(t)] as [string, string, string]),
              ['Ingresos', `${fmtTn(r.ingreso)} TN`], ['Salidas', `${fmtTn(r.salida)} TN`],
              ['Variación del saldo', `${r.ingreso - r.salida >= 0 ? '+' : ''}${fmtTn(r.ingreso - r.salida)} TN`],
            ]} />
          }} />
          {tiposIn.map(t => <Bar key={`i${t}`} dataKey={`in_${t}`} stackId="m" fill={movTipoColor(t)} maxBarSize={36} />)}
          {tiposOut.map(t => <Bar key={`o${t}`} dataKey={`out_${t}`} stackId="m" fill={`url(#alm-mov-${almacen}-${t})`} maxBarSize={36} />)}
        </BarChart>
      </ResponsiveContainer>
    </>
  )
}
