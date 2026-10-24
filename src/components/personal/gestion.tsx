'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { toast } from 'sonner'
import { Card, Field, Modal, Kpi, btnCls, btn2Cls, inputCls, useFlow } from '@/components/hhee/flujo/context'
import { call, fmtDate, fmtDateTime, fmtHours, today } from '@/lib/hhee/flujo'
import { exportAptXlsx } from '@/lib/apt/export'
import type { Day, Overview, Permit, Shift } from '@/lib/personal/types'

const labels: Record<string, string> = { REVISAR: 'Revisar asistencia: permiso anulado', ASISTENCIA_DECLARADA: 'Asistencia declarada', AUSENTE: 'Ausente', DESCANSO: 'Descanso', PERMISO: 'Permiso aprobado', SIN_HORARIO: 'Sin horario', PENDIENTE: 'Pendiente', APROBADO: 'Aprobado', APLICADO: 'Aplicado', RECHAZADO: 'Rechazado', ANULADO: 'Anulado' }
const table = 'w-full min-w-[650px] text-left text-sm [&_th]:p-2 [&_th]:text-xs [&_th]:text-slate-500 [&_td]:p-2 [&_tr]:border-b [&_tr]:border-slate-100'
const message = (e: unknown) => e instanceof Error ? e.message : 'No se pudo completar la operación'
const initialRange = () => ({ from: `${today().slice(0, 7)}-01`, to: today(), area_id: '' })

function useOverview() {
 const [filters, setFilters] = useState(initialRange)
 const [data, setData] = useState<Overview | null>(null)
 const [error, setError] = useState('')
 const [loading, setLoading] = useState(false)
 const reload = useCallback(async () => {
  setLoading(true)
  try { setData(await call<Overview>('gp_overview', { p: filters })); setError('') }
  catch (e) { setError(message(e)); setData(null) } finally { setLoading(false) }
 }, [filters])
 useEffect(() => { let alive = true; const timer = setTimeout(() => { setLoading(true); call<Overview>('gp_overview', { p: filters }).then(d => { if (alive) { setData(d); setError('') } }).catch(e => { if (alive) { setError(message(e)); setData(null) } }).finally(() => { if (alive) setLoading(false) }) }, 150); return () => { alive = false; clearTimeout(timer) } }, [filters])
 return { filters, setFilters, data, error, loading, reload }
}

