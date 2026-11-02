'use client'
import { useState, type ReactNode } from 'react'
import Link from 'next/link'
import { AlertTriangle, Camera, FileText, Flag, Image as ImageIcon, MapPin, Receipt, Truck } from 'lucide-react'
import { formatKm } from '@/lib/odometer'
import type { DetailTab } from '@/lib/dispatch-detail'
import { ALERTS, STATUS, TYPE, fmtDate, fmtTime, soles, tn, type JornadaRow } from '@/lib/jornada'
import { JornadaRoutes } from './JornadaRoutes'
import { JornadaDispatchDetail } from './JornadaDispatchDetail'

// Paneles de una jornada (docs/control-jornada-plan.md): los usan el desplegable de la tabla y la vista de detalle,
// con los mismos datos (fleet_workdays). Sin dato se muestra «—»; nunca se inventan horarios ni ubicaciones.

const km = (v: number | null | undefined) => v == null ? '—' : formatKm(v)
const box = 'rounded-xl border border-slate-200 bg-white p-3'
const Row = ({ k, v }: { k: string; v: ReactNode }) => <div className="flex justify-between gap-3 border-b border-slate-100 py-1 text-sm last:border-0"><span className="text-slate-500">{k}</span><span className="text-right font-medium">{v}</span></div>
export const StatusBadge = ({ status }: { status: JornadaRow['status'] }) => status
  ? <span className={`whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ${STATUS[status].tone}`}>{STATUS[status].label}</span> : <span className="text-slate-400">—</span>
const list = (v: string[]) => v.length ? v.join(', ') : '—'

export function InfoPanel({ r }: { r: JornadaRow }) {
  return <section className={box}><h3 className="mb-1 text-sm font-bold text-slate-800">Información de la jornada</h3>
    <Row k="Fecha" v={fmtDate(r.date)} /><Row k="Conductor(es)" v={(r.drivers || []).join(', ') || '—'} /><Row k="Unidad" v={`${r.plate}${r.unit_type ? ` · ${r.unit_type}` : ''}`} />
    <Row k="OT" v={list(r.refs.OT)} /><Row k="OC" v={list(r.refs.OC)} /><Row k="OS" v={list(r.refs.OS)} /><Row k="RQ" v={list(r.refs.RQ)} />
    <Row k="Checklist" v={r.checklists ? <span className={r.operative === false ? 'text-red-700' : 'text-emerald-700'}>{r.checklists} · {r.operative === false ? 'con observaciones' : 'operativa'}</span> : '—'} />
    <Row k="Estado" v={<StatusBadge status={r.status} />} /></section>
}

export function KmPanel({ r }: { r: JornadaRow }) {
  // Diferencia entre fuentes: GPS por debajo del 70 % del odómetro (misma regla que la alerta)
  const gap = r.km_odo != null && r.km_gps != null && r.km_odo > 5 && r.km_gps < r.km_odo * 0.7
  return <section className={box}><h3 className="mb-1 text-sm font-bold text-slate-800">Kilometraje</h3>
    <Row k="Odómetro inicio" v={km(r.odo_start)} />
    <Row k="Odómetro fin" v={<>{km(r.odo_end)}{r.end_source === 'SIGUIENTE_INICIO' && <span className="block text-[11px] font-normal text-amber-700">inferido: inicio del día siguiente (por validar)</span>}</>} />
    <Row k="Km odómetro" v={km(r.km_odo)} /><Row k="Km GPS" v={km(r.km_gps)} /><Row k="Km estimado rutas" v={km(r.km_est)} />
    {gap && <p className="mt-1 flex items-center gap-1 text-xs text-amber-800"><AlertTriangle className="h-3.5 w-3.5" />El GPS registra menos del 70 % del odómetro: recorrido GPS incompleto.</p>}</section>
}

