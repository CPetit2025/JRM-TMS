'use client';
import { useState } from 'react';
import Link from 'next/link';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, LineChart, Line } from 'recharts';
import { initialFilters, hours, money, dateLabel } from '@/lib/hhee/core';
import { useData } from './data';
import { FilterBar, Notice, Panel, Shell, Table, secondary } from './ui';
export function Dashboard() {
    const [filters, setFilters] = useState(initialFilters), { data: d, error, loading } = useData(filters);
    const m = d?.metrics;
    const pct = (n: number, den: number) => den ? Math.round(n / den * 100) + '%' : 'Sin datos';
    return <Shell title="Control de horas extras" description="Necesidad operativa, aprobación previa y resultados. Información validada para la toma de decisiones.">
 <FilterBar value={filters} onChange={setFilters}/>{error && <Notice error>{error}</Notice>}{loading && <p role="status">Actualizando indicadores…</p>}
 {d && m && <>
 <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-slate-500"><span>Corte: {dateLabel(d.generated_at)} · hora de Lima</span><Link className={secondary} href="/hhee/reportes">Preparar informe para Gerencia</Link></div>
 <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
 {[['Horas validadas', hours(m.validated_minutes), hours(m.pending_minutes) + ' ejecutadas por validar'], ['Costo validado conocido', d.cost_visible ? money(m.validated_cost) : 'Acceso restringido', d.cost_visible ? m.pending_cost + ' filas pendientes de valorización' : 'Sin remuneraciones individuales'], ['Aprobación previa', pct(m.prior_requests, m.executed_requests), m.prior_requests + ' de ' + m.executed_requests + ' solicitudes ejecutadas'], ['HHEE recurrentes', pct(m.recurrent_minutes, m.validated_minutes), hours(m.recurrent_minutes) + ' validadas · no equivale a evitables']].map(([label, value, sub]) => <Panel key={label} title={label}><p className="text-3xl font-bold text-[#002855]">{value}</p><p className="mt-2 text-xs text-slate-500">{sub}</p></Panel>)}
 </div>
 <div className="grid gap-4 lg:grid-cols-2"><Panel title="Evolución diaria · horas validadas">
 {!d.trend.length ? <Notice>Aún no hay ejecuciones validadas en este período.</Notice> : <><p className="mb-3 text-xs text-slate-500">Seleccione un punto para consultar ese día.</p><div className="h-64"><ResponsiveContainer><LineChart data={d.trend} margin={{ right: 20, top: 10 }} onClick={e => { const day = String(e?.activeLabel || ""); if (/^\d{4}-\d{2}-\d{2}$/.test(day))
            setFilters({ ...filters, from: day, to: day }); }}><CartesianGrid strokeDasharray="3 3"/><XAxis dataKey="day" tick={{ fontSize: 10 }}/><YAxis /><Tooltip /><Line dataKey="hours" name="Horas validadas" stroke="#0055a5" strokeWidth={3} dot={{ r: 5 }}/></LineChart></ResponsiveContainer></div></>}
 </Panel><Panel title="Causas operativas · priorización">
 {!d.causes.length ? <Notice>Las causas aparecerán al validar la ejecución.</Notice> : <><p className="mb-3 text-xs text-slate-500">Seleccione una barra para filtrar por causa. Tabla accesible debajo.</p><div className="h-64"><ResponsiveContainer><BarChart data={d.causes} layout="vertical" margin={{ left: 5, right: 20 }}><CartesianGrid strokeDasharray="3 3"/><XAxis type="number"/><YAxis type="category" dataKey="name" width={140} tick={{ fontSize: 10 }}/><Tooltip /><Bar dataKey="hours" name="Horas validadas" fill="#0055a5" cursor="pointer" onClick={v => { const bar = v as unknown as {id?: string;payload?:{id?:string}}; const id = bar.payload?.id || bar.id; if (id)
            setFilters({ ...filters, cause_id: id }); }}/></BarChart></ResponsiveContainer></div><div className="flex flex-wrap gap-2">{d.causes.map(c => <button key={c.id} className="rounded-lg bg-blue-50 p-2 text-xs text-blue-800" onClick={() => setFilters({ ...filters, cause_id: c.id })}>{c.name}: {hours(c.hours * 60)}</button>)}</div></>}
 </Panel></div>
 <Panel title="Evaluación de la necesidad · horas validadas"><div className="grid gap-4 sm:grid-cols-3">{[['Necesarias / justificadas', m.justified_minutes], ['Mejorables con planificación', m.improvable_minutes], ['Por determinar', m.unassessed_minutes]].map(([label, value]) => <div key={label}><p className="text-xs text-slate-500">{label}</p><p className="mt-1 text-2xl font-bold text-[#002855]">{hours(Number(value))}</p></div>)}</div><p className="mt-3 text-xs text-slate-500">Evaluación confirmada por RR. HH. La recurrencia se analiza por separado: una necesidad puede estar justificada y ser recurrente.</p></Panel>
 <Panel title="Resultados por área"><Table headers={['Área', 'Horas validadas', ...(d.cost_visible ? ['Costo conocido', 'Sin valorizar'] : []), 'Metas logradas / definidas', 'Detalle']}>
 {d.areas.map(a => <tr key={a.id}><td className="font-semibold">{a.name}</td><td>{hours(a.hours * 60)}</td>{d.cost_visible && <><td>{money(a.cost)}</td><td>{a.pending_cost}</td></>}<td>{a.targets_met} / {a.targets_defined}</td><td><button className="font-semibold text-blue-700 underline" onClick={() => setFilters({ ...filters, area_id: a.id })}>Filtrar área</button></td></tr>)}
 {!d.areas.length && <tr><td colSpan={6}>Sin resultados validados. Registre, importe y valide las primeras ejecuciones.</td></tr>}</Table><p className="mt-3 text-xs text-slate-500">Las metas se cuentan por solicitud; no se suman unidades diferentes como toneladas, despachos o equipos.</p></Panel>
 <div className="grid gap-4 sm:grid-cols-2"><Panel title="Excepciones por revisar"><p className="text-3xl font-bold text-amber-700">{m.pending_exceptions}</p><Link className="mt-2 inline-block text-sm text-blue-700 underline" href="/hhee/aprobaciones">Revisión independiente de Gerencia</Link></Panel><Panel title="Acciones vencidas"><p className="text-3xl font-bold text-red-700">{d.actions_overdue}</p><Link className="mt-2 inline-block text-sm text-blue-700 underline" href="/hhee/acciones">Gestionar causas y medidas correctivas</Link></Panel></div>
 <Notice>La aprobación autoriza la necesidad prevista. La validación de RR. HH. confirma la ejecución y el costo. Las horas sin aprobación se registran y se revisan como excepción; este módulo no calcula descuentos ni sustituye planillas.</Notice>
 </>}
 </Shell>;
}
