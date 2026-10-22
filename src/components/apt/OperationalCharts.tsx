'use client'

import { Area, Bar, BarChart, Brush, CartesianGrid, Cell, ComposedChart, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts'
import type { AptOperationalSummary } from '@/lib/apt/types'
import { ALMACEN_COLOR, flowNodeLabel } from '@/lib/apt/flowColors'
import type { FlowAlmacen } from '@/lib/apt/flowTypes'
import { fmtDate, fmtTn } from '@/lib/apt/format'
import { fmtAxis } from './dashCharts'

const tick = { fontSize: 11, fill: '#64748b' }
export function OperationalTrend({ data, mode }: { data: AptOperationalSummary['series']; mode: 'stock' | 'movements' }) {
  return <ResponsiveContainer width="100%" height={310}><ComposedChart data={data} syncId="apt-operation" margin={{ top: 8, right: 8, left: 0, bottom: 0 }}>
    <CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} /><XAxis dataKey="fecha" tick={tick} tickFormatter={v => fmtDate(String(v))} minTickGap={32} /><YAxis tick={tick} tickFormatter={fmtAxis} width={48} />
    <Tooltip labelFormatter={v => fmtDate(String(v))} formatter={(value, name) => [`${fmtTn(Number(value))} TN`, String(name)]} /><Legend wrapperStyle={{ fontSize: 11 }} />
    {mode === 'stock' ? <Area type="stepAfter" dataKey="stock_tn" name="Saldo reconstruido" stroke="#002855" fill="#dbeafe" strokeWidth={2} /> : <><Bar dataKey="production_tn" name="Producción" fill="#2563eb" maxBarSize={24} /><Bar dataKey="dispatch_tn" name="Salida ERP" fill="#0d9488" maxBarSize={24} /></>}
    {data.length > 2 && <Brush dataKey="fecha" height={24} stroke="#94a3b8" tickFormatter={v => fmtDate(String(v))} travellerWidth={10} />}
  </ComposedChart></ResponsiveContainer>
}

export function WarehouseStock({ data, selected, onSelect }: { data: AptOperationalSummary['warehouses']; selected?: string; onSelect: (almacen: FlowAlmacen) => void }) {
  return <><ResponsiveContainer width="100%" height={260}><BarChart data={data} margin={{ top: 8, right: 8, left: 0, bottom: 0 }}><CartesianGrid stroke="#e2e8f0" strokeDasharray="3 3" vertical={false} /><XAxis dataKey="almacen" tick={tick} tickFormatter={flowNodeLabel} /><YAxis tick={tick} tickFormatter={fmtAxis} width={48} /><Tooltip labelFormatter={v => flowNodeLabel(String(v))} formatter={value => [`${fmtTn(Number(value))} TN`, 'Saldo reconstruido']} /><Bar dataKey="stock_tn" radius={[6, 6, 0, 0]} cursor="pointer" maxBarSize={100} onClick={(_, index) => { const row = data[index]; if (row && ['647', '540', 'ST'].includes(row.almacen)) onSelect(row.almacen as FlowAlmacen) }}>{data.map(row => <Cell key={row.almacen} fill={ALMACEN_COLOR[row.almacen as FlowAlmacen] || '#64748b'} opacity={selected && selected !== row.almacen ? 0.4 : 1} />)}</Bar></BarChart></ResponsiveContainer><div className="flex flex-wrap gap-2">{data.map(row => <button type="button" key={row.almacen} onClick={() => onSelect(row.almacen as FlowAlmacen)} aria-pressed={selected === row.almacen} className="rounded-lg border border-slate-200 px-3 py-2 text-xs text-[#002855] hover:bg-blue-50">{flowNodeLabel(row.almacen)} · {fmtTn(row.stock_tn)} TN</button>)}</div></>
}
