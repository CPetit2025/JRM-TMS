'use client'
import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, ArrowRight, Box, Camera, CheckCircle2, ClipboardList, Coins, FileText, Flag, Gauge, Image as ImageIcon, MapPin, Receipt, Route, TrendingUp, Truck } from 'lucide-react'
import { formatKm } from '@/lib/odometer'
import type { DetailTab } from '@/lib/dispatch-detail'
import { ALERTS, STATUS, TYPE, fmtDate, fmtTime, soles, tn, type JornadaRow } from '@/lib/jornada'
import { JornadaRoutes } from './JornadaRoutes'
import { JornadaDispatchDetail } from './JornadaDispatchDetail'

// Paneles de una jornada (docs/control-jornada-plan.md): los usan el desplegable de la tabla (bosquejo 1) y la vista de
// detalle (bosquejo 2), con los mismos datos (fleet_workdays). Sin dato se muestra «—»; nunca se inventan horarios.

const km = (v: number | null | undefined) => v == null ? '—' : formatKm(v)
const list = (v: string[]) => v.length ? v.join(', ') : '—'

export const StatusBadge = ({ status }: { status: JornadaRow['status'] }) => status
  ? <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-lg px-2.5 py-1 text-xs font-bold ${STATUS[status].tone}`}>
    {status === 'CERRADA' && <CheckCircle2 className="h-4 w-4" aria-hidden />}{STATUS[status].label}</span>
  : <span className="text-slate-400">—</span>

/** Tarjeta con banda azul marino (bosquejo 2) */
export function Panel({ title, icon, children, className = '' }: { title: string; icon: ReactNode; children: ReactNode; className?: string }) {
  return <section className={`overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm ${className}`}>
    <h3 className="flex items-center gap-2 bg-[#0b2a4a] px-4 py-2.5 text-base font-bold text-white">{icon}{title}</h3>
    <div className="px-4 py-3">{children}</div></section>
}
const KV = ({ k, v, icon, strong = false }: { k: string; v: ReactNode; icon?: ReactNode; strong?: boolean }) =>
  <div className={`flex items-center justify-between gap-3 border-b border-slate-100 py-2 text-sm last:border-0 ${strong ? 'rounded-lg bg-blue-50 px-2 font-bold' : ''}`}>
    <span className="flex items-center gap-2 font-semibold text-slate-700">{icon}{k}</span><span className="text-right font-medium text-slate-900">{v}</span></div>

export function InfoPanel({ r }: { r: JornadaRow }) {
  return <Panel title="Información de la jornada" icon={<ClipboardList className="h-5 w-5" />}>
    <KV k="Fecha" v={fmtDate(r.date)} /><KV k="Conductor" v={(r.drivers || []).join(', ') || '—'} /><KV k="Unidad" v={`${r.plate}${r.unit_type ? ` · ${r.unit_type}` : ''}`} />
    <KV k="OT" v={list(r.refs.OT)} /><KV k="OC" v={list(r.refs.OC)} /><KV k="OS" v={list(r.refs.OS)} /><KV k="RQ" v={list(r.refs.RQ)} />
    <KV k="Checklist" v={r.checklists ? <span className={r.operative === false ? 'text-red-700' : 'text-emerald-700'}>Checklist: {r.checklists} · {r.operative === false ? 'con observaciones' : 'operativa'}</span> : '—'} />
    <KV k="Estado" v={<StatusBadge status={r.status} />} /></Panel>
}

export function KmPanel({ r }: { r: JornadaRow }) {
  // Diferencia entre fuentes: GPS por debajo del 70 % del odómetro (misma regla que la alerta)
  const gap = r.km_odo != null && r.km_gps != null && r.km_odo > 5 && r.km_gps < r.km_odo * 0.7
  return <Panel title="Kilometraje" icon={<Route className="h-5 w-5" />}>
    <KV k="Odómetro inicio" v={km(r.odo_start)} />
    <KV k="Odómetro fin" v={<>{km(r.odo_end)}{r.end_source === 'SIGUIENTE_INICIO' && <span className="block text-[11px] font-semibold text-amber-700">inferido: inicio del día siguiente</span>}</>} />
    <KV k="Km odómetro" v={km(r.km_odo)} strong /><KV k="Km GPS" v={km(r.km_gps)} /><KV k="Km estimado rutas" v={km(r.km_est)} />
    {gap && <p className="mt-2 flex items-center gap-1 rounded-lg bg-amber-50 px-2 py-1.5 text-xs font-semibold text-amber-800"><AlertTriangle className="h-4 w-4" />GPS por debajo del 70 % del odómetro: recorrido GPS incompleto.</p>}</Panel>
}

export function OperationPanel({ r }: { r: JornadaRow }) {
  return <Panel title="Operación" icon={<Box className="h-5 w-5" />}>
    <KV k="Rutas" v={r.routes || '—'} /><KV k="Servicios" v={r.services || '—'} /><KV k="OT atendidas" v={r.ots || '—'} />
    <KV k="Ton transportada" v={r.tn ? tn(r.tn) : '—'} /><KV k="Toneladas APT" v={r.tn_apt ? tn(r.tn_apt) : '—'} />
    <p className="mt-2 text-[11px] text-slate-500">APT validado por guía (una guía compartida cuenta una vez); si falta, el peso declarado.</p></Panel>
}

export function CostPanel({ r, savingsAvailable }: { r: JornadaRow; savingsAvailable: boolean }) {
  const s = r.saving
  return <Panel title="Costos" icon={<Coins className="h-5 w-5" />}>
    <KV k="Valor independiente referencial" v={s?.valued ? `S/ ${soles(s.value)}` : '—'} />
    <KV k="Costo marginal real" v={s?.valued ? `S/ ${soles(s.marginal)}` : '—'} />
    <div className={`mt-1 flex items-center justify-between rounded-lg px-3 py-2.5 text-base font-bold ${s?.valued ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-50 text-slate-500'}`}>
      <span>Ahorro:</span><span>{s?.valued ? `S/ ${soles(s.saving)}` : s?.pending ? 'Pendiente' : '—'}</span></div>
    {s?.pending ? <p className="mt-1 text-xs text-amber-800">{s.pending} servicio(s) sin valorizar (costo por hora, tarifa o km pendientes).</p> : null}
    {!savingsAvailable && <p className="mt-1 text-xs text-slate-500">El ahorro requiere acceso al control presupuestal.</p>}
    <p className="mt-2 text-[11px] text-slate-500">Indicador de eficiencia; no es el margen del 20 % de la partida. <Link href="/despacho/control-presupuestal/ahorro" className="font-semibold underline">Ver por servicio</Link></p></Panel>
}

