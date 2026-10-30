"use client"
import { useCallback, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { CheckCircle2, Loader2, RefreshCw, Search, Send, ShieldCheck, Undo2, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { PageHeader } from '@/components/ui/page-header'
import { Modal } from '@/components/ui/modal'
import { errorMessage, money } from '@/lib/caja'
import { DispatchFreightStages } from '@/components/despacho/DispatchFreightStages'
import { ServiceCostIndicators } from '@/components/despacho/ServiceCostIndicators'
import { BILLING_LABEL, CONCEPT_LABEL, ORIGIN_LABEL } from '@/components/despacho/InheritedSpecialServices'

// Cierre económico por ruta (Etapa 4), separado del cierre documentario: se valida el costo final de cada servicio
// (flete, grúa, montacarga, estiba) con sus reglas de cobro, Programación lo envía a revisión y quien tiene el permiso
// «Cierre económico» lo aprueba (impacta la partida solo por la diferencia), lo observa o lo reabre.

type State = { status: string; route_status: string; pending: string[]; referential_pen: number; agreed_pen: number; final_pen: number | null; extras_pen: number }
type Route = { dispatch_id: string; dispatch_number: string; status: string; departure: string | null; plate: string | null; contracts: string | null; requests: string | null; state: State }
type Service = {
  id: string; request_number: string; concept: string; description: string | null; status: string; origin: string | null; supplier: string | null
  billing_unit: string | null; agreed_rate: number | null; agreed_qty: number | null; workers: number | null; min_billable_qty: number | null; fraction_minutes: number | null
  estimated_pen: number; planned_pen: number | null; actual_pen: number | null; expense_id: string | null; forklift_hours: number | null
  final_executed_qty: number | null; final_workers: number | null; final_billable_qty: number | null; final_extras_pen: number | null
  final_pen: number | null; final_reason: string | null; final_validated_at: string | null
}
type ClosureEvent = { action: string; from_status: string | null; to_status: string; reason: string | null; created_at: string; user: string | null; detail: { budget_delta_by_contract?: Record<string, number> } }
type Detail = {
  success: true; dispatch_number: string; route_status: string; departure: string | null; plate: string | null; state: State; observation: string | null
  can_validate: boolean; can_approve: boolean; services: Service[]; voided: { concept: string; request_number: string; reason: string | null }[]; events: ClosureEvent[]
}

const supabase = createClient()
const STATUS: Record<string, { label: string; cls: string }> = {
  PENDIENTE: { label: 'Pendiente de validación económica', cls: 'bg-amber-100 text-amber-800' },
  EN_REVISION: { label: 'En revisión económica', cls: 'bg-blue-100 text-blue-800' },
  OBSERVADO: { label: 'Observado económicamente', cls: 'bg-red-100 text-red-700' },
  CERRADO: { label: 'Cierre económico completado', cls: 'bg-emerald-100 text-emerald-800' },
}
const ACTION_LABEL: Record<string, string> = { ENVIAR: 'Enviado a revisión', APROBAR: 'Aprobado y cerrado', OBSERVAR: 'Observado', REABRIR: 'Reabierto' }
const limaDate = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)
const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : '—')
const variation = (base: number, value: number | null) => {
  if (value == null) return null
  const d = Math.round((value - base) * 100) / 100
  if (d === 0) return null
  return <span className={`block text-[11px] ${d > 0 ? 'text-red-700' : 'text-emerald-700'}`}>{d > 0 ? '+' : ''}{money(d)}{base ? ` (${d > 0 ? '+' : ''}${Math.round(d / base * 100)}%)` : ''}</span>
}

/** Igual que economic_billable_qty en la base: fracción hacia arriba, mínimo y sin ejecución no se cobra. */
function billableQty(unit: string | null, qty: number, fraction: number | null, min: number | null) {
  if (!(qty > 0)) return 0
  if (unit === 'HORA') { const f = fraction || 60; return Math.max(Math.ceil(qty * 60 / f) * f / 60, min || 0) }
  if (unit === 'JORNADA') return Math.max(qty, min || 0)
  return qty
}

