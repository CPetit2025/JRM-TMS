'use client'

import { Bar, CartesianGrid, ComposedChart, Line, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import { APT_COLORS, fmtDec1, fmtTn } from '@/lib/apt/format'
import { ALMACEN_COLOR, FLOW_COLOR, FLOW_ORIGENES, ORIGEN_COLOR, hatchId } from '@/lib/apt/flowColors'
import { ORIGEN_LABEL, type FlowOrigen, type FlowSummary } from '@/lib/apt/flowTypes'
import { fmtAxis } from '@/components/apt/dashCharts'
import { AXIS_TICK, FlowTip, LegendDot, mesLabel } from './ResumenShared'

// Gráficos mensuales del resumen del flujo

type Mensual = FlowSummary['mensual']
type TipArgs = { active?: boolean; payload?: ReadonlyArray<{ payload?: unknown }> }
const tipRow = <T,>(a: TipArgs): T | null => (a.active && a.payload?.length ? (a.payload[0].payload as T) : null)

const isInicial = (o: FlowOrigen) => o.startsWith('INICIAL_')
const fillOf = (o: FlowOrigen) => (isInicial(o) ? `url(#${hatchId(ORIGEN_COLOR[o])})` : ORIGEN_COLOR[o])

function HatchDefs({ colors }: { colors: string[] }) {
  return (
    <defs>
      {colors.map(c => (
        <pattern key={c} id={hatchId(c)} patternUnits="userSpaceOnUse" width={6} height={6} patternTransform="rotate(45)">
          <rect width={6} height={6} fill="#f1f5f9" />
          <rect width={3.2} height={6} fill={c} />
        </pattern>
      ))}
    </defs>
  )
}

// 1. TN despachadas por mes según el origen raíz + lead time producción→guía
type DespRow = { mes: string; label: string; total: number; dias_total: number | null } & Partial<Record<FlowOrigen, number>>

export function ResumenDespachoMensual({ data, onMes }: { data: Mensual; onMes?: (mes: string) => void }) {
  const origenes = FLOW_ORIGENES.filter(o => data.some(m => (m.despacho[o] ?? 0) > 0))
  const rows: DespRow[] = data.map(m => {
    const r: DespRow = { mes: m.mes, label: mesLabel(m.mes), total: 0, dias_total: m.dias_total }
    origenes.forEach(o => { const v = Number(m.despacho[o] ?? 0); r[o] = v; r.total += v })
    return r
  })
  if (!rows.length) return <p className="py-16 text-center text-sm text-slate-400">Sin despachos en el periodo.</p>
  return (
    <>
      <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
        {origenes.map(o => <LegendDot key={o} color={ORIGEN_COLOR[o]} label={ORIGEN_LABEL[o]} hatch={isInicial(o)} />)}
        <LegendDot color={APT_COLORS.red} label="Lead time producción→guía (d, eje der.)" line />
      </div>
      <ResponsiveContainer width="100%" height={290}>
        <ComposedChart data={rows} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}
          onClick={s => { const i = Number(s?.activeTooltipIndex); if (onMes && rows[i]) onMes(rows[i].mes) }}>
          <HatchDefs colors={origenes.filter(isInicial).map(o => ORIGEN_COLOR[o])} />
          <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} />
          <YAxis yAxisId="tn" tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={fmtAxis} width={44} />
          <YAxis yAxisId="d" orientation="right" tick={AXIS_TICK} axisLine={false} tickLine={false} width={32} tickFormatter={v => `${v} d`} />
          <Tooltip cursor={{ fill: '#f1f5f9' }} content={a => {
            const r = tipRow<DespRow>(a)
            return r && <FlowTip title={`Despachado · ${r.label}`} rows={[
              ...origenes.filter(o => (r[o] ?? 0) > 0).map(o =>
                [ORIGEN_LABEL[o], `${fmtTn(r[o])} TN · ${fmtDec1(r.total > 0 ? ((r[o] ?? 0) / r.total) * 100 : 0)} %`, ORIGEN_COLOR[o]] as [string, string, string]),
              ['Total despachado', `${fmtTn(r.total)} TN`],
              ['Lead time producción→guía', r.dias_total === null ? '—' : `${fmtDec1(r.dias_total)} d`, APT_COLORS.red],
            ]} />
          }} />
          {origenes.map((o, i) => (
            <Bar key={o} yAxisId="tn" dataKey={o} stackId="d" fill={fillOf(o)} stroke={isInicial(o) ? ORIGEN_COLOR[o] : undefined}
              strokeWidth={isInicial(o) ? 0.5 : 0} maxBarSize={44} radius={i === origenes.length - 1 ? [4, 4, 0, 0] : 0}
              cursor={onMes ? 'pointer' : undefined} />
          ))}
          <Line yAxisId="d" type="monotone" dataKey="dias_total" stroke={APT_COLORS.red} strokeWidth={2.2}
            dot={{ r: 3, fill: '#fff', strokeWidth: 2 }} connectNulls />
        </ComposedChart>
      </ResponsiveContainer>
    </>
  )
}