/** Línea de tiempo solo con eventos registrados (lecturas, salida programada de cada ruta, paradas e incidencias) */
export function Timeline({ r }: { r: JornadaRow }) {
  const items = [
    ...r.readings.map(x => ({ at: x.at, kind: 'flag' as const, title: x.kind === 'INICIO' ? 'Inicio de jornada' : 'Fin de jornada', place: `Odómetro: ${formatKm(x.odometer)}${x.flag ? ` · ${x.flag === 'RETROCESO' ? 'retrocede' : 'salto'}` : ''}`, right: '' })),
    ...r.dispatches.map(x => ({ at: x.departure, kind: 'route' as const, title: `Ruta ${x.dispatch_number}`, place: x.stops.map(s => `${TYPE[s.type] || s.type} ${s.destination || s.client || ''}`.trim()).join(' · ') || 'Sin paradas',
      right: x.km_real != null ? `Recorrido: ${formatKm(x.km_real)}` : x.km_gps != null ? `GPS: ${formatKm(x.km_gps)}` : '' })),
    ...r.incidents.map(i => ({ at: i.at, kind: 'incident' as const, title: `Incidencia · ${i.type.replaceAll('_', ' ').toLowerCase()}`, place: [i.dispatch_number && `Ruta ${i.dispatch_number}`, i.detail].filter(Boolean).join(' · '), right: '' })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)))
  if (!items.length) return <p className="text-sm text-slate-500">Sin eventos registrados en la jornada.</p>
  return <ol className="relative space-y-2 pl-6 before:absolute before:bottom-3 before:left-[9px] before:top-3 before:w-0.5 before:bg-slate-200">{items.map((e, i) => <li key={i} className="relative">
    <span className={`absolute -left-6 top-3 h-4 w-4 rounded-full border-[3px] bg-white ${e.kind === 'flag' ? 'border-emerald-600' : e.kind === 'incident' ? 'border-red-600' : 'border-blue-600'}`} />
    <div className="grid gap-2 rounded-xl border border-slate-200 bg-white p-3 text-sm sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center">
      <span className="flex items-center gap-2">{e.kind === 'flag' ? <Flag className="h-5 w-5 text-[#0b2a4a]" /> : e.kind === 'incident' ? <AlertTriangle className="h-5 w-5 text-red-600" /> : <Truck className="h-5 w-5 text-[#0b2a4a]" />}
        <span><b className="block">{e.title}</b><span className="text-xs text-slate-500">{fmtTime(e.at)} h</span></span></span>
      <span className="flex items-start gap-1.5 text-slate-700"><MapPin className="mt-0.5 h-4 w-4 shrink-0 text-slate-400" />{e.place}</span>
      <span className="text-xs font-semibold text-slate-600">{e.right}</span></div></li>)}</ol>
}