export function OperationPanel({ r }: { r: JornadaRow }) {
  return <section className={box}><h3 className="mb-1 text-sm font-bold text-slate-800">Operación</h3>
    <Row k="Rutas" v={r.routes || '—'} /><Row k="Servicios (entregas, recojos, traslados)" v={r.services || '—'} /><Row k="OT atendidas" v={r.ots || '—'} />
    <Row k="Ton transportada" v={r.tn ? tn(r.tn) : '—'} /><Row k="Toneladas APT" v={r.tn_apt ? tn(r.tn_apt) : '—'} />
    <p className="mt-1 text-[11px] text-slate-500">Carga: APT validado por guía (una guía compartida cuenta una vez); si falta, el peso declarado.</p></section>
}

export function CostPanel({ r, savingsAvailable }: { r: JornadaRow; savingsAvailable: boolean }) {
  const s = r.saving
  return <section className={box}><h3 className="mb-1 text-sm font-bold text-slate-800">Costos</h3>
    <Row k="Valor independiente referencial" v={s?.valued ? `S/ ${soles(s.value)}` : '—'} />
    <Row k="Costo marginal real" v={s?.valued ? `S/ ${soles(s.marginal)}` : '—'} />
    <div className={`mt-1 flex justify-between rounded-lg px-2 py-1.5 text-sm font-bold ${s?.valued ? 'bg-emerald-50 text-emerald-800' : 'bg-slate-50 text-slate-500'}`}><span>Ahorro</span><span>{s?.valued ? `S/ ${soles(s.saving)}` : '—'}</span></div>
    {s?.pending ? <p className="mt-1 text-xs text-amber-800">{s.pending} servicio(s) aprovechado(s) sin valorizar (costo por hora, tarifa o km pendientes).</p> : null}
    {!savingsAvailable && <p className="mt-1 text-xs text-slate-500">Ahorro: requiere acceso al control presupuestal.</p>}
    <Row k="Costos imputados a OT (Caja, combustible)" v={r.cost_total ? `S/ ${soles(r.cost_total)}` : '—'} />
    <p className="mt-1 text-[11px] text-slate-500">El ahorro es un indicador de eficiencia; no es el margen del 20 % de la partida de la OT. <Link href="/despacho/control-presupuestal/ahorro" className="underline">Ver ahorro por servicio</Link></p></section>
}

/** Línea de tiempo solo con eventos registrados (lecturas, salida programada de cada ruta, paradas e incidencias) */
export function Timeline({ r }: { r: JornadaRow }) {
  const items = [
    ...r.readings.map(x => ({ at: x.at, icon: <Flag className="h-4 w-4" />, title: x.kind === 'INICIO' ? 'Inicio de jornada' : 'Cierre de jornada', detail: `Odómetro ${formatKm(x.odometer)}${x.flag ? ` · ${x.flag === 'RETROCESO' ? 'retrocede' : 'salto'}` : ''}` })),
    ...r.dispatches.map(x => ({ at: x.departure, icon: <Truck className="h-4 w-4" />, title: `Ruta ${x.dispatch_number} · salida programada`, detail: [`${x.stops.length} parada(s)`, x.km_real != null ? `recorrido ${formatKm(x.km_real)}` : x.km_gps != null ? `GPS ${formatKm(x.km_gps)}` : null,
      ...x.stops.map(s => `#${s.sequence} ${TYPE[s.type] || s.type} ${s.destination || ''} · ${s.status}`)].filter(Boolean).join(' · ') })),
    ...r.incidents.map(i => ({ at: i.at, icon: <AlertTriangle className="h-4 w-4 text-red-600" />, title: `Incidencia · ${i.type.replaceAll('_', ' ').toLowerCase()}`, detail: [i.dispatch_number && `Ruta ${i.dispatch_number}`, i.detail].filter(Boolean).join(' · ') })),
  ].sort((a, b) => String(a.at).localeCompare(String(b.at)))
  if (!items.length) return <p className="text-sm text-slate-500">Sin eventos registrados en la jornada.</p>
  return <ol className="space-y-2">{items.map((e, i) => <li key={i} className="flex gap-3 rounded-lg border border-slate-200 bg-white p-2 text-sm">
    <span className="mt-0.5 text-[#002855]">{e.icon}</span><span className="min-w-0 flex-1"><b>{e.title}</b><span className="block text-xs text-slate-500">{e.detail}</span></span>
    <span className="whitespace-nowrap text-xs text-slate-500">{fmtTime(e.at)}</span></li>)}</ol>
}

