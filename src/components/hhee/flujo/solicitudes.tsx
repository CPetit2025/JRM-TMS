'use client'

import { useCallback, useEffect, useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { CalendarX2, CheckCircle2, Copy, FileDown, Files, Mail, Pencil, Plus, Search, Send, XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { Card, Field, Modal, btn2Cls, btnCls, inputCls, useFlow } from './context'
import { RequestForm } from './request-form'
import { consolidate, consolidatedEmailDraft, downloadConsolidatedPdf, downloadPdf, emailDraft, folio } from './informe'
import { CLOSED_BY, STATUS, call, isPendingText, plateLabel, fmtDate, fmtDateTime, fmtHours, fmtMoney, fmtTime, statusOf, type Consolidated, type Detail, type RequestRow } from '@/lib/hhee/flujo'
import { trackingEmailUrl, type EmailClient } from '@/lib/tracking-email'

// Solicitudes y aprobación: el supervisor registra y presenta; el Jefe de Distribución o el Administrador aprueba,
// observa o rechaza. Cada aprobación guarda una versión del informe (PDF y correo).
const FILTERS = [['pendientes', 'Por aprobar'], ['mias', 'Mis solicitudes'], ['borradores', 'Borradores'], ['observadas', 'Observadas'], ['aprobadas', 'Aprobadas'], ['rechazadas', 'Rechazadas'], ['', 'Todas']] as const

export function Solicitudes() {
  const { ctx } = useFlow()
  const sp = useSearchParams()
  const router = useRouter()
  const [status, setStatus] = useState<string>(ctx.caps.approve ? 'pendientes' : 'mias')
  const [q, setQ] = useState('')
  const [rows, setRows] = useState<RequestRow[] | null>(null)
  const [pending, setPending] = useState(0)
  const [error, setError] = useState('')
  const [nonce, setNonce] = useState(0)
  const [form, setForm] = useState<Detail | 'new' | null>(null)
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  // Selección para el informe consolidado (solo solicitudes aprobadas; se mantiene al cambiar de filtro)
  const [selected, setSelected] = useState<Map<string, RequestRow>>(new Map())
  const [consolidated, setConsolidated] = useState<string[] | null>(null)
  const selectable = (r: RequestRow) => r.approval === 'APROBADA' && r.state !== 'CANCELADA' && r.revisions > 0
  const toggle = (r: RequestRow) => setSelected(m => { const n = new Map(m); if (n.has(r.id)) n.delete(r.id); else n.set(r.id, r); return n })
  const open = sp.get('id')
  const setOpen = (id: string | null) => router.replace(id ? `/hhee/solicitudes?id=${id}` : '/hhee/solicitudes')
  useEffect(() => {
    let alive = true
    const t = setTimeout(() => {
      call<{ rows: RequestRow[]; pending: number }>('hhee_flow_list', { p: { status, q, from, to } })
        .then(r => { if (alive) { setRows(r.rows); setPending(r.pending); setError('') } })
        .catch(e => { if (alive) setError(e instanceof Error ? e.message : 'No se pudo cargar') })
    }, 200)
    return () => { alive = false; clearTimeout(t) }
  }, [status, q, from, to, nonce])
  const visibleSelectable = (rows ?? []).filter(selectable)
  const allVisible = visibleSelectable.length > 0 && visibleSelectable.every(r => selected.has(r.id))
  const selectedMinutes = [...selected.values()].reduce((t, r) => t + r.minutes, 0)
  const refresh = () => setNonce(n => n + 1)
  return (
    <div className="grid gap-4">
      <Card title="Solicitudes de horas extras" subtitle={ctx.caps.approve ? `${pending} pendiente(s) de su aprobación` : 'Registre la solicitud y preséntela para aprobación'}
        actions={ctx.caps.request && <button type="button" className={btnCls} onClick={() => setForm('new')}><Plus className="h-4 w-4" /> Nueva solicitud</button>}>
        <div className="mb-3 flex flex-wrap items-end gap-2">
          <div role="group" aria-label="Estado" className="flex flex-wrap gap-1">
            {FILTERS.filter(([v]) => v !== 'pendientes' || ctx.caps.approve).map(([v, l]) => <button key={v} type="button" aria-pressed={status === v} onClick={() => setStatus(v)}
              className={`min-h-9 rounded-lg px-3 text-xs font-semibold ${status === v ? 'bg-[#002855] text-white' : 'border border-slate-300 bg-white text-slate-600'}`}>{l}{v === 'pendientes' && pending ? ` (${pending})` : ''}</button>)}
          </div>
          <Field label="Desde"><input type="date" className={`${inputCls} w-40`} value={from} onChange={e => setFrom(e.target.value)} /></Field>
          <Field label="Hasta"><input type="date" className={`${inputCls} w-40`} value={to} onChange={e => setTo(e.target.value)} /></Field>
          <Field label="Buscar" className="ml-auto min-w-56"><span className="flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-2"><Search className="h-4 w-4 text-slate-400" />
            <input value={q} onChange={e => setQ(e.target.value)} placeholder="N.°, actividad, trabajador o referencia" className="min-h-9 w-full text-sm outline-none" /></span></Field>
        </div>
        <div className="mb-3 flex flex-wrap items-center gap-2 rounded-lg border border-blue-100 bg-blue-50/60 p-2.5 text-xs text-blue-950">
          <Files className="h-4 w-4 shrink-0 text-[#002855]" />
          {selected.size ? <span><strong>{selected.size}</strong> solicitud(es) aprobada(s) seleccionada(s) · {fmtHours(selectedMinutes)}</span>
            : <span>Marque dos o más solicitudes aprobadas para generar un solo informe consolidado (use «Aprobadas» y el rango de fechas).</span>}
          <div className="ml-auto flex gap-2">
            {selected.size > 0 && <button type="button" className="min-h-9 rounded-lg px-3 font-semibold text-slate-600 hover:bg-white" onClick={() => setSelected(new Map())}>Limpiar</button>}
            <button type="button" className={btnCls} disabled={!selected.size} onClick={() => setConsolidated([...selected.keys()])}><Files className="h-4 w-4" /> Informe consolidado</button>
          </div>
        </div>
        {error ? <p role="alert" className="text-sm text-red-700">{error}</p> : !rows ? <p className="text-sm text-slate-500">Cargando…</p> : (
          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full min-w-[1320px] text-left text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500"><tr>
                <th className="w-10 p-2.5"><input type="checkbox" aria-label="Seleccionar las aprobadas visibles" className="h-4 w-4" disabled={!visibleSelectable.length} checked={allVisible}
                  onChange={() => setSelected(m => { const n = new Map(m); visibleSelectable.forEach(r => (allVisible ? n.delete(r.id) : n.set(r.id, r))); return n })} /></th>
                <th className="p-2.5">N.°</th><th className="p-2.5">Fecha</th><th className="p-2.5">Actividad / causa</th><th className="p-2.5">Personal HHEE</th>
                <th className="p-2.5">Placa</th><th className="p-2.5">OT / OC / OS / RQ</th><th className="p-2.5 text-right">Trab.</th><th className="p-2.5 text-right">Horas</th>{ctx.caps.costs && <th className="p-2.5 text-right">Costo aprox.</th>}<th className="p-2.5">Estado</th><th className="p-2.5">Acciones</th>
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map(r => { const st = STATUS[statusOf(r)]; return <tr key={r.id} className={`cursor-pointer hover:bg-slate-50 ${selected.has(r.id) ? 'bg-blue-50/60' : ''}`} onClick={() => setOpen(r.id)}>
                  <td className="p-2.5" onClick={e => e.stopPropagation()}>{selectable(r) && <input type="checkbox" aria-label={`Incluir HE-${String(r.sequence).padStart(5, '0')} en el consolidado`} className="h-4 w-4"
                    checked={selected.has(r.id)} onChange={() => toggle(r)} />}</td>
                  <td className="p-2.5 font-mono text-xs font-semibold text-[#002855]">HE-{String(r.sequence).padStart(5, '0')}</td>
                  <td className="p-2.5">{fmtDate(r.work_date)}</td>
                  <td className="p-2.5"><p className="max-w-80 truncate font-medium text-slate-800">{isPendingText(r.activity) ? <span className="text-amber-800">Completar actividad y motivo</span> : r.activity}</p>
                    <p className="text-[11px] text-slate-500">{r.cause} · {r.area}{r.auto_dispatch_id && <span className="ml-1.5 rounded-full bg-blue-50 px-1.5 py-0.5 font-semibold text-blue-800">Automática · ruta {r.auto_dispatch_number}</span>}</p></td>
                  <td className="max-w-64 p-2.5 text-xs" title={r.people?.join(' · ')}>{r.people?.join(' · ') || '—'}</td>
                  <td className="p-2.5 text-xs" title={r.plates?.join(' · ')}>{r.plates?.join(' · ') || '—'}</td>
                  <td className="p-2.5 text-xs">{r.reference_type && r.reference_type !== 'SIN_REFERENCIA' ? `${r.reference_type}${r.reference_code ? ` · ${r.reference_code}` : ''}` : '—'}</td>
                  <td className="p-2.5 text-right tabular-nums">{r.workers}</td>
                  <td className="p-2.5 text-right tabular-nums">{fmtHours(r.minutes)}</td>
                  {ctx.caps.costs && <td className="p-2.5 text-right tabular-nums">{r.cost != null ? fmtMoney(r.cost) : '—'}{r.pending_cost ? <span className="block text-[10px] text-amber-700">{r.pending_cost} pendiente</span> : null}</td>}
                  <td className="p-2.5"><span className={`whitespace-nowrap rounded-full px-2 py-0.5 text-[11px] font-semibold ${st.tone}`}>{st.label}</span>{r.revisions > 1 && <span className="ml-1 text-[10px] text-slate-500">v{r.revisions}</span>}</td>
                  <td className="p-2.5" onClick={e => e.stopPropagation()}><button type="button" className="whitespace-nowrap rounded-lg border border-slate-300 px-2.5 py-1.5 text-xs font-semibold text-[#002855] hover:bg-blue-50" onClick={() => setOpen(r.id)}>Gestionar</button></td>
                </tr> })}
              </tbody>
            </table>
            {!rows.length && <p className="p-6 text-center text-sm text-slate-400">Sin solicitudes en este filtro.</p>}
          </div>
        )}
      </Card>
      {form && <RequestForm detail={form === 'new' ? null : form} onClose={() => setForm(null)} onSaved={async id => { setForm(null); refresh(); setOpen(id) }} />}
      {consolidated && <ConsolidatedModal ids={consolidated} onClose={() => setConsolidated(null)} />}
      {open && !form && <RequestDetail id={open} onClose={() => setOpen(null)} onChanged={refresh} onEdit={d => setForm(d)} />}
    </div>
  )
}

function RequestDetail({ id, onClose, onChanged, onEdit }: { id: string; onClose: () => void; onChanged: () => void; onEdit: (d: Detail) => void }) {
  const { ctx } = useFlow()
  const [d, setD] = useState<Detail | null>(null)
  const [error, setError] = useState('')
  const [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState('')
  const [mail, setMail] = useState<Detail['authorizations'][number] | null>(null)
  const load = useCallback(async () => {
    try { setD(await call<Detail>('hhee_flow_detail', { p_id: id })); setError('') } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo cargar') }
  }, [id])
  useEffect(() => { let alive = true; call<Detail>('hhee_flow_detail', { p_id: id }).then(r => { if (alive) setD(r) }).catch(e => { if (alive) setError(e instanceof Error ? e.message : 'No se pudo cargar') }); return () => { alive = false } }, [id])
  const act = async (fn: () => Promise<unknown>, done: string) => {
    setBusy(true); setNotice('')
    try { await fn(); toast.success(done); await load(); onChanged() } catch (e) {
      const data = (e as { data?: { stale_cost?: boolean } }).data
      if (data?.stale_cost) { await load(); setNotice(e instanceof Error ? e.message : '') } else toast.error(e instanceof Error ? e.message : 'No se pudo completar')
    } finally { setBusy(false) }
  }
  if (error) return <Modal title="Solicitud" onClose={onClose}><p role="alert" className="text-sm text-red-700">{error}</p></Modal>
  if (!d) return <Modal title="Solicitud" onClose={onClose}><p className="text-sm text-slate-500">Cargando…</p></Modal>
  const r = d.request, st = STATUS[statusOf(r)], mine = r.created_by === ctx.user_id
  const decide = (decision: 'APROBADA' | 'OBSERVADA' | 'RECHAZADA') => act(() => call('hhee_flow_decide', { p: { id: r.id, decision, reason, expected_version: r.version, ...(d.cost_visible ? { expected_cost: r.cost ?? 0 } : {}) } }),
    decision === 'APROBADA' ? 'Aprobada: informe generado' : decision === 'OBSERVADA' ? 'Observada: devuelta al supervisor' : 'Rechazada')
  const latest = d.authorizations[0]
  return (
    <Modal title={`HE-${String(r.sequence).padStart(5, '0')} · ${r.activity}`} onClose={onClose} wide>
      <div className="flex flex-wrap items-center gap-2">
        <span className={`rounded-full px-3 py-1 text-xs font-bold ${st.tone}`}>{st.label}</span>
        <span className="text-xs text-slate-500">Registrada por {r.requester} el {fmtDateTime(r.created_at)}{r.submitted_at ? ` · presentada ${fmtDateTime(r.submitted_at)}` : ''}</span>
        <div className="ml-auto flex flex-wrap gap-2">
          {r.can_edit && <button type="button" className={btn2Cls} onClick={() => onEdit(d)}><Pencil className="h-4 w-4" /> {r.approval === 'APROBADA' ? 'Modificar (requiere nueva aprobación)' : 'Editar'}</button>}
          {r.can_edit && r.state === 'BORRADOR' && <button type="button" className={btnCls} disabled={busy} onClick={() => void act(() => call('hhee_flow_submit', { p_id: r.id, p_version: r.version }), 'Presentada para aprobación')}><Send className="h-4 w-4" /> Presentar para aprobación</button>}
          {mine && (r.state === 'BORRADOR' || (r.state === 'SOLICITADA' && r.approval === 'PENDIENTE')) && <button type="button" className={btn2Cls} disabled={busy}
            onClick={() => { if (window.confirm('¿Anular esta solicitud?')) void act(() => call('hhee_flow_cancel', { p_id: r.id, p_version: r.version, p_reason: null }), 'Solicitud anulada') }}>Anular</button>}
        </div>
      </div>
      {r.approval_reason && r.approval !== 'PENDIENTE' && <p className={`rounded-lg p-3 text-sm ${r.approval === 'APROBADA' ? 'bg-emerald-50 text-emerald-900' : r.approval === 'OBSERVADA' ? 'bg-orange-50 text-orange-900' : 'bg-red-50 text-red-900'}`}>
        <strong>{r.approval === 'APROBADA' ? `Aprobada por ${r.approver} (${fmtDateTime(r.approved_at)})` : r.approval === 'OBSERVADA' ? 'Observación' : `Rechazada por ${r.approver}`}:</strong> {r.approval_reason}</p>}
      {d.holiday && <p className="flex items-center gap-2 rounded-lg border border-violet-200 bg-violet-50 p-3 text-sm text-violet-900"><CalendarX2 className="h-4 w-4" /> Feriado: <strong>{d.holiday}</strong> · horas al 100 %.</p>}
      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Qué, por qué y para qué">
          <dl className="grid gap-2 text-sm">
            <div><dt className="text-xs font-semibold text-slate-500">Fecha · área · causa</dt><dd>{fmtDate(r.work_date)} · {r.area} · {r.cause}</dd></div>
            {r.reference_type !== 'SIN_REFERENCIA' && <div><dt className="text-xs font-semibold text-slate-500">Referencia</dt><dd>{r.reference_type} {r.reference_code}</dd></div>}
            <div><dt className="text-xs font-semibold text-slate-500">¿Por qué se necesitan?</dt><dd className="whitespace-pre-line">{r.justification}</dd></div>
            <div><dt className="text-xs font-semibold text-slate-500">Alternativa evaluada</dt><dd className="whitespace-pre-line">{r.alternatives}</dd></div>
            <div><dt className="text-xs font-semibold text-slate-500">Resultado esperado</dt><dd>{r.expected_result}</dd></div>
          </dl>
        </Card>
        <Card title="Quiénes y cuántas horas" subtitle={`${r.workers} trabajador(es) · ${fmtHours(r.minutes)}${d.cost_visible ? ` · ${fmtMoney(r.cost)} aprox.` : ''}`}>
          <div className="overflow-x-auto">
            <table className="w-full min-w-[520px] text-left text-xs">
              <thead className="text-[10px] uppercase text-slate-500"><tr><th className="py-1.5">Trabajador</th><th>Horario</th><th className="text-right">25 %</th><th className="text-right">35 %</th><th className="text-right">100 %</th><th className="text-right">Total</th>{d.cost_visible && <th className="text-right">Costo</th>}</tr></thead>
              <tbody className="divide-y divide-slate-100">{d.lines.map(l => <tr key={l.person_id}>
                <td className="py-1.5"><p className="font-semibold">{l.name}</p><p className="text-[10px] text-slate-500">{l.code}{l.document_number ? ` · DNI ${l.document_number}` : ''}{l.position ? ` · ${l.position}` : ''}{l.rest_day ? ' · día de descanso' : ''}</p>{l.plate_source && <p className={`text-[10px] font-semibold ${l.plate_source === 'MANUAL' ? 'text-amber-800' : 'text-blue-800'}`}>{plateLabel(l)}</p>}</td>
                <td>{fmtTime(l.start)}–{fmtTime(l.end)}{l.break_minutes ? ` (−${l.break_minutes}m)` : ''}</td>
                <td className="text-right">{fmtHours(l.minutes_25)}</td><td className="text-right">{fmtHours(l.minutes_35)}</td><td className="text-right">{fmtHours(l.minutes_100)}</td>
                <td className="text-right font-semibold">{fmtHours(l.minutes)}</td>
                {d.cost_visible && <td className="text-right">{l.cost == null ? <span className="text-amber-700">Pendiente</span> : fmtMoney(l.cost)}</td>}
              </tr>)}</tbody>
            </table>
          </div>
          {r.pending_cost > 0 && d.cost_visible && <p className="mt-2 text-xs text-amber-800">{r.pending_cost} trabajador(es) con costo pendiente: completar su ficha en Personal.</p>}
        </Card>
      </div>
      {r.approval === 'APROBADA' && r.state !== 'CANCELADA' && <ExecCard d={d} canPay={ctx.caps.approve || ctx.caps.people} canClose={ctx.caps.approve || (mine && ctx.caps.request) || ctx.caps.admin}
        busy={busy} act={act} />}
      {r.can_decide && <Card title="Decisión del aprobador" subtitle="Sustento obligatorio. Al aprobar se genera el informe PDF y el correo.">
        <Field label="Sustento de aprobación, observación o rechazo *"><textarea className={inputCls} rows={3} value={reason} onChange={e => setReason(e.target.value)} maxLength={2000} /></Field>
        {notice && <p role="alert" className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{notice}</p>}
        <div className="mt-3 flex flex-wrap justify-end gap-2">
          <button type="button" className={btn2Cls} disabled={busy || reason.trim().length < 5} onClick={() => void decide('RECHAZADA')}><XCircle className="h-4 w-4 text-red-600" /> Rechazar</button>
          <button type="button" className={btn2Cls} disabled={busy || reason.trim().length < 5} onClick={() => void decide('OBSERVADA')}>Observar (devolver para corregir)</button>
          <button type="button" className={btnCls} disabled={busy || reason.trim().length < 5} onClick={() => void decide('APROBADA')}><CheckCircle2 className="h-4 w-4" /> Aprobar y generar informe</button>
        </div>
      </Card>}
      {d.authorizations.length > 0 && <Card title="Informe de autorización" subtitle={`${d.authorizations.length} versión(es). Cada nueva aprobación genera una nueva versión.`}>
        <div className="grid gap-2">{d.authorizations.map(a => <div key={a.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white p-3 text-sm">
          <span className="font-semibold text-[#002855]">{folio(a.snapshot)} · versión {a.revision}{a === latest ? ' (vigente)' : ''}</span>
          <span className="text-xs text-slate-500">Aprobada por {a.approver} el {fmtDateTime(a.approved_at)} · {fmtHours(a.snapshot.totals.minutes)}{d.cost_visible && a.snapshot.totals.cost != null ? ` · ${fmtMoney(a.snapshot.totals.cost)}` : ''}</span>
          <div className="ml-auto flex flex-wrap gap-2">
            <button type="button" className={btn2Cls} onClick={() => void downloadPdf(a.snapshot, d.cost_visible)}><FileDown className="h-4 w-4" /> Descargar PDF de autorización</button>
            <button type="button" className={btn2Cls} onClick={() => setMail(a)}><Mail className="h-4 w-4" /> Preparar / volver a compartir por correo</button>
          </div>
        </div>)}</div>
      </Card>}
      <Card title="Historial">
        <ul className="grid gap-1.5 text-xs">{d.events.map((e, i) => <li key={i} className="flex flex-wrap gap-2"><span className="text-slate-500">{fmtDateTime(e.at)}</span><strong>{e.event.replaceAll('_', ' ').toLowerCase()}</strong><span>{e.by}</span>{e.reason && <span className="text-slate-600">— {e.reason}</span>}</li>)}</ul>
      </Card>
      {mail && <EmailComposer title={`Correo de autorización · ${folio(mail.snapshot)} v${mail.revision}`} draft={emailDraft(mail.snapshot, d.cost_visible)}
        onPdf={() => void downloadPdf(mail.snapshot, d.cost_visible)} onClose={() => setMail(null)} />}
    </Modal>
  )
}

// Ejecutado frente a lo autorizado: cierre (app, geocerca o supervisor), reparto real y pago o compensación por línea
function ExecCard({ d, canPay, canClose, busy, act }: { d: Detail; canPay: boolean; canClose: boolean; busy: boolean; act: (fn: () => Promise<unknown>, done: string) => Promise<void> }) {
  const [end, setEnd] = useState(''); const [why, setWhy] = useState('')
  const open = d.lines.filter(l => !l.actual_end)
  return <Card title="Ejecutado" subtitle={open.length ? `${open.length} trabajador(es) con horas extras abiertas: las cierra el conductor desde el app, la salida de la base o el registro del supervisor.` : 'Horas extras cerradas.'}>
    <div className="overflow-x-auto">
      <table className="w-full min-w-[640px] text-left text-xs [&_td]:px-2 [&_th]:px-2">
        <thead className="text-[10px] uppercase text-slate-500"><tr><th className="py-1.5">Trabajador</th><th>Fin real</th><th className="text-right">Autorizado</th><th className="text-right">Ejecutado</th><th>Cierre</th><th>Pago o descanso</th>{d.cost_visible && <th className="text-right">Costo ejecutado</th>}</tr></thead>
        <tbody className="divide-y divide-slate-100">{d.lines.map(l => <tr key={l.person_id}>
          <td className="py-1.5 font-semibold">{l.name}</td>
          <td>{l.actual_end ? fmtTime(l.actual_end) : <span className="text-amber-700">Abierta</span>}</td>
          <td className="text-right">{fmtHours(l.minutes)}</td>
          <td className="text-right font-semibold">{l.actual_end ? <>{fmtHours(l.actual_minutes)}<span className="block text-[10px] font-normal text-slate-500">{[[l.exec_minutes_25, '25'], [l.exec_minutes_35, '35'], [l.exec_minutes_100, '100']].filter(([m]) => Number(m) > 0).map(([m, p]) => `${fmtHours(Number(m))} al ${p} %`).join(' · ')}</span></> : '—'}</td>
          <td>{l.closed_by ? <span title={l.close_reason || undefined}>{CLOSED_BY[l.closed_by]}</span> : '—'}</td>
          <td>{canPay && l.id ? <select aria-label={`Pago o compensación de ${l.name}`} className="rounded border border-slate-300 px-1 py-0.5" disabled={busy} value={l.compensation ? 'C' : 'P'}
              onChange={e => void act(() => call('hhee_line_set_compensation', { p_line: l.id, p_compensation: e.target.value === 'C' }), e.target.value === 'C' ? 'Se compensará con descanso' : 'Se pagará')}>
              <option value="P">Pago</option><option value="C">Compensar con descanso</option></select>
            : l.compensation ? 'Compensar con descanso' : 'Pago'}</td>
          {d.cost_visible && <td className="text-right">{l.actual_end ? (l.exec_cost == null ? <span className="text-amber-700">Pendiente</span> : fmtMoney(l.exec_cost)) : '—'}</td>}
        </tr>)}</tbody>
      </table>
    </div>
    <p className="mt-2 text-[11px] text-slate-500">Compensar (D.S. 007-2002-TR art. 10): el trabajador recibe descanso equivalente en lugar del pago; las horas ejecutadas suman a su bolsa en Personal.</p>
    {canClose && open.length > 0 && <div className="mt-3 grid gap-2 rounded-lg border border-slate-200 bg-slate-50 p-3 sm:grid-cols-[auto_1fr_auto] sm:items-end">
      <Field label="Fin real"><input type="datetime-local" className={inputCls} value={end} onChange={e => setEnd(e.target.value)} /></Field>
      <Field label="Por qué lo registra usted *"><input className={inputCls} value={why} maxLength={300} onChange={e => setWhy(e.target.value)} placeholder="Ej.: el conductor no cerró en el app" /></Field>
      <button type="button" className={btnCls} disabled={busy || !end || why.trim().length < 5}
        onClick={() => void act(() => call('hhee_flow_close', { p: { id: d.request.id, end, reason: why } }), 'Cierre registrado')}><CheckCircle2 className="h-4 w-4" /> Registrar cierre</button>
    </div>}
  </Card>
}

// Informe consolidado: una sola autorización vigente por solicitud elegida, con resumen por trabajador, PDF y correo
function ConsolidatedModal({ ids, onClose }: { ids: string[]; onClose: () => void }) {
  const [data, setData] = useState<Consolidated | null>(null)
  const [error, setError] = useState('')
  const [mail, setMail] = useState(false)
  useEffect(() => {
    let alive = true
    call<Consolidated>('hhee_flow_consolidated', { p_ids: ids }).then(r => { if (alive) setData(r) }).catch(e => { if (alive) setError(e instanceof Error ? e.message : 'No se pudo cargar') })
    return () => { alive = false }
  }, [ids])
  if (error) return <Modal title="Informe consolidado" onClose={onClose}><p role="alert" className="text-sm text-red-700">{error}</p></Modal>
  if (!data) return <Modal title="Informe consolidado" onClose={onClose}><p className="text-sm text-slate-500">Cargando…</p></Modal>
  const snaps = data.items.map(i => i.snapshot), c = consolidate(snaps), withCost = data.cost_visible
  return (
    <Modal title={`Informe consolidado · ${c.sorted.length} autorización(es)`} onClose={onClose} wide>
      {data.skipped > 0 && <p className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">{data.skipped} solicitud(es) elegida(s) ya no están aprobadas y no se incluyen.</p>}
      <div className="grid gap-3 sm:grid-cols-4">
        {[['Período', c.from === c.to ? fmtDate(c.from) : `${fmtDate(c.from)} – ${fmtDate(c.to)}`], ['Trabajadores', String(c.workers.length)], ['Horas autorizadas', fmtHours(c.tot.m)],
          withCost ? ['Costo aproximado', fmtMoney(Math.round(c.tot.cost * 100) / 100)] : ['25 % · 35 % · 100 %', `${fmtHours(c.tot.m25)} · ${fmtHours(c.tot.m35)} · ${fmtHours(c.tot.m100)}`]]
          .map(([k, v]) => <div key={k} className="rounded-xl border border-slate-200 bg-white p-3"><p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{k}</p><p className="mt-1 text-lg font-black text-[#002855]">{v}</p></div>)}
      </div>
      <Card title="Autorizaciones incluidas">
        <ul className="grid gap-1 text-sm">{c.sorted.map(s => <li key={s.request.id} className="flex flex-wrap gap-2"><span className="font-mono text-xs font-semibold text-[#002855]">{folio(s)} v{s.revision}</span>
          <span>{fmtDate(s.request.work_date)}{s.holiday ? ` · feriado` : ''}</span><span className="text-slate-600">{s.cause} · {s.request.activity}</span><span className="ml-auto tabular-nums">{fmtHours(s.totals.minutes)}</span></li>)}</ul>
      </Card>
      <Card title="Resumen por trabajador">
        <div className="overflow-x-auto"><table className="w-full min-w-[640px] text-left text-xs">
          <thead className="text-[10px] uppercase text-slate-500"><tr><th className="py-1.5">Trabajador</th><th>DNI</th><th className="text-right">Días</th><th className="text-right">25 %</th><th className="text-right">35 %</th><th className="text-right">100 %</th><th className="text-right">Total</th>{withCost && <th className="text-right">Costo</th>}</tr></thead>
          <tbody className="divide-y divide-slate-100">{c.workers.map(w => <tr key={w.code}><td className="py-1.5"><p className="font-semibold">{w.name}</p><p className="text-[10px] text-slate-500">{w.code}{w.position ? ` · ${w.position}` : ''}</p></td>
            <td>{w.doc || '—'}</td><td className="text-right">{w.days.size}</td><td className="text-right">{fmtHours(w.m25)}</td><td className="text-right">{fmtHours(w.m35)}</td><td className="text-right">{fmtHours(w.m100)}</td>
            <td className="text-right font-semibold">{fmtHours(w.m)}</td>{withCost && <td className="text-right">{fmtMoney(w.cost)}{w.pending ? <span className="text-amber-700"> +pend.</span> : null}</td>}</tr>)}</tbody>
        </table></div>
      </Card>
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={btn2Cls} onClick={() => setMail(true)}><Mail className="h-4 w-4" /> Preparar correo</button>
        <button type="button" className={btnCls} onClick={() => void downloadConsolidatedPdf(snaps, withCost)}><FileDown className="h-4 w-4" /> Descargar PDF consolidado</button>
      </div>
      {mail && <EmailComposer title="Correo del informe consolidado" draft={consolidatedEmailDraft(snaps, withCost)} onPdf={() => void downloadConsolidatedPdf(snaps, withCost)} onClose={() => setMail(false)} />}
    </Modal>
  )
}

function EmailComposer({ title, draft: base, onPdf, onClose }: { title: string; draft: { subject: string; body: string }; onPdf: () => void; onClose: () => void }) {
  const { ctx } = useFlow()
  const [draft, setDraft] = useState({ to: ctx.settings.report_to, cc: ctx.settings.report_cc, subject: base.subject, body: base.body })
  const [error, setError] = useState('')
  const open = (client: EmailClient) => {
    try { setError(''); window.open(trackingEmailUrl(client, draft), client === 'default' ? '_self' : '_blank', 'noopener') } catch (e) { setError(e instanceof Error ? e.message : 'Revise el correo') }
  }
  return (
    <Modal title={title} onClose={onClose}>
      <p className="rounded-lg bg-blue-50 p-3 text-xs text-blue-900">Descargue el PDF y adjúntelo al correo. El mensaje incluye el resumen: por qué, quiénes y cuántas horas; no incluye conceptos remunerativos.</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Para *"><input className={inputCls} value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} placeholder="correo@empresa.com; otro@empresa.com" /></Field>
        <Field label="CC"><input className={inputCls} value={draft.cc} onChange={e => setDraft({ ...draft, cc: e.target.value })} /></Field>
        <Field label="Asunto" className="sm:col-span-2"><input className={inputCls} value={draft.subject} onChange={e => setDraft({ ...draft, subject: e.target.value })} /></Field>
        <Field label="Mensaje · vista previa editable" className="sm:col-span-2"><textarea className={`${inputCls} font-mono text-xs`} rows={14} value={draft.body} onChange={e => setDraft({ ...draft, body: e.target.value })} /></Field>
      </div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <button type="button" className={btn2Cls} onClick={onPdf}><FileDown className="h-4 w-4" /> PDF para adjuntar</button>
        <button type="button" className={btn2Cls} onClick={() => { void navigator.clipboard.writeText(draft.body).then(() => toast.success('Mensaje copiado'), () => toast.error('No se pudo copiar')) }}><Copy className="h-4 w-4" /> Copiar mensaje</button>
        <button type="button" className={btn2Cls} onClick={() => open('gmail')}>Gmail</button>
        <button type="button" className={btn2Cls} onClick={() => open('outlook')}>Outlook</button>
        <button type="button" className={btnCls} onClick={() => open('default')}><Mail className="h-4 w-4" /> Programa de correo</button>
      </div>
    </Modal>
  )
}