// 2. Producción vs traspasos 647→ST, 540→ST y ST→647 por mes
type TrRow = { mes: string; label: string; produccion: number; t647: number; t540: number; ret: number; consumo: number }

export function ResumenTraspasosMensual({ data }: { data: Mensual }) {
  const rows: TrRow[] = data.map(m => ({
    mes: m.mes, label: mesLabel(m.mes), produccion: Number(m.produccion_tn || 0),
    t647: Number(m.traspasos['647→ST'] ?? 0), t540: Number(m.traspasos['540→ST'] ?? 0),
    ret: Number(m.traspasos['ST→647'] ?? 0) + Number(m.traspasos['ST→540'] ?? 0), consumo: Number(m.consumo_tn || 0),
  }))
  if (!rows.length) return <p className="py-16 text-center text-sm text-slate-400">Sin movimientos en el periodo.</p>
  return (
    <>
      <div className="mb-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px] text-slate-500">
        <LegendDot color={FLOW_COLOR.PRODUCCION} label="Producción a 647" />
        <LegendDot color={ALMACEN_COLOR['647']} label="Traspaso 647→ST" />
        <LegendDot color={ALMACEN_COLOR['540']} label="Traspaso 540→ST" />
        <LegendDot color={FLOW_COLOR.RETORNO} label="Retorno ST→647/540" line />
      </div>
      <ResponsiveContainer width="100%" height={290}>
        <ComposedChart data={rows} margin={{ top: 8, right: 4, left: 0, bottom: 0 }} barGap={2}>
          <CartesianGrid stroke={APT_COLORS.grid} strokeDasharray="3 3" vertical={false} />
          <XAxis dataKey="label" tick={AXIS_TICK} axisLine={false} tickLine={false} />
          <YAxis tick={AXIS_TICK} axisLine={false} tickLine={false} tickFormatter={fmtAxis} width={44} />
          <Tooltip cursor={{ fill: '#f1f5f9' }} content={a => {
            const r = tipRow<TrRow>(a)
            const toSt = r ? r.t647 + r.t540 : 0
            return r && <FlowTip title={`Movimientos · ${r.label}`}
              subtitle="Lo que entra a ST debería salir con guía el mismo día; el retorno es sobrante que no se guió." rows={[
                ['Producción a 647', `${fmtTn(r.produccion)} TN`, FLOW_COLOR.PRODUCCION],
                ['647 → ST', `${fmtTn(r.t647)} TN`, ALMACEN_COLOR['647']],
                ['540 → ST', `${fmtTn(r.t540)} TN`, ALMACEN_COLOR['540']],
                ['ST → 647/540', `${fmtTn(r.ret)} TN`, FLOW_COLOR.RETORNO],
                ['% retornado de lo enviado a ST', toSt > 0 ? `${fmtDec1((r.ret / toSt) * 100)} %` : '—'],
                ['Consumo interno', `${fmtTn(r.consumo)} TN`, FLOW_COLOR.CONSUMO],
              ]} />
          }} />
          <Bar dataKey="produccion" fill={FLOW_COLOR.PRODUCCION} maxBarSize={22} radius={[3, 3, 0, 0]} />
          <Bar dataKey="t647" stackId="st" fill={ALMACEN_COLOR['647']} maxBarSize={22} />
          <Bar dataKey="t540" stackId="st" fill={ALMACEN_COLOR['540']} maxBarSize={22} radius={[3, 3, 0, 0]} />
          <Line type="monotone" dataKey="ret" stroke={FLOW_COLOR.RETORNO} strokeWidth={2} strokeDasharray="5 3"
            dot={{ r: 3, fill: '#fff', strokeWidth: 2 }} />
        </ComposedChart>
      </ResponsiveContainer>
    </>
  )
}
