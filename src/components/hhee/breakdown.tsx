'use client';
import { useState } from 'react';
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import type { Data } from '@/lib/hhee/types';
import { hours, money } from '@/lib/hhee/core';
import { Panel, Table } from './ui';
export function HourBreakdown({ data: d }: { data: Data }) {
    const m = d.metrics, [selected, setSelected] = useState('');
    const categories = [{ name: 'HHEE 25%', minutes: m.minutes_25 ?? 0, factor: '1,25 × base' }, { name: 'HHEE 35%', minutes: m.minutes_35 ?? 0, factor: '1,35 × base' }, { name: 'HHEE 100%', minutes: m.minutes_100 ?? 0, factor: '2 × base' }, { name: 'Sin desglose', minutes: m.unclassified_minutes ?? 0, factor: 'Pendiente de clasificación' }].map(c => ({ ...c, hours: c.minutes / 60 }));
    return <Panel title="Distribución de horas · ejecución validada">
        <div className="grid gap-5 lg:grid-cols-2"><div className="h-56"><ResponsiveContainer><BarChart data={categories} margin={{ left: 0, right: 15 }}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="name" tick={{ fontSize: 11 }}/><YAxis /><Tooltip formatter={v => [String(v) + ' h', 'HHEE']}/><Bar dataKey="hours" fill="#0055a5" cursor="pointer" onClick={v => { const p = v as unknown as { name?: string; payload?: { name?: string } }; setSelected(p.payload?.name || p.name || ''); }}/></BarChart></ResponsiveContainer></div>
        <div className="grid gap-3"><Table headers={['Tipo de hora', 'Cantidad', 'Cálculo aproximado']}>{categories.filter(c => !selected || c.name === selected).map(c => <tr key={c.name}><td>{c.name}</td><td>{hours(c.minutes)}</td><td>{c.factor}</td></tr>)}</Table>{selected && <button className="text-left text-sm text-blue-700 underline" onClick={() => setSelected('')}>Mostrar todas las categorías</button>}<p className="text-sm"><b>Horas normales de referencia:</b> {hours(m.normal_minutes)}{d.cost_visible && <> · Costo aprox.: {money(m.normal_estimated_cost)}</>}</p></div></div>
        <p className="mt-3 text-xs text-slate-500">Las horas normales se registran una sola vez por trabajador y día y se excluyen del total y costo de HHEE. Los costos son aproximados: conceptos mensuales computables ÷ horas mensuales de referencia. Los registros anteriores sin categorías permanecen sin desglose.</p>
    </Panel>;
}