function RangeFilter({ value, onChange }: { value: ReturnType<typeof initialRange>; onChange: (f: ReturnType<typeof initialRange>) => void }) {
 const { ctx } = useFlow()
 return <div className="flex flex-wrap items-end gap-3 rounded-xl bg-white p-3 ring-1 ring-slate-200">
  <Field label="Desde"><input type="date" className={inputCls} value={value.from} onChange={e => onChange({ ...value, from: e.target.value })} /></Field>
  <Field label="Hasta"><input type="date" className={inputCls} value={value.to} onChange={e => onChange({ ...value, to: e.target.value })} /></Field>
  <Field label="Área"><select className={inputCls} value={value.area_id} onChange={e => onChange({ ...value, area_id: e.target.value })}><option value="">Todas las autorizadas</option>{ctx.areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
 </div>
}

export function Attendance() {
 const { ctx } = useFlow()
 const [area, setArea] = useState(ctx.areas[0]?.id ?? '')
 const [date, setDate] = useState(today)
 const [day, setDay] = useState<Day | null>(null)
 const [error, setError] = useState('')
 const [absences, setAbsences] = useState<Record<string, string>>({})
 const [reason, setReason] = useState('')
 const [busy, setBusy] = useState(false)
 const [editSchedule, setEditSchedule] = useState<string | null>(null)
 const [nonce, setNonce] = useState(0)
 useEffect(() => {
  let alive = true; const timer = setTimeout(() => { setDay(null); setError(''); setReason('')
  if (area && date) call<Day>('gp_day', { p_area: area, p_date: date }).then(d => { if (alive) { setDay(d); setAbsences(Object.fromEntries(d.rows.filter(r => r.status === 'AUSENTE').map(r => [r.person_id, r.note ?? 'Ausencia por justificar']))) } }).catch(e => { if (alive) setError(message(e)) })
  }, 0); return () => { alive = false; clearTimeout(timer) }
 }, [area, date, nonce])
 const missing = day?.rows.filter(r => r.shift.kind === 'SIN_HORARIO').length ?? 0
 const editable = day?.can_confirm && (!day.day || day.can_correct)
 const confirm = async () => {
  setBusy(true); setError('')
  try { const d = await call<Day>('gp_day_confirm', { p: { area_id: area, date, revision: day?.day?.revision ?? 0, reason, absences: Object.entries(absences).map(([person_id, note]) => ({ person_id, note })) } }); setDay(d); setReason(''); toast.success('Asistencia confirmada y registrada en el historial') }
  catch (e) { setError(message(e)) } finally { setBusy(false) }
 }
 return <div className="grid gap-4">
  <Card title="Control de asistencia" subtitle="Marque únicamente a los ausentes y confirme el día. Los demás programados quedan con asistencia declarada, no con una marcación real.">
   <div className="mb-3 flex flex-wrap items-end gap-3"><Field label="Fecha"><input type="date" max={today()} className={inputCls} value={date} onChange={e => setDate(e.target.value)} /></Field><Field label="Área"><select className={inputCls} value={area} onChange={e => setArea(e.target.value)}>{ctx.areas.map(a => <option value={a.id} key={a.id}>{a.name}</option>)}</select></Field><Link className={btn2Cls} href="/hhee/horarios">Programar horarios</Link></div>
   {error && <p role="alert" className="mb-3 rounded-lg bg-red-50 p-3 text-red-800">{error}</p>}
   {day ? <>
    <div className="mb-3 rounded-lg bg-sky-50 p-3 text-sm text-sky-900">{day.day ? `Confirmado: ${fmtDateTime(day.day.confirmed_at)} · revisión ${day.day.revision}` : 'Día pendiente de confirmación. Todavía no se declara asistencia.'}{missing > 0 && <p className="font-semibold">Falta programar horario de {missing} colaborador(es). No se puede confirmar.</p>}</div>
    <div className="overflow-x-auto"><table className={table}><thead><tr><th>Colaborador</th><th>Horario</th><th>Estado</th><th>Permiso aprobado</th><th>Ausente / motivo</th></tr></thead><tbody>{day.rows.map(r => {
     const fullPermit = r.shift.kind === 'TRABAJO' && r.permit_minutes >= (r.shift.minutes ?? Infinity)
     return <tr key={r.person_id}><td><b>{r.name}</b><small className="block text-slate-500">{r.code}</small></td><td>{r.shift.kind === 'TRABAJO' ? `${r.shift.start}–${r.shift.end}${r.shift.next_day ? ' (+1 día)' : ''} · ${fmtHours(r.shift.minutes)}` : labels[r.shift.kind]}{editable && !day.day && <button className="ml-2 text-xs text-blue-800 underline" onClick={() => setEditSchedule(r.person_id)}>Programar día</button>}</td><td>{fullPermit ? 'Permiso aprobado' : labels[r.status] ?? r.status}</td><td>{r.permit_minutes ? fmtHours(r.permit_minutes) : '—'}</td><td>{r.shift.kind === 'TRABAJO' && !fullPermit && <div className="flex items-center gap-2"><input aria-label={`Marcar ausencia de ${r.name}`} type="checkbox" disabled={!editable || busy} checked={r.person_id in absences} onChange={e => setAbsences(a => { const copy = { ...a }; if (e.target.checked) copy[r.person_id] = 'Ausencia por justificar'; else delete copy[r.person_id]; return copy })} />{r.person_id in absences && <input aria-label={`Motivo de ausencia de ${r.name}`} disabled={!editable || busy} maxLength={1000} className={inputCls} value={absences[r.person_id]} onChange={e => setAbsences(a => ({ ...a, [r.person_id]: e.target.value }))} />}</div>}</td></tr>
    })}</tbody></table></div>
    {editable && <div className="mt-4 flex flex-wrap items-end gap-3">{day.day && <Field label="Motivo de corrección"><input className={inputCls} value={reason} onChange={e => setReason(e.target.value)} maxLength={1000} /></Field>}<button className={btnCls} disabled={busy || !day.rows.length || missing > 0 || (day.day != null && reason.trim().length < 5) || Object.values(absences).some(v => v.trim().length < 5)} onClick={() => void confirm()}>{busy ? 'Confirmando…' : day.day ? 'Guardar corrección auditada' : 'Confirmar asistencia del día'}</button></div>}
   </> : !error && <p>Cargando personal programado…</p>}
  </Card>
  {editSchedule && <ShiftModal personId={editSchedule} date={date} onClose={() => setEditSchedule(null)} onSaved={() => { setEditSchedule(null); setNonce(n => n + 1) }} />}
 </div>
}

function ShiftFields({ value, onChange }: { value: Shift; onChange: (s: Shift) => void }) {
 return <div className="flex flex-wrap items-end gap-2"><Field label="Tipo"><select className={inputCls} value={value.kind} onChange={e => onChange({ ...value, kind: e.target.value as Shift['kind'] })}><option value="TRABAJO">Trabajo</option><option value="DESCANSO">Descanso</option></select></Field>{value.kind === 'TRABAJO' && <><Field label="Inicio"><input className={inputCls} type="time" required value={value.start ?? ''} onChange={e => onChange({ ...value, start: e.target.value })} /></Field><Field label="Fin"><input className={inputCls} type="time" required value={value.end ?? ''} onChange={e => onChange({ ...value, end: e.target.value })} /></Field><Field label="Descanso (min)"><input className={`${inputCls} w-24`} type="number" min={0} max={959} required value={value.break_minutes ?? 0} onChange={e => onChange({ ...value, break_minutes: Number(e.target.value) })} /></Field></>}</div>
}
const blankShift = (): Shift => ({ kind: 'TRABAJO', start: '', end: '', break_minutes: 0, minutes: null })

function ShiftModal({ personId, date, onClose, onSaved }: { personId: string; date: string; onClose: () => void; onSaved: () => void }) {
 const [shift, setShift] = useState<Shift>(blankShift)
 const [reason, setReason] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('')
 return <Modal title={`Turno del ${fmtDate(date)}`} onClose={onClose}><form className="grid gap-3" onSubmit={async e => { e.preventDefault(); setBusy(true); try { await call('gp_shift_day_save', { p: { person_id: personId, date, shift, reason } }); onSaved() } catch (e) { setError(message(e)) } finally { setBusy(false) } }}><ShiftFields value={shift} onChange={setShift} /><Field label="Motivo de la programación"><input required minLength={5} maxLength={1000} className={inputCls} value={reason} onChange={e => setReason(e.target.value)} /></Field>{error && <p role="alert" className="text-red-800">{error}</p>}<button className={btnCls} disabled={busy}>Guardar turno</button></form></Modal>
}

export function Schedules() {
 const { ctx } = useFlow(); const o = useOverview()
 const [personId, setPersonId] = useState(''); const [from, setFrom] = useState(today); const [mode, setMode] = useState('FIJO')
 const [week, setWeek] = useState<Shift[]>(() => Array.from({ length: 7 }, () => ({ kind: 'DESCANSO', minutes: 0 })))
 const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [rotation, setRotation] = useState(false)
 const allowed = ctx.people.filter(p => p.active && ctx.areas.some(a => a.id === p.area_id && (a.can_request || a.can_approve)))
 return <div className="grid gap-4"><Card title="Horarios fijos y rotativos" subtitle="Sin horario no se presume asistencia. Los turnos nocturnos pueden terminar al día siguiente. Cada nueva vigencia conserva el historial.">
  {allowed.length > 0 && <form className="grid gap-4" onSubmit={async e => { e.preventDefault(); setBusy(true); setError(''); try { await call('gp_schedule_save', { p: { person_id: personId, from, mode, week } }); await o.reload(); toast.success('Horario versionado guardado') } catch (e) { setError(message(e)) } finally { setBusy(false) } }}>
   <div className="flex flex-wrap items-end gap-3"><Field label="Colaborador"><select required className={inputCls} value={personId} onChange={e => setPersonId(e.target.value)}><option value="">Seleccione</option>{allowed.map(p => <option value={p.id} key={p.id}>{p.code} · {p.name}</option>)}</select></Field><Field label="Vigente desde"><input required className={inputCls} type="date" value={from} onChange={e => setFrom(e.target.value)} /></Field><Field label="Modalidad"><select className={inputCls} value={mode} onChange={e => setMode(e.target.value)}><option value="FIJO">Fijo semanal</option><option value="ROTATIVO">Rotativo: programar cada fecha</option></select></Field></div>
   {mode === 'FIJO' ? week.map((s, i) => <div key={i} className="rounded-lg border border-slate-200 p-2"><b className="text-sm">{['Lunes','Martes','Miércoles','Jueves','Viernes','Sábado','Domingo'][i]}</b><ShiftFields value={s} onChange={x => setWeek(w => w.map((v, j) => j === i ? x : v))} /></div>) : <p className="rounded-lg bg-amber-50 p-3 text-sm">Programe cada fecha desde «Programar turno» o desde Asistencia. Una fecha no programada quedará «Sin horario».</p>}
   {error && <p role="alert" className="text-red-800">{error}</p>}<div className="flex gap-2"><button className={btnCls} disabled={busy || !personId}>Guardar nueva vigencia</button><button type="button" className={btn2Cls} disabled={!personId} onClick={() => setRotation(true)}>Programar turno del {fmtDate(from)}</button></div>
  </form>}
 </Card><Card title="Historial de horarios">{o.error && <p role="alert">{o.error}</p>}<div className="overflow-x-auto"><table className={table}><thead><tr><th>Colaborador</th><th>Modalidad</th><th>Desde</th><th>Hasta</th></tr></thead><tbody>{o.data?.schedules.map(s => <tr key={s.id}><td>{s.person}</td><td>{s.mode}</td><td>{fmtDate(s.valid_from)}</td><td>{fmtDate(s.valid_to) || 'Sin término'}</td></tr>)}</tbody></table></div></Card>{rotation && <ShiftModal personId={personId} date={from} onClose={() => setRotation(false)} onSaved={() => { setRotation(false); void o.reload() }} />}</div>
}

export function Permits() {
 const { ctx, reload: reloadContext } = useFlow(); const o = useOverview()
 const [form, setForm] = useState({ person_id: '', date: today(), minutes: '', kind: 'PERMISO', compensation: true, reason: '' })
 const [busy, setBusy] = useState(false); const [error, setError] = useState(''); const [decision, setDecision] = useState<{ permit: Permit; action: string } | null>(null); const [reason, setReason] = useState('')
 const balance = o.data?.balances.find(b => b.person_id === form.person_id)?.balance
 const run = async (p: Record<string, unknown>) => { setBusy(true); setError(''); try { await call('gp_permit', { p }); await Promise.all([o.reload(), reloadContext()]); toast.success('Permiso actualizado'); setDecision(null); return true } catch (e) { setError(message(e)); return false } finally { setBusy(false) } }
 return <div className="grid gap-4"><RangeFilter value={o.filters} onChange={o.setFilters} />
  <Card title="Permisos y compensaciones" subtitle="Una ausencia no descuenta HHEE automáticamente. La compensación requiere aprobación; reserva saldo y se descuenta cuando se aplica.">
   <form className="grid gap-3" onSubmit={async e => { e.preventDefault(); if (await run({ ...form, minutes: Number(form.minutes), action: 'CREATE' })) setForm(f => ({ ...f, reason: '', minutes: '' })) }}>
    <div className="flex flex-wrap items-end gap-3"><Field label="Colaborador"><select required className={inputCls} value={form.person_id} onChange={e => setForm({ ...form, person_id: e.target.value })}><option value="">Seleccione</option>{ctx.people.filter(p => p.active && ctx.areas.some(a => a.id === p.area_id && (a.can_request || a.can_approve))).map(p => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></Field><Field label="Fecha"><input required className={inputCls} type="date" value={form.date} onChange={e => setForm({ ...form, date: e.target.value })} /></Field><Field label="Tiempo (minutos)"><input required min={1} max={1440} step={1} className={`${inputCls} w-28`} type="number" value={form.minutes} onChange={e => setForm({ ...form, minutes: e.target.value })} /></Field><Field label="Tipo"><select className={inputCls} value={form.kind} onChange={e => setForm({ ...form, kind: e.target.value })}><option value="PERMISO">Permiso</option><option value="REGULARIZACION">Regularizar ausencia</option></select></Field></div>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.compensation} onChange={e => setForm({ ...form, compensation: e.target.checked })} />Solicitar compensación con HHEE validadas</label>
    {balance && <p className="rounded-lg bg-sky-50 p-3 text-sm">Validadas para compensar: {fmtHours(balance.earned)} · utilizadas: {fmtHours(balance.taken)} · reservadas: {fmtHours(balance.reserved)} · <b>disponibles: {fmtHours(balance.balance)}</b>{balance.legacy_unvalidated > 0 && <span className="block text-amber-900">Hay {fmtHours(balance.legacy_unvalidated)} cerradas pendientes de validación. No generan saldo todavía.</span>}</p>}
    <Field label="Motivo"><input required minLength={5} maxLength={1000} className={inputCls} value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} /></Field><button className={`${btnCls} justify-self-start`} disabled={busy || !form.person_id}>Solicitar permiso</button>
   </form>
  </Card>{(error || o.error) && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error || o.error}</p>}
  <Card title="Solicitudes de permiso" subtitle="Aprobar reserva las horas; aplicar registra su uso. Anular libera o revierte el movimiento conservando el historial."><div className="overflow-x-auto"><table className={table}><thead><tr><th>Fecha / colaborador</th><th>Tiempo</th><th>Motivo</th><th>Modalidad</th><th>Estado</th><th>Acción</th></tr></thead><tbody>{o.data?.permits.map(p => <tr key={p.id}><td>{fmtDate(p.work_date)}<b className="block">{p.person}</b></td><td>{fmtHours(p.minutes)}</td><td>{p.reason}</td><td>{p.compensation ? 'Compensación' : 'Sin cargo a bolsa'}</td><td>{labels[p.status]}</td><td>{p.can_approve && <div className="flex flex-wrap gap-1">{(p.status === 'PENDIENTE' ? [['APPROVE','Aprobar'],['REJECT','Rechazar'],['CANCEL','Anular']] : p.status === 'APROBADO' ? [['APPLY','Aplicar'],['CANCEL','Anular']] : p.status === 'APLICADO' ? [['CANCEL','Anular y revertir']] : []).map(([action, label]) => <button key={action} className={btn2Cls} disabled={busy} onClick={() => { setDecision({ permit: p, action }); setReason(''); setError('') }}>{label}</button>)}</div>}</td></tr>)}</tbody></table></div>{o.loading && <p className="text-sm">Actualizando…</p>}</Card>
  {decision && <Modal title="Decisión del permiso" onClose={() => setDecision(null)}><p className="mb-3">{decision.permit.person} · {fmtDate(decision.permit.work_date)} · {fmtHours(decision.permit.minutes)}</p><Field label="Sustento de la decisión"><input className={inputCls} minLength={5} maxLength={1000} value={reason} onChange={e => setReason(e.target.value)} /></Field>{error && <p role="alert" className="text-red-800">{error}</p>}<button className={`${btnCls} mt-3`} disabled={busy || reason.trim().length < 5} onClick={() => void run({ id: decision.permit.id, revision: decision.permit.revision, action: decision.action, reason })}>Confirmar decisión</button></Modal>}
 </div>
}

