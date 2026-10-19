'use client';
import { useEffect, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { rpc, useHhee } from './provider';
import type { Detail } from '@/lib/hhee/types';
import { RequestForm } from './request-form';
import { code, dateLabel, hours, money } from '@/lib/hhee/core';
import { Badge, btn, Field, input, Notice, Panel, secondary, Table } from './ui';
export function RequestDetail({ id, onClose }: {
    id: string;
    onClose: () => void;
}) {
    const { context: c, mutate, revision } = useHhee(), [d, setD] = useState<Detail | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [editing, setEditing] = useState(false);
    const [reason, setReason] = useState(''), [result, setResult] = useState(''), [evidence, setEvidence] = useState(''), [achieved, setAchieved] = useState(''), [assessment, setAssessment] = useState('JUSTIFICADA'), [cause, setCause] = useState(''), [amounts, setAmounts] = useState<Record<string, number>>({});
    useEffect(() => { let active = true; rpc<Detail>('hhee_detail', { p_id: id }).then(v => { if (active) {
        setD(v);
        setResult(v.request.result_text || '');
        setEvidence(v.request.evidence || '');
        setAchieved(v.request.achieved == null ? '' : String(v.request.achieved));
        setCause(v.request.cause_id);
        setAmounts(Object.fromEntries(v.lines.map(l => [l.id, l.approved_minutes ?? l.planned_minutes])));
    } }).catch(e => { if (active)
        setError(e.message); }); return () => { active = false; }; }, [id, revision]);
    const r = d?.request, a = c?.areas.find(a => a.id === r?.area_id);
    const act = async (action: string, extra: Record<string, unknown> = {}) => { if (!r)
        return; setBusy(true); setError(''); try {
        await mutate({ action, id: r.id, version: r.version, reason, ...extra });
        setReason('');
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo completar.');
    }
    finally {
        setBusy(false);
    } };
    return <Modal isOpen onClose={onClose} title={r ? code(r.sequence) + ' · ' + r.activity : 'Detalle de HHEE'} maxWidth="max-w-6xl">
 {editing && d ? <RequestForm initial={d} onDone={() => setEditing(false)}/> : <div className="grid gap-4">{error && <Notice error>{error}</Notice>}{d && r && <>
 <div className="flex flex-wrap gap-3"><Badge value={r.state}/><Badge value={r.approval}/><span className="text-sm">{dateLabel(r.work_date)} · {a?.name} · {r.reference_type} {r.reference_code}</span></div>
 <div className="grid gap-4 md:grid-cols-2"><Panel title="Sustento y resultado esperado"><p className="text-sm whitespace-pre-wrap">{r.justification}</p><p className="mt-2 text-sm"><b>Alternativas:</b> {r.alternatives}</p><p className="mt-2 text-sm"><b>Área origen de la necesidad:</b> {r.origin_area_name || 'Por determinar'}</p><p className="mt-2 text-sm"><b>Resultado esperado:</b> {r.expected_result}</p>{r.target != null && <p className="mt-2 text-sm"><b>Meta:</b> {r.target} {r.result_unit}</p>}</Panel><Panel title="Trazabilidad de autorización"><p className="text-sm">Registro: {dateLabel(r.created_at)}</p><p className="text-sm">Presentación: {dateLabel(r.submitted_at)}</p><p className="text-sm">Decisión: {dateLabel(r.approved_at)}</p><p className="text-sm">{r.approval_reason}</p><p className="mt-2 text-sm">Validación RR. HH.: {dateLabel(r.validated_at)}</p>{d.needs_exception && <p className="mt-2 text-sm text-amber-800">Revisión de Gerencia: {r.exception_status} {r.exception_note}</p>}</Panel></div>
 <Table headers={['Trabajador', 'Intervalo previsto', 'Solicitadas', 'Aprobadas (min)', 'Trabajadas', 'Validadas', ...(c?.individual_costs ? ['Costo reportado / validado'] : []), 'Consentimiento']}>
 {d.lines.map(l => <tr key={l.id}><td><b>{l.person_name}</b><br /><span className="text-xs">{l.person_code}</span></td><td className="text-xs">{dateLabel(l.planned_start)}<br />{dateLabel(l.planned_end)}</td><td>{hours(l.planned_minutes)}</td><td>{a?.can_approve && !['BORRADOR', 'CANCELADA', 'VALIDADA'].includes(r.state) ? <input aria-label={'Minutos aprobados de ' + l.person_name} className={input} type="number" min={0} max={l.planned_minutes} value={amounts[l.id] ?? 0} onChange={e => setAmounts({ ...amounts, [l.id]: Number(e.target.value) })}/> : hours(l.approved_minutes)}</td><td>{hours(l.actual_minutes)}</td><td>{hours(l.validated_minutes)}</td>{c?.individual_costs && <td>{money(l.reported_cost)} / {money(l.validated_cost)}</td>}<td>{l.consent ? 'Sí' : 'Sin confirmar'}</td></tr>)}</Table>
 {r.attendance_reference && <p className="break-all text-xs text-slate-500">Fuente RR. HH.: {r.attendance_reference}</p>}
 {r.state === 'BORRADOR' && r.created_by === c?.user_id && a?.can_request && <div className="flex flex-wrap gap-2"><button className={secondary} onClick={() => setEditing(true)}>Editar borrador</button><button disabled={busy} className={btn} onClick={() => void act('submit')}>Presentar al jefe del área</button></div>}
 {!['BORRADOR', 'CANCELADA', 'VALIDADA'].includes(r.state) && ((r.created_by === c?.user_id && a?.can_request) || a?.can_approve || a?.can_validate) && <Panel title="Resultado operativo"><div className="grid gap-3"><Field label="Resultado obtenido *"><textarea minLength={10} maxLength={3000} className={input} rows={3} value={result} onChange={e => setResult(e.target.value)}/></Field><Field label="Referencia del sustento / documento"><input maxLength={2000} className={input} value={evidence} onChange={e => setEvidence(e.target.value)}/></Field>{r.target != null && <Field label={'Resultado cuantitativo (' + r.result_unit + ')'}><input className={input} type="number" min={0} step="any" value={achieved} onChange={e => setAchieved(e.target.value)}/></Field>}<button disabled={busy || result.trim().length < 10} className={secondary} onClick={() => void act('result', { result_text: result, evidence, achieved })}>Guardar resultado</button></div></Panel>}
 {r.state === 'VALIDADA' && <Notice>Resultado: {r.result_text} · Evaluación: {r.assessment}. {r.validation_reason}</Notice>}
 {(a?.can_approve || a?.can_validate || a?.can_exception || (r.created_by === c?.user_id && a?.can_request)) && <Field label="Sustento de la decisión (obligatorio para aprobar, rechazar, validar, reabrir o cancelar)"><textarea className={input} maxLength={3000} rows={2} value={reason} onChange={e => setReason(e.target.value)}/></Field>}
 <div className="flex flex-wrap gap-2">
 {a?.can_approve && !['BORRADOR', 'CANCELADA', 'VALIDADA'].includes(r.state) && <><button disabled={busy || reason.trim().length < 10 || r.created_by === c?.user_id} className={btn} onClick={() => void act('decide', { decision: 'APROBADA', lines: d.lines.map(l => ({ id: l.id, approved_minutes: amounts[l.id] })) })}>Aprobar como jefe del área</button><button disabled={busy || reason.trim().length < 10 || r.created_by === c?.user_id} className={secondary} onClick={() => void act('decide', { decision: 'RECHAZADA' })}>Rechazar necesidad prevista</button></>}
 {['BORRADOR', 'SOLICITADA'].includes(r.state) && ((r.created_by === c?.user_id && a?.can_request) || a?.can_approve) && <button disabled={busy || reason.trim().length < 10} className={secondary} onClick={() => void act('cancel')}>Cancelar solicitud</button>}
 {a?.can_validate && r.state === 'VALIDADA' && <button disabled={busy || reason.trim().length < 15} className={secondary} onClick={() => void act('reopen')}>Reabrir para corregir RR. HH.</button>}
 </div>
 {a?.can_validate && r.state === 'EJECUTADA' && <Panel title="Validación RR. HH."><div className="grid gap-3 sm:grid-cols-3"><Field label="Causa confirmada"><select className={input} value={cause} onChange={e => setCause(e.target.value)}>{c?.causes.filter(x => x.active).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field><Field label="Evaluación de necesidad"><select className={input} value={assessment} onChange={e => setAssessment(e.target.value)}><option value="JUSTIFICADA">Necesaria / justificada</option><option value="MEJORABLE">Mejorable con planificación</option><option value="PENDIENTE">Por determinar</option></select></Field><button disabled={busy || reason.trim().length < 10 || !r.result_text} className={btn} onClick={() => void act('validate', { confirmed_cause_id: cause, assessment })}>Validar ejecución y costos reportados</button></div><p className="mt-2 text-xs text-slate-500">Los costos vacíos permanecerán pendientes de valorización. Se exige la asistencia de todos los trabajadores incluidos.</p></Panel>}
 {d.needs_exception && a?.can_exception && <Panel title="Revisión independiente de Gerencia"><div className="flex flex-wrap gap-2"><button disabled={busy || reason.trim().length < 15 || r.created_by === c?.user_id} className={btn} onClick={() => void act('exception', { decision: 'APROBADA' })}>Aprobar excepción</button><button disabled={busy || reason.trim().length < 15 || r.created_by === c?.user_id} className={secondary} onClick={() => void act('exception', { decision: 'OBSERVADA' })}>Observar excepción</button></div></Panel>}
 <Panel title="Historial de cambios · últimos 100 eventos"><ol className="grid gap-2 text-xs">{d.audit.map(x => <li key={x.id}><b>{dateLabel(x.created_at)} · {x.event}</b><p>{x.actor_name}</p><p>{x.reason}</p></li>)}</ol></Panel>
 </>}</div>}</Modal>;
}