/** Documentos, evidencias y costos de cada ruta: el detalle del despacho original (Torre de Control) */
export function RouteSources({ r, tab }: { r: JornadaRow; tab: DetailTab }) {
  const [open, setOpen] = useState<{ id: string; request?: string } | null>(null)
  if (!r.dispatches.length) return <p className="text-sm text-slate-500">Sin rutas en la jornada.</p>
  return <div className="space-y-2">{r.dispatches.map(x => <div key={x.dispatch_number} className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
    <p className="flex items-center gap-2 font-bold text-[#0b2a4a]"><Truck className="h-4 w-4" />Ruta {x.dispatch_number} <span className="font-normal text-slate-500">· {x.status}</span></p>
    <div className="mt-2 flex flex-wrap gap-1.5">{x.stops.map(s => <button key={s.request_number} type="button" disabled={!x.id} onClick={() => x.id && setOpen({ id: x.id, request: s.request_id })}
      className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-[#0b2a4a] hover:bg-slate-50 disabled:opacity-50"><FileText className="h-3.5 w-3.5" />{s.request_number}{s.guide ? ` · GR ${s.guide}` : ''}</button>)}</div>
  </div>)}
    {open && <JornadaDispatchDetail dispatchId={open.id} requestId={open.request} tab={tab} onClose={() => setOpen(null)} />}</div>
}

// ---- Desplegable de la tabla (bosquejo 1) ----
const Tile = ({ label, value, tone }: { label: string; value: ReactNode; tone: string }) =>
  <div className={`rounded-xl px-4 py-3 ${tone}`}><p className="text-sm font-semibold">{label}</p><p className="text-xl font-bold">{value}</p></div>

function InfoTable({ r }: { r: JornadaRow }) {
  const rowsKV: Array<[string, ReactNode]> = [['Fecha', fmtDate(r.date)], ['Conductor', (r.drivers || []).join(', ') || '—'], ['Unidad', r.plate], ['Rutas', r.routes || '—'],
    ['OT', list(r.refs.OT)], ['OC / OS / RQ', list([...r.refs.OC, ...r.refs.OS, ...r.refs.RQ])], ['Carga transportada', r.tn ? tn(r.tn) : '—'], ['Carga APT', r.tn_apt ? tn(r.tn_apt) : '—']]
  return <section><h4 className="mb-2 flex items-center gap-2 text-base font-bold text-[#0b2a4a]"><ClipboardList className="h-5 w-5" />Información general</h4>
    <div className="overflow-hidden rounded-xl border border-slate-200">{rowsKV.map(([k, v], i) => <div key={k} className={`grid grid-cols-[9rem_minmax(0,1fr)] gap-3 px-4 py-1.5 text-sm ${i % 2 ? 'bg-white' : 'bg-slate-50'}`}>
      <span className="font-semibold text-slate-800">{k}:</span><span className="text-slate-700">{v}</span></div>)}</div></section>
}
function KmCost({ r, savingsAvailable }: { r: JornadaRow; savingsAvailable: boolean }) {
  const s = r.saving
  return <section className="space-y-4">
    <div><h4 className="mb-2 flex items-center gap-2 text-base font-bold text-[#0b2a4a]"><Route className="h-5 w-5" />Recorrido y kilometraje</h4>
      <div className="grid gap-2 sm:grid-cols-[1fr_auto_1fr_1fr_1fr_1fr] sm:items-center">
        <Tile label="Inicio" value={km(r.odo_start)} tone="bg-slate-100 text-slate-900" /><ArrowRight className="mx-auto hidden h-5 w-5 text-slate-500 sm:block" />
        <Tile label={r.end_source === 'SIGUIENTE_INICIO' ? 'Fin (inferido)' : 'Fin'} value={km(r.odo_end)} tone="bg-slate-100 text-slate-900" />
        <Tile label="Recorrido" value={km(r.km_odo)} tone="bg-blue-100 text-blue-900" /><Tile label="GPS" value={km(r.km_gps)} tone="bg-violet-100 text-violet-900" />
        <Tile label="Est. ruta" value={km(r.km_est)} tone="bg-slate-100 text-slate-900" /></div></div>
    <div><h4 className="mb-2 flex items-center gap-2 text-base font-bold text-[#0b2a4a]"><Coins className="h-5 w-5" />Costos de la jornada (S/)</h4>
      <div className="grid gap-2 sm:grid-cols-3">
        <Tile label="Valor referencial" value={s?.valued ? `S/ ${soles(s.value)}` : '—'} tone="border border-slate-200 bg-white text-slate-900" />
        <Tile label="Costo real" value={s?.valued ? `S/ ${soles(s.marginal)}` : '—'} tone="border border-slate-200 bg-white text-slate-900" />
        <div className={`flex items-center gap-3 rounded-xl px-4 py-3 ${s?.valued ? 'border border-emerald-300 bg-emerald-50 text-emerald-800' : 'border border-slate-200 bg-slate-50 text-slate-500'}`}>
          <TrendingUp className="h-7 w-7" /><div><p className="text-sm font-semibold">Ahorro</p><p className="text-xl font-bold">{s?.valued ? `S/ ${soles(s.saving)}` : s?.pending ? 'Pendiente' : '—'}</p></div></div></div>
      {!savingsAvailable && <p className="mt-1 text-xs text-slate-500">El ahorro requiere acceso al control presupuestal.</p>}</div>
  </section>
}

const TABS = [['jornada', 'Detalle de la jornada', FileText], ['rutas', 'Rutas y paradas', MapPin], ['costos', 'Costos', Receipt],
  ['documentos', 'Documentos', Gauge], ['evidencias', 'Evidencias', ImageIcon]] as const
/** Desplegable de una fila de la tabla: los mismos datos y paneles que la vista de detalle */
export function JornadaExpand({ r, savingsAvailable, openPhoto }: { r: JornadaRow; savingsAvailable: boolean; openPhoto: (path: string) => void | Promise<void> }) {
  const [tab, setTab] = useState<typeof TABS[number][0]>('jornada')
  return <div className="grid gap-4 lg:grid-cols-[15rem_minmax(0,1fr)]">
    <nav className="flex gap-1 overflow-x-auto rounded-xl border border-slate-200 bg-white p-1 lg:flex-col" aria-label="Secciones de la jornada">{TABS.map(([k, label, Icon]) =>
      <button key={k} type="button" onClick={() => setTab(k)} aria-pressed={tab === k}
        className={`flex items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2.5 text-left text-sm font-semibold ${tab === k ? 'bg-[#0b2a4a] text-white' : 'text-slate-700 hover:bg-slate-100'}`}>
        <Icon className="h-5 w-5" />{label}</button>)}</nav>
    <div className="min-w-0">
      {tab === 'jornada' && <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)] xl:divide-x xl:divide-slate-200"><InfoTable r={r} /><div className="xl:pl-4"><KmCost r={r} savingsAvailable={savingsAvailable} /></div></div>}
      {tab === 'rutas' && <div className="space-y-3"><Timeline r={r} /><JornadaRoutes d={r} openPhoto={openPhoto} /></div>}
      {tab === 'costos' && <div className="grid gap-3 lg:grid-cols-2"><CostPanel r={r} savingsAvailable={savingsAvailable} /><RouteSources r={r} tab="costos" /></div>}
      {tab === 'documentos' && <RouteSources r={r} tab="documentos" />}
      {tab === 'evidencias' && <div className="space-y-2">
        {r.readings.length > 0 && <div className="flex flex-wrap gap-2 text-xs">{r.readings.map((x, i) => <button key={i} type="button" onClick={() => void openPhoto(x.photo)}
          className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 py-1.5 font-semibold text-[#0b2a4a] hover:bg-slate-50">
          <Camera className="h-4 w-4" />Odómetro {x.kind === 'INICIO' ? 'inicio' : 'cierre'} · {fmtTime(x.at)}</button>)}</div>}
        <RouteSources r={r} tab="evidencias" /></div>}
      {r.alerts.length > 0 && <p className="mt-3 flex flex-wrap gap-1">{r.alerts.map(a => <span key={a} className={`rounded-md px-2 py-0.5 text-xs font-semibold ${ALERTS[a]?.tone || 'bg-slate-100'}`}>{ALERTS[a]?.label || a}</span>)}</p>}
    </div>
  </div>
}
