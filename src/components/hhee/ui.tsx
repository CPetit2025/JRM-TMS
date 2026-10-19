'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from 'react';
import { useHhee } from './provider';
import type { Filters } from '@/lib/hhee/types';
export const input = 'w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500';
export const btn = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[#002855] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50';
export const secondary = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-[#002855] disabled:opacity-50';
export function Field({ label, children }: {
    label: string;
    children: ReactNode;
}) { return <label className="grid min-w-0 gap-1 text-sm font-medium text-slate-600">{label}{isValidElement(children) ? cloneElement(children as ReactElement<{ 'aria-label'?: string }>, { 'aria-label': (children.props as { 'aria-label'?: string })['aria-label'] || label }) : children}</label>; }
export function Panel({ title, children }: {
    title: string;
    children: ReactNode;
}) { return <section className="min-w-0 rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5"><h2 className="mb-4 font-bold text-[#002855]">{title}</h2>{children}</section>; }
export function Notice({ children, error = false }: {
    children: ReactNode;
    error?: boolean;
}) { return <div role={error ? 'alert' : 'status'} className={'rounded-lg border p-3 text-sm ' + (error ? 'border-red-200 bg-red-50 text-red-800' : 'border-blue-200 bg-blue-50 text-blue-900')}>{children}</div>; }
export function Badge({ value }: {
    value: string;
}) { return <span className={'inline-flex rounded-full px-2 py-1 text-xs font-semibold ' + (['VALIDADA', 'APROBADA', 'VERIFICADA'].includes(value) ? 'bg-emerald-50 text-emerald-800' : ['RECHAZADA', 'OBSERVADA', 'CANCELADA'].includes(value) ? 'bg-red-50 text-red-800' : 'bg-amber-50 text-amber-900')}>{value.replaceAll('_', ' ')}</span>; }
export function Shell({ title, description, children }: {
    title: string;
    description: string;
    children: ReactNode;
}) {
    const { context: c, error, refresh } = useHhee(), path = usePathname();
    const links = [['/hhee', 'Resumen', true], ['/hhee/solicitudes', 'Solicitudes', true], ['/hhee/aprobaciones', 'Aprobaciones', c?.areas.some(a => a.can_approve || a.can_exception)], ['/hhee/validacion', 'RR. HH.', c?.areas.some(a => a.can_validate)], ['/hhee/acciones', 'Acciones', true], ['/hhee/reportes', 'Informe gerencial', c?.executive_costs || c?.areas.some(a => a.can_approve || a.can_validate)], ['/hhee/configuracion', 'Configuración', c?.config]] as const;
    return <div className="mx-auto grid max-w-[1600px] gap-5 p-4 sm:p-6"><header><p className="text-xs font-semibold tracking-widest text-slate-500">JRM TMS · GESTIÓN OPERATIVA</p><h1 className="mt-1 text-2xl font-bold text-[#002855]">{title}</h1><p className="mt-1 text-sm text-slate-600">{description}</p></header>
 <nav aria-label="Control de horas extras" className="flex gap-1 overflow-x-auto border-b border-slate-200">{links.filter(l => l[2]).map(([href, label]) => <Link key={href} href={href} aria-current={path === href ? 'page' : undefined} className={'shrink-0 border-b-2 px-4 py-3 text-sm font-semibold ' + (path === href ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500')}>{label}</Link>)}</nav>
 {error ? <Notice error>{error} <button className="underline" onClick={() => void refresh()}>Reintentar</button></Notice> : !c ? <p role="status">Cargando permisos y áreas…</p> : children}
 </div>;
}
export function FilterBar({ value, onChange }: {
    value: Filters;
    onChange: (v: Filters) => void;
}) {
    const { context: c } = useHhee();
    const set = (k: keyof Filters, v: string) => onChange({ ...value, [k]: v });
    return <div className="sticky top-0 z-10 grid gap-3 rounded-xl border border-slate-200 bg-white/95 p-4 shadow-sm backdrop-blur sm:grid-cols-3 xl:grid-cols-7">
 <Field label="Desde"><input className={input} type="date" value={value.from} onChange={e => set('from', e.target.value)}/></Field><Field label="Hasta"><input className={input} type="date" value={value.to} onChange={e => set('to', e.target.value)}/></Field>
 <Field label="Sede"><select className={input} value={value.site_id} onChange={e => onChange({ ...value, site_id: e.target.value, area_id: '' })}><option value="">Todas autorizadas</option>{Array.from(new Map(c?.areas.map(a => [a.site_id, a])).values()).map(a => <option key={a.site_id} value={a.site_id}>{a.site_name}</option>)}</select></Field>
 <Field label="Área"><select className={input} value={value.area_id} onChange={e => set('area_id', e.target.value)}><option value="">Todas autorizadas</option>{c?.areas.filter(a => !value.site_id || a.site_id === value.site_id).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
 <Field label="Causa"><select className={input} value={value.cause_id} onChange={e => set('cause_id', e.target.value)}><option value="">Todas</option>{c?.causes.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
 <Field label="Estado"><select className={input} value={value.state} onChange={e => set('state', e.target.value)}><option value="">Todos</option>{['BORRADOR', 'SOLICITADA', 'EJECUTADA', 'VALIDADA', 'CANCELADA'].map(a => <option key={a}>{a}</option>)}</select></Field>
 <Field label="Buscar"><input type="search" className={input} placeholder="HE, actividad o referencia" value={value.search} onChange={e => set('search', e.target.value)}/></Field>
 </div>;
}
export function Table({ headers, children }: {
    headers: string[];
    children: ReactNode;
}) { return <div className="overflow-x-auto rounded-lg border border-slate-200"><table className="w-full text-left text-sm [&_th]:whitespace-nowrap [&_th]:bg-slate-50 [&_th]:p-3 [&_th]:text-xs [&_th]:font-semibold [&_th]:uppercase [&_th]:text-slate-500 [&_td]:border-t [&_td]:border-slate-100 [&_td]:p-3"><thead><tr>{headers.map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>{children}</tbody></table></div>; }
