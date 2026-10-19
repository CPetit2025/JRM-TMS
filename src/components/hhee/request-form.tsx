'use client';
import { useEffect, useState, type FormEvent } from 'react';
import { rpc, useHhee } from './provider';
import { Field, input, btn, secondary, Notice, Table } from './ui';
import { limaDate, localInput } from '@/lib/hhee/core';
export function RequestForm({ onDone, initial }: {
    onDone: (id: string) => void;
    initial?: import('@/lib/hhee/types').Detail;
}) {
    const { context: c, mutate } = useHhee(), [error, setError] = useState(''), [busy, setBusy] = useState(false);
    const areas = c!.areas.filter(a => a.can_request && a.active);
    const [requestId] = useState(() => initial?.request.id || crypto.randomUUID());
    const r = initial?.request;
    const [form, setForm] = useState(r ? { area_id: r.area_id, cause_id: r.cause_id, origin_area_id: r.origin_area_id || '', work_date: r.work_date, activity: r.activity, justification: r.justification, alternatives: r.alternatives, expected_result: r.expected_result, result_unit: r.result_unit || '', target: r.target == null ? '' : String(r.target), reference_type: r.reference_type, reference_code: r.reference_code || '', emergency: r.emergency, emergency_reason: r.emergency_reason || '' } : { area_id: areas[0]?.id || '', cause_id: c!.causes.find(a => a.active)?.id || '', origin_area_id: '', work_date: limaDate(), activity: '', justification: '', alternatives: '', expected_result: '', result_unit: '', target: '', reference_type: 'SIN_REFERENCIA', reference_code: '', emergency: false, emergency_reason: '' });
    const [lines, setLines] = useState<{
        person_id: string;
        planned_start: string;
        planned_end: string;
        planned_break: number;
    }[]>(initial?.lines.map(l => ({ person_id: l.person_id, planned_start: localInput(l.planned_start), planned_end: localInput(l.planned_end), planned_break: l.planned_break })) || []);
    const [ots, setOts] = useState<{
        id: string;
        code: string;
    }[]>([]);
    useEffect(() => {
        let active = true;
        if (form.reference_type !== 'OT' || form.reference_code.trim().length < 2)
            return;
        const timer = setTimeout(() => { rpc<{
            rows: {
                id: string;
                code: string;
            }[];
        }>('hhee_reference_search', { p_area: form.area_id, p_q: form.reference_code }).then(v => { if (active)
            setOts(v.rows); }).catch(() => { if (active)
            setOts([]); }); }, 300);
        return () => { active = false; clearTimeout(timer); };
    }, [form.reference_type, form.reference_code, form.area_id]);
    const set = (k: string, v: string | boolean) => setForm({ ...form, [k]: v });
    const submit = async (e: FormEvent) => { e.preventDefault(); setBusy(true); setError(''); try {
        const id = requestId;
        await mutate({ action: 'save_request', id, version: initial?.request.version, ...form, lines });
        onDone(id);
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo guardar.');
    }
    finally {
        setBusy(false);
    } };
    const text = (k: keyof typeof form, label: string, min: number, max: number) => <Field label={label}><textarea className={input} required minLength={min} maxLength={max} value={String(form[k])} onChange={e => set(k, e.target.value)} rows={2}/></Field>;
    return <form onSubmit={submit} className="grid gap-4">{error && <Notice error>{error}</Notice>}
 <div className="grid gap-3 sm:grid-cols-3"><Field label="Área ejecutora *"><select required className={input} value={form.area_id} onChange={e => { set('area_id', e.target.value); setLines([]); }}>{areas.map(a => <option key={a.id} value={a.id}>{a.name} · {a.site_name}</option>)}</select></Field><Field label="Fecha operativa *"><input required className={input} type="date" value={form.work_date} onChange={e => { set('work_date', e.target.value); setLines(lines.map(l => ({ ...l, planned_start: e.target.value + l.planned_start.slice(10), planned_end: e.target.value + l.planned_end.slice(10) }))); }}/></Field><Field label="Causa propuesta *"><select className={input} required value={form.cause_id} onChange={e => set('cause_id', e.target.value)}>{c!.causes.filter(a => a.active).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field></div>
 <Field label="Área que originó la necesidad (si se conoce)"><select className={input} value={form.origin_area_id} onChange={e => set('origin_area_id', e.target.value)}><option value="">Por determinar</option>{c!.areas.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field>
 {text('activity', 'Trabajo a realizar *', 5, 300)}{text('justification', '¿Por qué no puede ejecutarse dentro de la jornada ordinaria? *', 10, 3000)}{text('alternatives', 'Alternativas evaluadas antes de solicitar HHEE *', 5, 2000)}{text('expected_result', 'Resultado esperado *', 5, 1000)}
 <div className="grid gap-3 sm:grid-cols-4"><Field label="Documento de referencia"><select className={input} value={form.reference_type} onChange={e => set('reference_type', e.target.value)}>{['SIN_REFERENCIA', 'OT', 'OC', 'OS', 'RQ', 'MANTENIMIENTO'].map(t => <option key={t}>{t}</option>)}</select></Field><Field label="Código de referencia"><input className={input} required={form.reference_type !== 'SIN_REFERENCIA'} disabled={form.reference_type === 'SIN_REFERENCIA'} list={form.reference_type === 'OT' ? 'hhee-ot-options' : undefined} maxLength={100} value={form.reference_code} onChange={e => set('reference_code', e.target.value)}/></Field><datalist id="hhee-ot-options">{ots.map(o => <option key={o.id} value={o.code}/>)}</datalist><Field label="Meta cuantitativa (opcional)"><input className={input} type="number" min="0.0001" step="any" value={form.target} onChange={e => set('target', e.target.value)}/></Field><Field label="Unidad de la meta"><input className={input} maxLength={80} placeholder="TN, despachos, equipos…" required={!!form.target} value={form.result_unit} onChange={e => set('result_unit', e.target.value)}/></Field></div>
 <label className="flex gap-2 text-sm"><input type="checkbox" checked={form.emergency} onChange={e => set('emergency', e.target.checked)}/>Solicitud de emergencia (requiere revisión gerencial)</label>{form.emergency && text('emergency_reason', 'Sustento de emergencia *', 10, 2000)}
 <div className="flex flex-wrap items-center justify-between gap-3"><h3 className="font-bold">Personal e intervalos de HHEE · hora de Lima</h3><button type="button" className={secondary} onClick={() => setLines([...lines, { person_id: '', planned_start: form.work_date + 'T18:00', planned_end: form.work_date + 'T20:00', planned_break: 0 }])}>+ Agregar trabajador</button></div>
 <Table headers={['Trabajador', 'Inicio', 'Fin', 'Descanso (min)', 'Acción']}>{lines.map((l, i) => <tr key={i}><td><select aria-label={'Trabajador '+(i+1)} required className={input} value={l.person_id} onChange={e => setLines(lines.map((x, j) => i === j ? { ...x, person_id: e.target.value } : x))}><option value="">Seleccionar</option>{c!.people.filter(p => p.area_id === form.area_id && p.active).map(p => <option key={p.id} value={p.id}>{p.code} · {p.name}</option>)}</select></td>{(['planned_start', 'planned_end'] as const).map(k => <td key={k}><input aria-label={(k==='planned_start'?'Inicio':'Fin')+' de HHEE del trabajador '+(i+1)} className={input} required type="datetime-local" value={l[k]} onChange={e => setLines(lines.map((x, j) => i === j ? { ...x, [k]: e.target.value } : x))}/></td>)}<td><input aria-label="Descanso en minutos" required className={input} type="number" min={0} max={959} value={l.planned_break} onChange={e => setLines(lines.map((x, j) => i === j ? { ...x, planned_break: Number(e.target.value) } : x))}/></td><td><button type="button" className="text-red-700 underline" onClick={() => setLines(lines.filter((_, j) => j !== i))}>Quitar</button></td></tr>)}</Table>
 {!c!.people.some(p => p.area_id === form.area_id && p.active) && <Notice>Configure el directorio de trabajadores del área antes de crear la solicitud.</Notice>}
 <p className="text-xs text-slate-500">Se guardará como borrador. Revise el detalle y pulse «Presentar al jefe del área». Máximo 16 h por intervalo; este límite técnico no determina una jornada legal permitida.</p>
 <button className={btn} disabled={busy || !lines.length}>{busy ? 'Guardando…' : 'Guardar y revisar solicitud'}</button></form>;
}
