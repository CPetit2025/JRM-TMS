'use client';
import { useState, type FormEvent } from 'react';
import { Modal } from '@/components/ui/modal';
import { useHhee } from './provider';
import { useData } from './data';
import { initialFilters, limaDate, dateLabel } from '@/lib/hhee/core';
import type { Action } from '@/lib/hhee/types';
import { Badge, btn, Field, FilterBar, input, Notice, Panel, secondary, Shell, Table } from './ui';
export function Actions() {
    const { context: c, mutate } = useHhee(), [filters, setFilters] = useState(initialFilters), { data: d, error } = useData(filters), [open, setOpen] = useState(false), [item, setItem] = useState<Action | null>(null), [busy, setBusy] = useState(false), [msg, setMsg] = useState(''), [reason, setReason] = useState(''), [state, setState] = useState('EN_CURSO'), [effective, setEffective] = useState('true');
    const areas = c?.areas.filter(a => a.can_approve || a.can_validate) || [];
    const [area, setArea] = useState(''), [title, setTitle] = useState(''), [assigned, setAssigned] = useState(''), [due, setDue] = useState(limaDate()), [cause, setCause] = useState('');
    const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setMsg(''); try {
        await mutate(item ? { action: 'action_update', id: item.id, version: item.version, state, reason, effective: effective === 'true' } : { action: 'action_save', area_id: area || areas[0]?.id, cause_id: cause || c?.causes[0]?.id, title, assigned_to: assigned, due_date: due });
        setItem(null);
        setOpen(false);
        setReason('');
        setTitle('');
    }
    catch (e) {
        setMsg(e instanceof Error ? e.message : 'Error al guardar.');
    }
    finally {
        setBusy(false);
    } };
    return <Shell title="Acciones correctivas" description="Responsables, plazos y verificación de efectividad para resolver las causas operativas."><FilterBar value={filters} onChange={setFilters}/>{error && <Notice error>{error}</Notice>}
 {d && d.actions_total > d.actions.length && <Notice>Se muestran {d.actions.length} acciones de {d.actions_total}. Acote área, causa o período.</Notice>}<Panel title="Compromisos de mejora"><div className="mb-4 flex flex-wrap justify-between gap-2"><p className="text-xs text-slate-500">Incluye acciones abiertas del alcance, aunque su vencimiento esté fuera del período.</p>{areas.length > 0 && <button className={btn} onClick={() => { setItem(null); setMsg(''); setOpen(true); }}>+ Nueva acción</button>}</div><Table headers={['Área / Causa', 'Acción', 'Responsable', 'Vencimiento', 'Estado', 'Acciones']}>{d?.actions.map(a => <tr key={a.id}><td>{a.area_name}<p className="text-xs">{a.cause_name}</p></td><td className="max-w-sm">{a.title}</td><td>{a.assigned_name}</td><td className={a.due_date < limaDate() && !['REALIZADA', 'VERIFICADA'].includes(a.state) ? 'font-bold text-red-700' : ''}>{dateLabel(a.due_date)}</td><td><Badge value={a.state}/>{a.effective != null && <p>{a.effective ? 'Efectiva' : 'Requiere nueva medida'}</p>}</td><td><button className={secondary} onClick={() => { setItem(a); setState(a.state === 'REALIZADA' ? 'VERIFICADA' : 'EN_CURSO'); setReason(a.conclusion || ''); setMsg(''); setOpen(true); }}>Ver / actualizar</button></td></tr>)}{!d?.actions.length && <tr><td colSpan={6}>No hay acciones registradas.</td></tr>}</Table></Panel>
 <Modal isOpen={open} onClose={() => setOpen(false)} title={item ? 'Actualizar acción correctiva' : 'Nueva acción correctiva'} maxWidth="max-w-2xl"><form className="grid gap-4" onSubmit={submit}>{msg && <Notice error>{msg}</Notice>}
 {item ? <><p>{item.title}</p><Field label="Estado"><select className={input} value={state} onChange={e => setState(e.target.value)}><option value="EN_CURSO">En curso</option><option value="REALIZADA">Realizada (pendiente de verificar)</option><option value="VERIFICADA">Verificar por otro responsable</option></select></Field><Field label="Avance / conclusión / sustento de verificación"><textarea required minLength={10} className={input} value={reason} onChange={e => setReason(e.target.value)}/></Field>{state === 'VERIFICADA' && <Field label="Efectividad"><select className={input} value={effective} onChange={e => setEffective(e.target.value)}><option value="true">Efectiva</option><option value="false">No efectiva: requiere nueva medida</option></select></Field>}</> : <>
 <Field label="Área"><select className={input} required value={area || areas[0]?.id || ''} onChange={e => setArea(e.target.value)}>{areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
 <Field label="Causa"><select className={input} value={cause || c?.causes[0]?.id} onChange={e => setCause(e.target.value)}>{c?.causes.filter(x => x.active).map(x => <option key={x.id} value={x.id}>{x.name}</option>)}</select></Field>
 <Field label="Medida correctiva *"><textarea required minLength={5} maxLength={300} className={input} value={title} onChange={e => setTitle(e.target.value)}/></Field>
 <Field label="Responsable (debe estar asignado al área)"><select required className={input} value={assigned} onChange={e => setAssigned(e.target.value)}><option value="">Seleccionar</option>{c?.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field>
 <Field label="Fecha compromiso *"><input required className={input} type="date" value={due} onChange={e => setDue(e.target.value)}/></Field>
 </>}<button className={btn} disabled={busy || item?.state === 'VERIFICADA'}>{busy ? 'Guardando…' : 'Guardar acción'}</button></form></Modal></Shell>;
}