function ServiceRow({ s, editable, onSaved }: { s: Service; editable: boolean; onSaved: () => void }) {
  const [form, setForm] = useState({
    qty: String(s.final_executed_qty ?? s.forklift_hours ?? s.agreed_qty ?? ''), workers: String(s.final_workers ?? s.workers ?? ''),
    extras: s.final_extras_pen ? String(s.final_extras_pen) : '', reason: s.final_reason || '', final: s.final_pen != null && s.agreed_rate == null ? String(s.final_pen) : '',
  })
  const [saving, setSaving] = useState(false)
  const reference = Number(s.planned_pen ?? s.actual_pen ?? s.estimated_pen ?? 0)
  const qty = Number(form.qty || 0), workers = s.concept === 'ESTIBA' ? Number(form.workers || 1) : 1
  const billable = s.agreed_rate != null ? billableQty(s.billing_unit, qty, s.fraction_minutes, s.min_billable_qty) : null
  const base = s.agreed_rate != null ? Math.round(Number(s.agreed_rate) * (billable || 0) * workers * 100) / 100 : Number(form.final || 0)
  const preview = Math.round((base + Number(form.extras || 0)) * 100) / 100
  const needsReason = Math.abs(preview - reference) >= 0.01 || Number(form.extras || 0) > 0
  const input = 'w-full rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-[#002855]'

  const save = async () => {
    if (needsReason && form.reason.trim().length < 5) { toast.error('Justifique la diferencia con lo acordado (mínimo 5 caracteres)'); return }
    setSaving(true)
    try {
      const { data, error } = await supabase.rpc('validate_service_final', { p_line_id: s.id, p: {
        executed_qty: form.qty.trim() === '' ? null : Number(form.qty), workers: s.concept === 'ESTIBA' ? Number(form.workers || 1) : null,
        extras_pen: Number(form.extras || 0), reason: form.reason.trim() || null, final_pen: s.agreed_rate == null ? Number(form.final || 0) : null,
      } })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error)
      toast.success(`${CONCEPT_LABEL[s.concept] || s.concept}: costo final validado`)
      onSaved()
    } catch (e) { toast.error(errorMessage(e)) } finally { setSaving(false) }
  }

  return (
    <li className="rounded-lg border border-slate-200 bg-white p-3">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <b className="text-slate-900">{CONCEPT_LABEL[s.concept] || s.concept}</b><span className="text-slate-500">{s.request_number}</span>
        <span className="rounded bg-slate-100 px-1.5 text-[11px] font-semibold text-slate-600">{ORIGIN_LABEL[s.origin || 'SOLICITUD'] || s.origin}</span>
        {s.supplier && <span className="text-slate-600">{s.supplier}</span>}
        {s.expense_id && <span className="text-[11px] text-slate-500">gasto de Caja S/ {money(Number(s.actual_pen || 0))}</span>}
        <span className={`ml-auto rounded px-1.5 py-0.5 text-[11px] font-semibold ${s.final_validated_at ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800'}`}>{s.final_validated_at ? 'Validado' : 'Por validar'}</span>
      </div>
      <p className="mt-1 text-xs text-slate-600">
        Referencial S/ {money(Number(s.estimated_pen || 0))} · Acordado S/ {money(reference)}
        {s.agreed_rate != null && <> ({BILLING_LABEL[s.billing_unit || 'SERVICIO']} S/ {money(Number(s.agreed_rate))} × {s.agreed_qty ?? 1}{s.workers ? ` × ${s.workers} trab.` : ''}
          {s.min_billable_qty ? ` · mínimo ${s.min_billable_qty}` : ''}{s.fraction_minutes ? ` · fracción ${s.fraction_minutes} min` : s.billing_unit === 'HORA' ? ' · hora completa' : ''})</>}
        {s.final_pen != null && <> · <b>Final S/ {money(Number(s.final_pen))}</b>{s.final_reason ? ` · ${s.final_reason}` : ''}</>}
      </p>
      {editable && (
        <div className="mt-2 grid gap-2 sm:grid-cols-6">
          {s.agreed_rate != null ? (
            <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">{s.billing_unit === 'HORA' ? 'Horas ejecutadas' : s.billing_unit === 'JORNADA' ? 'Jornadas' : 'Servicios'}</span>
              <input inputMode="decimal" value={form.qty} onChange={e => setForm({ ...form, qty: e.target.value })} className={input} /></label>
          ) : (
            <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Costo ejecutado S/</span>
              <input inputMode="decimal" value={form.final} onChange={e => setForm({ ...form, final: e.target.value })} className={input} /></label>
          )}
          {s.concept === 'ESTIBA' && s.agreed_rate != null && <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Trabajadores</span>
            <input inputMode="numeric" value={form.workers} onChange={e => setForm({ ...form, workers: e.target.value })} className={input} /></label>}
          <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Adicionales S/</span>
            <input inputMode="decimal" value={form.extras} onChange={e => setForm({ ...form, extras: e.target.value })} placeholder="0.00" className={input} /></label>
          <label className="sm:col-span-2"><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Motivo {needsReason && '*'}</span>
            <input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder={needsReason ? 'Obligatorio: diferencia o adicionales' : 'Opcional'} className={input} /></label>
          <div className="flex items-end justify-between gap-2 sm:col-span-1">
            <p className="text-sm"><span className="text-[11px] text-slate-500">Final </span><b className="tabular-nums">S/ {money(preview)}</b>
              {billable != null && <span className="block text-[11px] text-slate-500">facturable {billable}</span>}</p>
            <button type="button" onClick={() => void save()} disabled={saving} className="rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
              {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Validar'}</button>
          </div>
        </div>
      )}
    </li>
  )
}