/** Documentos, evidencias y costos de cada ruta: el detalle del despacho original (Torre de Control) */
export function RouteSources({ r, tab }: { r: JornadaRow; tab: DetailTab }) {
  const [open, setOpen] = useState<{ id: string; request?: string } | null>(null)
  if (!r.dispatches.length) return <p className="text-sm text-slate-500">Sin rutas en la jornada.</p>
  return <div className="space-y-2">{r.dispatches.map(x => <div key={x.dispatch_number} className="rounded-lg border border-slate-200 bg-white p-2 text-sm">
    <p className="font-semibold">Ruta {x.dispatch_number} <span className="font-normal text-slate-500">· {x.status}</span></p>
    <div className="mt-1 flex flex-wrap gap-1.5">{x.stops.map(s => <button key={s.request_number} type="button" disabled={!x.id} onClick={() => x.id && setOpen({ id: x.id, request: s.request_id })}
      className="rounded-md border border-slate-300 px-2 py-1 text-xs font-semibold text-[#002855] hover:bg-slate-50 disabled:opacity-50">{s.request_number}{s.guide ? ` · GR ${s.guide}` : ''}</button>)}</div>
  </div>)}
    {open && <JornadaDispatchDetail dispatchId={open.id} requestId={open.request} tab={tab} onClose={() => setOpen(null)} />}</div>
}

const TABS = [['jornada', 'Detalle de la jornada', FileText], ['rutas', 'Rutas y paradas', MapPin], ['costos', 'Costos', Receipt],
  ['documentos', 'Documentos', FileText], ['evidencias', 'Evidencias', Camera]] as const
/** Desplegable de una fila de la tabla: los mismos paneles que la vista de detalle */
export function JornadaExpand({ r, savingsAvailable, openPhoto }: { r: JornadaRow; savingsAvailable: boolean; openPhoto: (path: string) => void | Promise<void> }) {
  const [tab, setTab] = useState<typeof TABS[number][0]>('jornada')
  return <div className="grid gap-3 lg:grid-cols-[13rem_minmax(0,1fr)]">
    <nav className="flex gap-1 overflow-x-auto lg:flex-col" aria-label="Secciones de la jornada">{TABS.map(([k, label, Icon]) => <button key={k} type="button" onClick={() => setTab(k)} aria-pressed={tab === k}
      className={`flex items-center gap-2 whitespace-nowrap rounded-lg px-3 py-2 text-left text-sm font-semibold ${tab === k ? 'bg-[#002855] text-white' : 'bg-white text-slate-700 hover:bg-slate-100'}`}><Icon className="h-4 w-4" />{label}</button>)}</nav>
    <div className="min-w-0">
      {tab === 'jornada' && <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3"><InfoPanel r={r} /><KmPanel r={r} /><OperationPanel r={r} /></div>}
      {tab === 'rutas' && <div className="space-y-3"><Timeline r={r} /><JornadaRoutes d={r} openPhoto={openPhoto} /></div>}
      {tab === 'costos' && <div className="grid gap-3 md:grid-cols-2"><CostPanel r={r} savingsAvailable={savingsAvailable} /><RouteSources r={r} tab="costos" /></div>}
      {tab === 'documentos' && <RouteSources r={r} tab="documentos" />}
      {tab === 'evidencias' && <div className="space-y-2">
        {r.readings.length > 0 && <div className="flex flex-wrap gap-2 text-xs">{r.readings.map((x, i) => <button key={i} type="button" onClick={() => void openPhoto(x.photo)} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 bg-white px-2 py-1 hover:bg-slate-100">
          <ImageIcon className="h-3.5 w-3.5" />Odómetro {x.kind === 'INICIO' ? 'inicio' : 'cierre'} {fmtTime(x.at)}</button>)}</div>}
        <RouteSources r={r} tab="evidencias" /></div>}
      {r.alerts.length > 0 && <p className="mt-2 flex flex-wrap gap-1">{r.alerts.map(a => <span key={a} className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${ALERTS[a]?.tone || 'bg-slate-100'}`}>{ALERTS[a]?.label || a}</span>)}</p>}
    </div>
  </div>
}