export function PersonnelReports({ home = false }: { home?: boolean }) {
 const o = useOverview()
 const sum = (k: 'open_lines' | 'awaiting_validation') => o.data?.overtime.reduce((n, x) => n + x[k], 0) ?? 0
 const exportReport = () => { if (o.data) exportAptXlsx('Gestion_de_Personal', {
  Control: [{ Desde: o.filters.from, Hasta: o.filters.to, Area: o.filters.area_id || 'Todas las autorizadas', Generado: new Date().toISOString(), Asistencia: 'Declarada por excepción, no marcación biométrica', Saldos: 'Saldo actual; no saldo histórico al fin del período' }],
  HHEE: o.data.overtime.map(r => ({ Área: r.area, Causa: r.cause, Origen: r.source, 'Min autorizados': r.authorized_minutes, 'Min ejecutados': r.executed_minutes, 'Min validados': r.validated_minutes, 'Min para compensar': r.compensation_minutes, Abiertas: r.open_lines, 'Por validar': r.awaiting_validation })),
  Asistencia: o.data.attendance, Permisos: o.data.permits.map(p => ({ Fecha: p.work_date, Persona: p.person, Minutos: p.minutes, Estado: p.status, Compensacion: p.compensation, Motivo: p.reason })),
  'Saldos actuales': o.data.balances.map(b => ({ Código: b.code, Persona: b.person, 'Min ganados validados': b.balance.earned, 'Min utilizados': b.balance.taken, 'Min reservados': b.balance.reserved, 'Min disponibles': b.balance.balance, 'Min históricos sin validar': b.balance.legacy_unvalidated })),
 }) }
 return <div className="grid gap-4"><RangeFilter value={o.filters} onChange={o.setFilters} />{o.error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{o.error}</p>}
  {home && <div className="grid gap-3 sm:grid-cols-3"><Link href="/hhee/asistencia" className="rounded-xl border border-slate-200 bg-white p-5 font-semibold text-[#002855]">Confirmar asistencia del día →</Link><Link href="/hhee/solicitudes" className="rounded-xl border border-slate-200 bg-white p-5 font-semibold text-[#002855]">Solicitar, aprobar o validar HHEE →</Link><Link href="/hhee/permisos" className="rounded-xl border border-slate-200 bg-white p-5 font-semibold text-[#002855]">Gestionar permisos y compensaciones →</Link></div>}
  <div className="grid gap-3 sm:grid-cols-3"><Kpi label="HHEE abiertas" value={sum('open_lines')} hint="Líneas aprobadas del período pendientes de cierre" /><Kpi label="HHEE por validar" value={sum('awaiting_validation')} hint="Cerradas que todavía no generan saldo" /><Kpi label="Permisos pendientes" value={o.data?.permits.filter(p => p.status === 'PENDIENTE').length ?? '—'} /></div>
  <Card title="HHEE por área, causa y origen" subtitle="Autorizadas, ejecutadas y validadas son medidas distintas. Las validadas para pago no se acreditan a la bolsa." actions={<button className={btn2Cls} disabled={!o.data || o.loading} onClick={exportReport}>Exportar Excel</button>}><div className="overflow-x-auto"><table className={table}><thead><tr><th>Área / causa</th><th>Origen</th><th>Autorizadas</th><th>Ejecutadas</th><th>Validadas</th><th>A compensar</th></tr></thead><tbody>{o.data?.overtime.map((r, i) => <tr key={i}><td><b>{r.area}</b><span className="block">{r.cause}</span></td><td>{r.source}</td><td>{fmtHours(r.authorized_minutes)}</td><td>{fmtHours(r.executed_minutes)}</td><td>{fmtHours(r.validated_minutes)}</td><td>{fmtHours(r.compensation_minutes)}</td></tr>)}</tbody></table></div></Card>
  <Card title="Bolsa de horas por colaborador" subtitle="Saldo actual, independiente del filtro de fechas. Las horas históricas cerradas sin validar se muestran separadas."><div className="overflow-x-auto"><table className={table}><thead><tr><th>Colaborador</th><th>Validadas para compensar</th><th>Utilizadas</th><th>Reservadas</th><th>Disponibles</th><th>Históricas por validar</th></tr></thead><tbody>{o.data?.balances.map(b => <tr key={b.person_id}><td>{b.person}</td><td>{fmtHours(b.balance.earned)}</td><td>{fmtHours(b.balance.taken)}</td><td>{fmtHours(b.balance.reserved)}</td><td className={b.balance.balance < 0 ? 'font-bold text-red-800' : ''}>{b.balance.balance < 0 ? `${b.balance.balance} min · requiere conciliación` : fmtHours(b.balance.balance)}</td><td>{fmtHours(b.balance.legacy_unvalidated)}</td></tr>)}</tbody></table></div></Card>
  <Card title="Asistencia confirmada"><div className="overflow-x-auto"><table className={table}><thead><tr><th>Fecha</th><th>Área</th><th>Estado</th><th>Colaboradores</th></tr></thead><tbody>{o.data?.attendance.map((r, i) => <tr key={i}><td>{fmtDate(r.work_date)}</td><td>{r.area}</td><td>{labels[r.status] ?? r.status}</td><td>{r.people}</td></tr>)}</tbody></table></div></Card>
  <Card title="Últimas acciones del período"><div className="overflow-x-auto"><table className={table}><thead><tr><th>Fecha</th><th>Acción</th><th>Usuario</th></tr></thead><tbody>{o.data?.events.map((e, i) => <tr key={i}><td>{fmtDateTime(e.created_at)}</td><td>{e.event}</td><td>{e.actor}</td></tr>)}</tbody></table></div></Card>
 </div>
}