function ClosureDetail({ dispatchId, onChanged }: { dispatchId: string; onChanged: () => void }) {
  const [data, setData] = useState<Detail | null>(null)
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  useEffect(() => {
    let alive = true
    void supabase.rpc('economic_closure_detail', { p_dispatch_id: dispatchId }).then(({ data: out, error }) => {
      if (!alive) return
      if (error || !out?.success) { toast.error(error ? errorMessage(error) : out?.error); return }
      setData(out as Detail)
    })
    return () => { alive = false }
  }, [dispatchId, reload])
  const refresh = () => { setReload(n => n + 1); onChanged() }

  const act = async (action: string, ask?: string) => {
    let reason: string | null = null
    if (ask) { reason = window.prompt(ask); if (reason === null) return }
    setBusy(true)
    try {
      const { data: out, error } = await supabase.rpc('economic_closure_action', { p_dispatch_id: dispatchId, p_action: action, p_reason: reason })
      if (error) throw error
      if (!out?.success) throw new Error(out?.error)
      toast.success(ACTION_LABEL[action] || 'Listo')
      refresh()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }

  if (!data) return <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
  const st = data.state
  const editable = data.can_validate && ['PENDIENTE', 'OBSERVADO'].includes(st.status) && !['PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'CANCELADO'].includes(data.route_status)
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded px-2 py-1 text-xs font-semibold ${STATUS[st.status]?.cls}`}>{STATUS[st.status]?.label || st.status}</span>
        <span className="text-xs text-slate-500">Ruta {data.route_status} · {fmtDate(data.departure)} · {data.plate || '—'}</span>
      </div>
      {data.observation && <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">{st.status === 'OBSERVADO' ? 'Observación' : 'Motivo de reapertura'}: {data.observation}</p>}
      <dl className="grid gap-2 text-sm sm:grid-cols-4">
        <div className="rounded-lg border p-2"><dt className="text-[11px] text-slate-500">Referencial</dt><dd className="font-bold tabular-nums">S/ {money(st.referential_pen)}</dd></div>
        <div className="rounded-lg border p-2"><dt className="text-[11px] text-slate-500">Acordado</dt><dd className="font-bold tabular-nums">S/ {money(st.agreed_pen)}{variation(st.referential_pen, st.agreed_pen)}</dd></div>
        <div className="rounded-lg border p-2"><dt className="text-[11px] text-slate-500">Final</dt><dd className="font-bold tabular-nums">{st.final_pen == null ? <span className="text-amber-700">Pendiente</span> : <>S/ {money(st.final_pen)}{variation(st.agreed_pen, st.final_pen)}</>}</dd></div>
        <div className="rounded-lg border p-2"><dt className="text-[11px] text-slate-500">Adicionales</dt><dd className="font-bold tabular-nums">S/ {money(st.extras_pen)}</dd></div>
      </dl>
      {st.pending.length > 0 && <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900"><b>Pendientes para cerrar:</b>
        <ul className="ml-4 list-disc">{st.pending.map(p => <li key={p}>{p}</li>)}</ul></div>}

      <section className="rounded-xl border border-slate-200 bg-slate-50 p-3"><DispatchFreightStages dispatchId={dispatchId} /></section>

      <section>
        <h3 className="mb-2 font-bold text-slate-800">Servicios especiales</h3>
        {data.services.length === 0 ? <p className="text-sm text-slate-500">La ruta no tiene servicios especiales.</p>
          : <ul className="space-y-2">{data.services.map(s => <ServiceRow key={`${s.id}-${s.final_validated_at || ''}`} s={s} editable={editable} onSaved={refresh} />)}</ul>}
        {data.voided.length > 0 && <p className="mt-2 text-xs text-slate-500">No ejecutados o retirados: {data.voided.map(v => `${CONCEPT_LABEL[v.concept] || v.concept} ${v.request_number}${v.reason ? ` (${v.reason})` : ''}`).join('; ')}</p>}
      </section>

      <div className="flex flex-wrap gap-2 border-t pt-3">
        {data.can_validate && ['PENDIENTE', 'OBSERVADO'].includes(st.status) && <button type="button" disabled={busy || st.pending.length > 0} onClick={() => void act('ENVIAR')}
          className="inline-flex items-center gap-1 rounded-lg bg-[#002855] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"><Send className="h-4 w-4" />Enviar a revisión</button>}
        {data.can_approve && st.status === 'EN_REVISION' && <>
          <button type="button" disabled={busy} onClick={() => void act('APROBAR')} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"><CheckCircle2 className="h-4 w-4" />Aprobar y cerrar</button>
          <button type="button" disabled={busy} onClick={() => void act('OBSERVAR', 'Observación para Programación (qué falta o qué corregir)')} className="inline-flex items-center gap-1 rounded-lg border border-red-300 px-3 py-2 text-sm font-semibold text-red-700 disabled:opacity-50"><XCircle className="h-4 w-4" />Observar</button>
        </>}
        {data.can_approve && st.status === 'CERRADO' && <button type="button" disabled={busy} onClick={() => void act('REABRIR', 'Motivo de la reapertura del cierre económico')}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50"><Undo2 className="h-4 w-4" />Reabrir</button>}
        <p className="self-center text-[11px] text-slate-500">Al aprobar, la partida de cada OT se ajusta al costo final (solo la diferencia con lo ya consumido).</p>
      </div>

      {data.events.length > 0 && <section>
        <h3 className="mb-1 text-sm font-bold text-slate-800">Historial del cierre</h3>
        <ul className="space-y-1 text-xs">{data.events.map((e, i) => <li key={i} className="border-l-2 border-slate-200 pl-2">
          <b>{ACTION_LABEL[e.action] || e.action}</b> · {new Date(e.created_at).toLocaleString('es-PE')}{e.user ? ` · ${e.user}` : ''}
          {e.reason && <span className="text-slate-600"> · {e.reason}</span>}
          {e.detail?.budget_delta_by_contract && Object.keys(e.detail.budget_delta_by_contract).length > 0 &&
            <span className="text-slate-500"> · ajuste de partida S/ {money(Object.values(e.detail.budget_delta_by_contract).reduce((a, b) => a + Number(b), 0))}</span>}
        </li>)}</ul>
      </section>}
    </div>
  )
}

export default function CierreEconomicoPage() {
  const today = new Date()
  const [from, setFrom] = useState(limaDate(new Date(today.getFullYear(), today.getMonth(), 1)))
  const [to, setTo] = useState(limaDate(today))
  const [routes, setRoutes] = useState<Route[] | null>(null)
  const [filter, setFilter] = useState('TODOS')
  const [q, setQ] = useState('')
  const [open, setOpen] = useState<Route | null>(null)
  const [view, setView] = useState<'bandeja' | 'indicadores'>('bandeja')

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc('economic_closure_queue', { p_from: from, p_to: to })
    if (error || !data?.success) { toast.error(error ? errorMessage(error) : data?.error); setRoutes([]); return }
    setRoutes(data.routes as Route[])
  }, [from, to])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])

  const keyOf = (r: Route) => (['LIQUIDADO', 'CERRADO'].includes(r.status) ? r.state.status : 'RUTA_ABIERTA')
  const counts = useMemo(() => (routes || []).reduce<Record<string, number>>((acc, r) => { acc[keyOf(r)] = (acc[keyOf(r)] || 0) + 1; return acc }, {}), [routes])
  const rows = useMemo(() => (routes || []).filter(r => (filter === 'TODOS' || keyOf(r) === filter)
    && (!q.trim() || [r.dispatch_number, r.contracts, r.requests, r.plate].join(' ').toLowerCase().includes(q.trim().toLowerCase()))), [routes, filter, q])
  const chips: [string, string][] = [['TODOS', 'Todas'], ['PENDIENTE', 'Pendientes'], ['OBSERVADO', 'Observadas'], ['EN_REVISION', 'En revisión'], ['CERRADO', 'Cerradas'], ['RUTA_ABIERTA', 'Ruta sin cerrar']]

  return (
    <div className="min-w-0 space-y-3">
      <PageHeader showTitle title="Cierre económico" description="Costo final por servicio: referencial, acordado y final, con validación y aprobación"
        actions={<><button type="button" onClick={() => void load()} className="flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm hover:bg-slate-50"><RefreshCw className="h-4 w-4" />Actualizar</button>
          <Link href="/despacho/documentos" className="flex h-10 items-center rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-slate-700 hover:bg-slate-50">Cierre documentario</Link></>} />
      <p className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-[#002855]"><ShieldCheck className="mt-0.5 h-4 w-4 shrink-0" />
        Independiente del cierre documentario: una ruta puede tener la documentación completa y sus costos pendientes. No se cierra mientras falte validar el flete o algún servicio.</p>
      <div className="flex flex-wrap items-center gap-2">
        <div role="tablist" aria-label="Vista" className="flex gap-1 rounded-lg bg-slate-100 p-1">
          {([['bandeja', 'Bandeja de cierre'], ['indicadores', 'Indicadores']] as const).map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={view === k} onClick={() => setView(k)}
            className={`min-h-9 rounded-md px-3 text-sm font-semibold ${view === k ? 'bg-[#002855] text-white' : 'text-slate-600 hover:text-[#002855]'}`}>{label}</button>)}
        </div>
        {view === 'bandeja' && <div role="tablist" aria-label="Estado económico" className="flex flex-wrap gap-1 rounded-lg bg-slate-100 p-1">
          {chips.map(([k, label]) => <button key={k} type="button" role="tab" aria-selected={filter === k} onClick={() => setFilter(k)}
            className={`min-h-9 rounded-md px-3 text-sm font-semibold ${filter === k ? 'bg-white text-[#002855] shadow-sm' : 'text-slate-600 hover:text-[#002855]'}`}>
            {label}{k !== 'TODOS' && counts[k] ? ` (${counts[k]})` : k === 'TODOS' && routes ? ` (${routes.length})` : ''}</button>)}
        </div>}
        {view === 'bandeja' && <label className="relative min-w-0 flex-1 basis-56"><span className="sr-only">Buscar ruta, OT, solicitud o placa</span><Search aria-hidden className="absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
          <input value={q} onChange={e => setQ(e.target.value)} placeholder="Ruta, OT, solicitud o placa…" className="w-full rounded-lg border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm outline-none focus:ring-2 focus:ring-[#002855]" /></label>}
        <label className="flex items-center gap-2 text-xs text-slate-500">Desde<input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
        <label className="flex items-center gap-2 text-xs text-slate-500">Hasta<input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1.5 text-sm" /></label>
      </div>
      {view === 'indicadores' ? <ServiceCostIndicators from={from} to={to} /> : <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        {routes === null ? <p className="flex justify-center p-8"><Loader2 className="h-5 w-5 animate-spin text-slate-400" /></p>
          : rows.length === 0 ? <p className="p-8 text-center text-sm text-slate-500">No hay rutas para los filtros seleccionados.</p>
          : <table className="w-full min-w-[60rem] text-sm">
            <thead className="bg-slate-50 text-left text-xs uppercase text-slate-500"><tr>
              <th className="px-3 py-2">Ruta</th><th className="px-3 py-2">OT · solicitudes</th><th className="px-3 py-2">Estado económico</th>
              <th className="px-3 py-2 text-right">Referencial</th><th className="px-3 py-2 text-right">Acordado</th><th className="px-3 py-2 text-right">Final</th><th className="px-3 py-2">Pendientes</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(r => {
                const open = !['LIQUIDADO', 'CERRADO'].includes(r.status)
                return <tr key={r.dispatch_id} className="cursor-pointer hover:bg-slate-50" onClick={() => setOpen(r)}>
                  <td className="px-3 py-2"><b className="text-[#002855] underline">{r.dispatch_number}</b><span className="block text-xs text-slate-500">{fmtDate(r.departure)} · {r.plate || '—'}</span></td>
                  <td className="px-3 py-2 text-xs">{r.contracts || 'Sin OT'}<span className="block text-slate-500">{r.requests}</span></td>
                  <td className="px-3 py-2">{open ? <span className="rounded bg-slate-100 px-2 py-0.5 text-[11px] font-semibold text-slate-600">Ruta {r.status} · sin cerrar</span>
                    : <span className={`rounded px-2 py-0.5 text-[11px] font-semibold ${STATUS[r.state.status]?.cls}`}>{STATUS[r.state.status]?.label}</span>}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(r.state.referential_pen)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(r.state.agreed_pen)}{variation(r.state.referential_pen, r.state.agreed_pen)}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.state.final_pen == null ? '—' : <>{money(r.state.final_pen)}{variation(r.state.agreed_pen, r.state.final_pen)}</>}</td>
                  <td className="px-3 py-2 text-xs text-slate-600">{r.state.pending.length ? `${r.state.pending.length} por resolver` : '—'}</td>
                </tr>
              })}
            </tbody>
          </table>}
      </div>}
      <Modal isOpen={!!open} onClose={() => setOpen(null)} title={open ? `Cierre económico · ${open.dispatch_number}` : ''} maxWidth="max-w-4xl">
        {open && <ClosureDetail dispatchId={open.dispatch_id} onChanged={() => void load()} />}
      </Modal>
    </div>
  )
}
