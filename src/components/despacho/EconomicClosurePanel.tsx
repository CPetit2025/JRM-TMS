'use client'
import { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, FileText, Loader2, Plus, Save, Send, Undo2, X, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { errorMessage, money } from '@/lib/caja'
import { dispatchStatusLabel } from '@/lib/dispatch-status'
import {
  DEFAULT_SETTINGS, DOC_STATUS, ECON_STATUS, ITEM_LABEL, ITEM_STATUS, ORIGIN_TEXT, documentaryHref, isDeviation, routeSummary,
  type EconItem, type EconRoute, type EconSettings, type EconState,
} from '@/lib/economic-closure'
import { DispatchFreightStages } from '@/components/despacho/DispatchFreightStages'
import { BILLING_LABEL, CONCEPT_LABEL } from '@/components/despacho/InheritedSpecialServices'

// Detalle del cierre económico de una ruta en panel lateral: cabecera, estado documentario y económico, pestañas
// (resumen, servicios por ítem incluido el flete, historial unificado y archivos), observaciones internas que no cambian
// el estado, alerta de desviación según el umbral configurable y acciones (enviar, observar, aprobar, reabrir).

type Service = {
  id: string; request_number: string; concept: string; description: string | null; status: string; origin: string | null; supplier: string | null
  billing_unit: string | null; agreed_rate: number | null; agreed_qty: number | null; workers: number | null; min_billable_qty: number | null; fraction_minutes: number | null
  estimated_pen: number; planned_pen: number | null; actual_pen: number | null; expense_id: string | null; forklift_hours: number | null
  final_executed_qty: number | null; final_workers: number | null; final_billable_qty: number | null; final_extras_pen: number | null
  final_pen: number | null; final_reason: string | null; final_validated_at: string | null; final_validated_by: string | null
}
type HistoryEntry = {
  source: 'COSTO' | 'CIERRE'; created_at: string; user: string | null; reason: string | null
  stage?: string; concept?: string; old_amount?: number | null; new_amount?: number | null; request_number?: string | null
  action?: string; to_status?: string; detail?: { budget_delta_by_contract?: Record<string, number>; concept?: string; final_pen?: number; item?: { label?: string } }
}
type Detail = {
  success: true; dispatch_number: string; route_status: string; departure: string | null; plate: string | null; state: EconState; observation: string | null
  can_validate: boolean; can_approve: boolean; settings: EconSettings; contracts: string | null; doc_status: string
  requests: { id: string; request_number: string; contract_code: string | null; doc_status: string | null }[]
  last: { at: string | null; by: string | null }; items: EconItem[]; services: Service[]
  voided: { concept: string; request_number: string; reason: string | null }[]
  notes: { note: string; created_at: string; user: string | null }[]; history: HistoryEntry[]
}
type Tab = 'resumen' | 'servicios' | 'historial' | 'archivos'

const supabase = createClient()
const OPEN_ROUTE = ['PROGRAMADO', 'EN_CURSO', 'EN RUTA', 'ESPERANDO_AUTORIZACION', 'CANCELADO']
const ACTION_LABEL: Record<string, string> = { ENVIAR: 'Enviado a revisión', APROBAR: 'Aprobado', OBSERVAR: 'Observado', REABRIR: 'Reabierto', NOTA: 'Observación interna', AGREGAR: 'Servicio agregado en el cierre' }
const STAGE_LABEL: Record<string, string> = { REFERENCIAL: 'Referencial', ACORDADO: 'Acordado', AJUSTE: 'Ajuste', FINAL: 'Final', ESTADO: 'Estado' }
const fmtDate = (v: string | null) => (v ? new Date(v).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : '—')
const fmtDateTime = (v: string | null) => (v ? new Date(v).toLocaleString('es-PE', { timeZone: 'America/Lima' }) : '—')
const input = 'w-full rounded-lg border border-slate-300 bg-white px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-[#002855]'

export function Variation({ base, value, settings }: { base: number; value: number | null; settings?: EconSettings }) {
  if (value == null) return <span className="text-slate-400">—</span>
  const d = Math.round((Number(value) - Number(base)) * 100) / 100
  if (d === 0) return <span className="text-slate-500">0.00</span>
  const alert = settings ? isDeviation(base, value, settings) : false
  return <span className={`tabular-nums ${alert ? 'font-bold text-red-700' : d > 0 ? 'text-amber-700' : 'text-emerald-700'}`}>
    {d > 0 ? '+' : ''}{money(d)}{Number(base) ? ` (${d > 0 ? '+' : ''}${Math.round(d / Number(base) * 1000) / 10}%)` : ''}</span>
}

/** Igual que economic_billable_qty en la base: fracción hacia arriba, mínimo y sin ejecución no se cobra. */
function billableQty(unit: string | null, qty: number, fraction: number | null, min: number | null) {
  if (!(qty > 0)) return 0
  if (unit === 'HORA') { const f = fraction || 60; return Math.max(Math.ceil(qty * 60 / f) * f / 60, min || 0) }
  if (unit === 'JORNADA') return Math.max(qty, min || 0)
  return qty
}

function ServiceEditor({ s, onSaved }: { s: Service; onSaved: () => void }) {
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
    <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-3">
      <p className="text-xs text-slate-600">
        Acordado S/ {money(reference)}
        {s.agreed_rate != null && <> ({BILLING_LABEL[s.billing_unit || 'SERVICIO'] || s.billing_unit} S/ {money(Number(s.agreed_rate))} × {s.agreed_qty ?? 1}{s.workers ? ` × ${s.workers} trab.` : ''}
          {s.min_billable_qty ? ` · mínimo ${s.min_billable_qty}` : ''}{s.fraction_minutes ? ` · fracción ${s.fraction_minutes} min` : s.billing_unit === 'HORA' ? ' · hora completa' : ''})</>}
        {s.expense_id && <> · gasto de Caja S/ {money(Number(s.actual_pen || 0))}</>}
      </p>
      <div className="grid gap-2 sm:grid-cols-6">
        {s.agreed_rate != null ? (
          <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">{s.billing_unit === 'HORA' ? 'Horas ejecutadas' : s.billing_unit === 'JORNADA' ? 'Jornadas' : 'Cantidad'}</span>
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
        <div className="flex items-end justify-between gap-2">
          <p className="text-sm"><span className="text-[11px] text-slate-500">Final </span><b className="tabular-nums">S/ {money(preview)}</b>
            {billable != null && <span className="block text-[11px] text-slate-500">facturable {billable}</span>}</p>
          <button type="button" onClick={() => void save()} disabled={saving} className="rounded-lg bg-blue-600 px-2.5 py-1.5 text-xs font-semibold text-white disabled:opacity-50">
            {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : 'Validar'}</button>
        </div>
      </div>
    </div>
  )
}

function AddService({ dispatchId, requests, onSaved }: { dispatchId: string; requests: Detail['requests']; onSaved: () => void }) {
  const [form, setForm] = useState({ request: requests[0]?.id || '', concept: 'OTROS', description: '', amount: '', reason: '' })
  const [saving, setSaving] = useState(false)
  const save = async () => {
    if (!(Number(form.amount) > 0)) { toast.error('Indique el costo final del servicio'); return }
    if (form.reason.trim().length < 5) { toast.error('Indique por qué se agrega el servicio (mínimo 5 caracteres)'); return }
    setSaving(true)
    try {
      const { data, error } = await supabase.rpc('economic_add_service', { p_dispatch_id: dispatchId, p: {
        transport_request_id: form.request, concept: form.concept, description: form.description.trim() || null, final_pen: Number(form.amount), reason: form.reason.trim(),
      } })
      if (error) throw error
      if (!data?.success) throw new Error(data?.error)
      toast.success('Servicio agregado: se imputa a la partida al aprobar')
      setForm(f => ({ ...f, description: '', amount: '', reason: '' }))
      onSaved()
    } catch (e) { toast.error(errorMessage(e)) } finally { setSaving(false) }
  }
  return (
    <details className="rounded-lg border border-dashed border-slate-300 p-3">
      <summary className="flex cursor-pointer items-center gap-1 text-sm font-semibold text-[#002855]"><Plus className="h-4 w-4" />Agregar servicio ejecutado no programado</summary>
      <div className="mt-2 grid gap-2 sm:grid-cols-6">
        <label className="sm:col-span-2"><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Solicitud</span>
          <select value={form.request} onChange={e => setForm({ ...form, request: e.target.value })} className={input}>
            {requests.map(r => <option key={r.id} value={r.id}>{r.request_number}{r.contract_code ? ` · ${r.contract_code}` : ''}</option>)}</select></label>
        <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Servicio</span>
          <select value={form.concept} onChange={e => setForm({ ...form, concept: e.target.value })} className={input}>
            {['MONTACARGAS', 'GRUA', 'ESTIBA', 'OTROS'].map(c => <option key={c} value={c}>{ITEM_LABEL[c]}</option>)}</select></label>
        <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Costo final S/</span>
          <input inputMode="decimal" value={form.amount} onChange={e => setForm({ ...form, amount: e.target.value })} className={input} /></label>
        <label className="sm:col-span-2"><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Descripción</span>
          <input value={form.description} onChange={e => setForm({ ...form, description: e.target.value })} placeholder="Opcional" className={input} /></label>
        <label className="sm:col-span-5"><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Motivo *</span>
          <input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="Por qué se ejecutó sin programarse" className={input} /></label>
        <div className="flex items-end"><button type="button" disabled={saving} onClick={() => void save()} className="w-full rounded-lg bg-[#002855] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50">
          {saving ? <Loader2 className="mx-auto h-4 w-4 animate-spin" /> : 'Agregar'}</button></div>
      </div>
      <p className="mt-1 text-[11px] text-slate-500">Acordado S/ 0: todo el monto se muestra como desviación. No reserva partida; se imputa al aprobar.</p>
    </details>
  )
}

function Badge({ map, value }: { map: Record<string, { label: string; cls: string }>; value: string | null | undefined }) {
  const s = map[value || ''] || { label: value || '—', cls: 'bg-slate-100 text-slate-600' }
  return <span className={`inline-block whitespace-nowrap rounded px-2 py-0.5 text-[11px] font-semibold ${s.cls}`}>{s.label}</span>
}

export function EconomicClosurePanel({ dispatchId, initialTab = 'resumen', onClose, onChanged }: {
  dispatchId: string; initialTab?: Tab; onClose: () => void; onChanged: () => void
}) {
  const [data, setData] = useState<Detail | null>(null)
  const [reload, setReload] = useState(0)
  const [busy, setBusy] = useState(false)
  const [tab, setTab] = useState<Tab>(initialTab)
  const [editing, setEditing] = useState<string | null>(null)
  const [note, setNote] = useState('')
  const [mounted, setMounted] = useState(false)

  useEffect(() => { const t = window.setTimeout(() => setMounted(true), 0); return () => window.clearTimeout(t) }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
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
  const itemAct = async (item: EconItem, action: string, ask?: string) => {
    let reason: string | null = null
    if (ask) { reason = window.prompt(ask); if (reason === null) return }
    setBusy(true)
    try {
      const { data: out, error } = await supabase.rpc('economic_item_action', { p_dispatch_id: dispatchId, p_item: item.key, p_action: action, p_reason: reason })
      if (error) throw error
      if (!out?.success) throw new Error(out?.error)
      toast.success(`${ITEM_LABEL[item.concept] || item.concept}: ${(ACTION_LABEL[action] || 'listo').toLowerCase()}`)
      refresh()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }
  const saveNote = async () => {
    if (note.trim().length < 3) { toast.error('Escriba la observación (mínimo 3 caracteres)'); return }
    setBusy(true)
    try {
      const { data: out, error } = await supabase.rpc('economic_closure_note', { p_dispatch_id: dispatchId, p_note: note.trim() })
      if (error) throw error
      if (!out?.success) throw new Error(out?.error)
      toast.success('Observación guardada'); setNote(''); refresh()
    } catch (e) { toast.error(errorMessage(e)) } finally { setBusy(false) }
  }

  const summary = useMemo(() => data ? routeSummary({ items: data.items } as EconRoute) : null, [data])
  const settings = data?.settings || DEFAULT_SETTINGS
  const st = data?.state
  const status = data ? (['LIQUIDADO', 'CERRADO'].includes(data.route_status) ? st!.status : 'RUTA_ABIERTA') : ''
  const editable = !!data && data.can_validate && ['PENDIENTE', 'OBSERVADO', 'CIERRE_PARCIAL'].includes(st!.status) && !OPEN_ROUTE.includes(data.route_status)
  const closedRoute = !!data && ['LIQUIDADO', 'CERRADO'].includes(data.route_status)
  const deviations =(data?.items || []).filter(i => isDeviation(i.agreed_pen, i.final_pen, settings))
  const services = new Map((data?.services || []).map(s => [s.id, s]))

  if (!mounted) return null
  return createPortal(
    <div className="fixed inset-0 z-[9998]" role="dialog" aria-modal="true" aria-label={data ? `Cierre económico ${data.dispatch_number}` : 'Cierre económico'}>
      <div className="absolute inset-0 bg-slate-900/40" onClick={onClose} />
      <aside className="absolute inset-y-0 right-0 flex w-full max-w-4xl flex-col bg-white shadow-2xl">
        <header className="border-b border-slate-200 px-4 py-3">
          <div className="flex items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="text-xs text-slate-500">Cierre económico</p>
              <h2 className="flex flex-wrap items-center gap-2 text-lg font-bold text-[#002855]">Ruta {data?.dispatch_number || '…'} {data && <Badge map={ECON_STATUS} value={status} />}</h2>
              {data && <p className="mt-0.5 text-xs text-slate-600">
                {fmtDate(data.departure)} · {data.plate || 'Sin placa'} · {dispatchStatusLabel(data.route_status)} · OT {data.contracts || 'sin OT'} · Solicitudes {data.requests.map(r => r.request_number).join(', ') || '—'}
                {summary?.suppliers.length ? ` · Proveedores: ${summary.suppliers.join(', ')}` : ''}</p>}
            </div>
            <button type="button" onClick={onClose} aria-label="Cerrar panel" className="rounded-lg p-2 text-slate-500 hover:bg-slate-100"><X className="h-5 w-5" /></button>
          </div>
        </header>

        {!data || !summary || !st ? <div className="flex flex-1 items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div> : <>
          <div className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
            <div className="grid gap-2 sm:grid-cols-2">
              <section className="rounded-xl border border-slate-200 p-3">
                <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-bold text-slate-800">Estado documentario</h3><Badge map={DOC_STATUS} value={data.doc_status} /></div>
                <ul className="mt-1 space-y-0.5 text-xs text-slate-600">{data.requests.map(r => <li key={r.id} className="flex justify-between gap-2"><span>{r.request_number}{r.contract_code ? ` · ${r.contract_code}` : ''}</span><Badge map={DOC_STATUS} value={r.doc_status || 'PENDIENTE'} /></li>)}</ul>
                <Link href={documentaryHref(dispatchId)} className="mt-2 inline-flex items-center gap-1 text-xs font-semibold text-[#002855] underline"><FileText className="h-3.5 w-3.5" />Ir a cierre documentario</Link>
              </section>
              <section className="rounded-xl border border-slate-200 p-3">
                <div className="flex items-center justify-between gap-2"><h3 className="text-sm font-bold text-slate-800">Estado económico</h3><Badge map={ECON_STATUS} value={status} /></div>
                <p className="mt-1 text-sm"><b>{summary.approved || (st.status === 'CERRADO' ? summary.total : 0)} de {summary.total}</b> servicios cerrados · {summary.validated} con costo final</p>
                <div className="mt-1 h-2 rounded bg-slate-100"><div className="h-2 rounded bg-emerald-500" style={{ width: `${summary.total ? Math.round((summary.approved || (st.status === 'CERRADO' ? summary.total : 0)) / summary.total * 100) : 0}%` }} /></div>
                <p className="mt-1 text-[11px] text-slate-500">Última actualización {fmtDateTime(data.last.at)}{data.last.by ? ` · ${data.last.by}` : ''}</p>
              </section>
            </div>

            {deviations.length > 0 && <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-800"><AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <p><b>Desviación sobre el umbral</b> (más de {settings.deviation_pct}% o S/ {money(Number(settings.deviation_pen))}): {deviations.map(i => `${ITEM_LABEL[i.concept] || i.concept} ${i.request_number || ''} (${money(Number(i.final_pen) - Number(i.agreed_pen))})`).join('; ')}</p></div>}
            {data.observation && <p className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900">{st.status === 'OBSERVADO' ? 'Observación' : 'Último motivo'}: {data.observation}</p>}

            <div role="tablist" aria-label="Detalle" className="flex gap-1 border-b border-slate-200">
              {([['resumen', 'Resumen'], ['servicios', `Servicios (${summary.total})`], ['historial', 'Historial'], ['archivos', 'Archivos']] as const).map(([k, label]) =>
                <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}
                  className={`-mb-px border-b-2 px-3 py-2 text-sm font-semibold ${tab === k ? 'border-[#002855] text-[#002855]' : 'border-transparent text-slate-500 hover:text-[#002855]'}`}>{label}</button>)}
            </div>

            {tab === 'resumen' && <div className="space-y-3">
              <dl className="grid gap-2 text-sm sm:grid-cols-4">
                <div className="rounded-lg border p-2"><dt className="text-[11px] text-slate-500">Referencial</dt><dd className="font-bold tabular-nums">S/ {money(st.referential_pen)}</dd></div>
                <div className="rounded-lg border p-2"><dt className="text-[11px] text-slate-500">Acordado</dt><dd className="font-bold tabular-nums">S/ {money(st.agreed_pen)}</dd></div>
                <div className="rounded-lg border p-2"><dt className="text-[11px] text-slate-500">Final{summary.validated < summary.total ? ` (${summary.validated}/${summary.total})` : ''}</dt>
                  <dd className="font-bold tabular-nums">{summary.final == null ? <span className="text-amber-700">Pendiente</span> : `S/ ${money(summary.final)}`}</dd></div>
                <div className="rounded-lg border p-2"><dt className="text-[11px] text-slate-500">Variación acordado → final</dt><dd className="text-sm font-bold"><Variation base={summary.agreedWithFinal} value={summary.final} settings={settings} /></dd></div>
              </dl>
              {st.pending.length > 0 && <div className="rounded-lg border border-amber-200 bg-amber-50 p-2 text-sm text-amber-900"><b>Pendientes para cerrar:</b>
                <ul className="ml-4 list-disc">{st.pending.map(p => <li key={p}>{p}</li>)}</ul></div>}
              {data.voided.length > 0 && <p className="text-xs text-slate-500">No ejecutados o retirados: {data.voided.map(v => `${CONCEPT_LABEL[v.concept] || v.concept} ${v.request_number}${v.reason ? ` (${v.reason})` : ''}`).join('; ')}</p>}
            </div>}

            {tab === 'servicios' && <div className="space-y-3">
              <div className="overflow-x-auto rounded-lg border border-slate-200">
                <table className="w-full min-w-[52rem] text-xs">
                  <thead className="bg-slate-50 text-left text-[11px] uppercase text-slate-500"><tr>
                    <th className="px-2 py-1.5">Servicio</th><th className="px-2">Origen</th><th className="px-2 text-right">Ref.</th><th className="px-2 text-right">Acordado</th><th className="px-2 text-right">Final</th>
                    <th className="px-2">Cantidad / base</th><th className="px-2 text-right">Variación</th><th className="px-2">Estado</th><th className="px-2">Validó</th><th className="px-2" />
                  </tr></thead>
                  <tbody className="divide-y divide-slate-100">
                    {data.items.map(i => {
                      const s = i.id ? services.get(i.id) : undefined
                      const canEdit = editable && (i.kind === 'FLETE' || !!s) && !['EN_REVISION', 'APROBADO'].includes(i.status)
                      return <tr key={i.key} className={isDeviation(i.agreed_pen, i.final_pen, settings) ? 'bg-red-50/60' : ''}>
                        <td className="px-2 py-1.5"><b className="text-slate-800">{ITEM_LABEL[i.concept] || i.concept}</b><span className="block text-slate-500">{i.request_number}{i.contract_code ? ` · ${i.contract_code}` : ''}{i.supplier ? ` · ${i.supplier}` : ''}</span>{i.caja_pen != null && <span className="block text-[10px] text-slate-500">Caja S/ {money(Number(i.caja_pen))}</span>}</td>
                        <td className="px-2">{ORIGIN_TEXT[i.origin || ''] || i.origin || '—'}</td>
                        <td className="px-2 text-right tabular-nums">{money(Number(i.referential_pen))}</td>
                        <td className="px-2 text-right tabular-nums">{money(Number(i.agreed_pen))}</td>
                        <td className="px-2 text-right tabular-nums">{i.final_pen == null ? '—' : money(Number(i.final_pen))}</td>
                        <td className="px-2 text-slate-600">{i.kind === 'FLETE' ? (i.extras_pen ? `adic. ${money(Number(i.extras_pen))}` : 'Flete') : i.executed_qty != null
                          ? `${i.executed_qty}${i.billable_qty != null && Number(i.billable_qty) !== Number(i.executed_qty) ? ` → ${i.billable_qty}` : ''} ${(BILLING_LABEL[i.billing_unit || ''] || i.billing_unit || '').toLowerCase()}` : '—'}</td>
                        <td className="px-2 text-right"><Variation base={i.agreed_pen} value={i.final_pen} settings={settings} /></td>
                        <td className="px-2"><Badge map={ITEM_STATUS} value={i.status} />
                          {i.status === 'APROBADO' && i.approved_by && <span className="block text-[10px] text-slate-500">{i.approved_by} · {fmtDate(i.approved_at ?? null)}</span>}
                          {i.observation && ['OBSERVADO', 'VALIDADO'].includes(i.status) && <span className="block max-w-40 text-[10px] text-red-700">{i.observation}</span>}</td>
                        <td className="px-2 text-slate-600">{i.validated_by || '—'}{i.validated_at && <span className="block text-[10px] text-slate-400">{fmtDate(i.validated_at)}</span>}</td>
                        <td className="px-2 text-right"><div className="flex flex-wrap justify-end gap-1">
                          {canEdit && <button type="button" onClick={() => setEditing(editing === i.key ? null : i.key)} className="rounded border border-slate-300 px-2 py-0.5 font-semibold text-[#002855] hover:bg-slate-50">
                            {editing === i.key ? 'Cerrar' : i.final_pen == null ? 'Validar' : 'Corregir'}</button>}
                          {data.can_validate && closedRoute && ['VALIDADO', 'OBSERVADO'].includes(i.status) && <button type="button" disabled={busy} onClick={() => void itemAct(i, 'ENVIAR')}
                            className="rounded border border-[#002855] px-2 py-0.5 font-semibold text-[#002855] disabled:opacity-50">Enviar</button>}
                          {data.can_approve && closedRoute && ['VALIDADO', 'OBSERVADO', 'EN_REVISION'].includes(i.status) && <button type="button" disabled={busy} onClick={() => void itemAct(i, 'APROBAR')}
                            className="rounded bg-emerald-600 px-2 py-0.5 font-semibold text-white disabled:opacity-50">Aprobar</button>}
                          {data.can_approve && ['VALIDADO', 'EN_REVISION'].includes(i.status) && <button type="button" disabled={busy} onClick={() => void itemAct(i, 'OBSERVAR', 'Observación del ítem (qué falta o qué corregir)')}
                            className="rounded border border-red-300 px-2 py-0.5 font-semibold text-red-700 disabled:opacity-50">Observar</button>}
                          {data.can_approve && i.status === 'APROBADO' && <button type="button" disabled={busy} onClick={() => void itemAct(i, 'REABRIR', 'Motivo para reabrir este ítem')}
                            className="rounded border border-slate-300 px-2 py-0.5 font-semibold text-slate-700 disabled:opacity-50">Reabrir</button>}
                        </div></td>
                      </tr>
                    })}
                  </tbody>
                </table>
              </div>
              {editing && (() => {
                const item = data.items.find(i => i.key === editing)
                if (!item) return null
                if (item.kind === 'FLETE') return <section className="rounded-xl border border-slate-200 bg-slate-50 p-3"><DispatchFreightStages key={reload} dispatchId={dispatchId} /></section>
                const s = item.id ? services.get(item.id) : undefined
                return s ? <ServiceEditor key={`${s.id}-${s.final_validated_at || ''}`} s={s} onSaved={refresh} /> : null
              })()}
              {editable && data.requests.length > 0 && <AddService dispatchId={dispatchId} requests={data.requests} onSaved={refresh} />}
            </div>}

            {tab === 'historial' && (data.history.length === 0 ? <p className="text-sm text-slate-500">Sin movimientos.</p> :
              <ol className="space-y-1.5 text-xs">{data.history.map((h, n) => <li key={n} className={`border-l-2 pl-2 ${h.source === 'CIERRE' ? 'border-[#002855]' : 'border-slate-200'}`}>
                <span className="text-slate-500">{fmtDateTime(h.created_at)}{h.user ? ` · ${h.user}` : ''}</span><br />
                {h.source === 'CIERRE'
                  ? <><b>{ACTION_LABEL[h.action || ''] || h.action}</b>{h.detail?.item?.label ? ` · ${h.detail.item.label}` : ''}{h.action !== 'NOTA' && h.to_status ? ` → ${ECON_STATUS[h.to_status]?.label || h.to_status}` : ''}
                    {h.detail?.concept && h.detail.final_pen != null && ` · ${ITEM_LABEL[h.detail.concept] || h.detail.concept} S/ ${money(Number(h.detail.final_pen))}`}
                    {h.detail?.budget_delta_by_contract && Object.keys(h.detail.budget_delta_by_contract).length > 0 &&
                      ` · ajuste de partida S/ ${money(Object.values(h.detail.budget_delta_by_contract).reduce((a, b) => a + Number(b), 0))}`}</>
                  : <><b>{ITEM_LABEL[h.concept || ''] || h.concept} · {STAGE_LABEL[h.stage || ''] || h.stage}</b>{h.request_number ? ` · ${h.request_number}` : ''}
                    {h.new_amount != null && ` · ${h.old_amount != null ? `S/ ${money(Number(h.old_amount))} → ` : ''}S/ ${money(Number(h.new_amount))}`}</>}
                {h.reason && <span className="text-slate-600"> · {h.reason}</span>}
              </li>)}</ol>)}

            {tab === 'archivos' && <div className="space-y-2 text-sm">
              <p className="text-slate-600">La evidencia (guías, conformidades, facturas y sustentos) se gestiona en el cierre documentario de cada servicio.</p>
              <ul className="space-y-1">{data.requests.map(r => <li key={r.id} className="flex items-center justify-between gap-2 rounded-lg border border-slate-200 px-3 py-2">
                <span>{r.request_number}{r.contract_code ? ` · ${r.contract_code}` : ''}</span><Badge map={DOC_STATUS} value={r.doc_status || 'PENDIENTE'} /></li>)}</ul>
              <Link href={documentaryHref(dispatchId)} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 font-semibold text-[#002855] hover:bg-slate-50"><FileText className="h-4 w-4" />Ver evidencia documentaria</Link>
            </div>}

            <section className="rounded-xl border border-slate-200 p-3">
              <h3 className="text-sm font-bold text-slate-800">Observaciones internas</h3>
              <p className="text-[11px] text-slate-500">Notas para el equipo: no cambian el estado del cierre.</p>
              {data.can_validate && <textarea value={note} onChange={e => setNote(e.target.value)} rows={2} maxLength={1000} placeholder="Escriba una observación…" className={`mt-2 ${input}`} />}
              {data.notes.length > 0 && <ul className="mt-2 space-y-1 text-xs">{data.notes.map((n, k) => <li key={k} className="rounded bg-slate-50 px-2 py-1">
                <span className="text-slate-500">{fmtDateTime(n.created_at)}{n.user ? ` · ${n.user}` : ''}</span><br />{n.note}</li>)}</ul>}
            </section>
          </div>

          <footer className="flex flex-wrap items-center gap-2 border-t border-slate-200 px-4 py-3">
            {data.can_validate && ['PENDIENTE', 'OBSERVADO', 'CIERRE_PARCIAL'].includes(st.status) && <button type="button" disabled={busy || st.pending.length > 0} onClick={() => void act('ENVIAR')}
              title={st.pending.length ? 'Faltan costos por validar' : undefined}
              className="inline-flex items-center gap-1 rounded-lg border border-[#002855] px-3 py-2 text-sm font-semibold text-[#002855] disabled:opacity-50"><Send className="h-4 w-4" />Enviar a revisión</button>}
            {data.can_approve && ['EN_REVISION', 'CIERRE_PARCIAL'].includes(st.status) && <>
              {data.items.some(i => i.status === 'EN_REVISION') && <button type="button" disabled={busy} onClick={() => void act('OBSERVAR', 'Observación para Programación (qué falta o qué corregir)')} className="inline-flex items-center gap-1 rounded-lg border border-red-300 px-3 py-2 text-sm font-semibold text-red-700 disabled:opacity-50"><XCircle className="h-4 w-4" />Observar</button>}
              <button type="button" disabled={busy || st.pending.length > 0} title={st.pending.length ? 'No se cierra con ítems pendientes: apruebe por ítem' : undefined} onClick={() => void act('APROBAR')} className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"><CheckCircle2 className="h-4 w-4" />Aprobar cierre</button>
            </>}
            {data.can_approve && ['CERRADO', 'CIERRE_PARCIAL'].includes(st.status) && <button type="button" disabled={busy} onClick={() => void act('REABRIR', 'Motivo de la reapertura del cierre económico')}
              className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 disabled:opacity-50"><Undo2 className="h-4 w-4" />Reabrir</button>}
            {data.can_validate && <button type="button" disabled={busy || !note.trim()} onClick={() => void saveNote()} className="inline-flex items-center gap-1 rounded-lg bg-[#002855] px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"><Save className="h-4 w-4" />Guardar</button>}
            <Link href={documentaryHref(dispatchId)} className="ml-auto inline-flex items-center gap-1 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"><FileText className="h-4 w-4" />Ir a cierre documentario</Link>
          </footer>
        </>}
      </aside>
    </div>,
    document.body,
  )
}
