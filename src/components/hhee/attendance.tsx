'use client';
import { useState } from 'react';
import { attendanceTemplate, parseAttendance } from '@/lib/hhee/import';
import type { AttendancePreview, AttendanceRow } from '@/lib/hhee/types';
import { hours, money } from '@/lib/hhee/core';
import { rpc, useHhee } from './provider';
import { btn, Field, input, Notice, Panel, secondary, Shell, Table } from './ui';
import { Requests } from './requests';
type FileData = {
    rows: AttendanceRow[];
    file_name: string;
    file_hash: string;
    operation_id: string;
    correction_reason: string;
    refresh_rates: boolean;
};
export function Attendance() {
    const { context: c, refresh } = useHhee(), [source, setSource] = useState<FileData | null>(null), [preview, setPreview] = useState<AttendancePreview | null>(null), [error, setError] = useState(''), [busy, setBusy] = useState(false), [reason, setReason] = useState(''), [refreshRates, setRefreshRates] = useState(false);
    const inspect = async (file: File) => { setBusy(true); setError(''); setPreview(null); setSource(null); try {
        const parsed = await parseAttendance(file), s = { ...parsed, operation_id: crypto.randomUUID(), correction_reason: reason, refresh_rates: refreshRates }, p = await rpc<AttendancePreview>('hhee_attendance', { p: s, p_apply: false });
        setSource({ ...s, rows: s.rows.map((r, i) => ({ ...r, version: p.rows.find(x => x.row === i + 2)?.version })) });
        setPreview(p);
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo leer el archivo.');
    }
    finally {
        setBusy(false);
    } };
    const apply = async () => { if (!source)
        return; setBusy(true); setError(''); try {
        const p = await rpc<AttendancePreview>('hhee_attendance', { p: source, p_apply: true });
        setPreview(p);
        if (p.applied)
            await refresh();
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo importar.');
    }
    finally {
        setBusy(false);
    } };
    return <><Shell title="Asistencia y costos · RR. HH." description="Importación controlada de HHEE efectivas. El archivo se valida completo antes de aplicar cambios.">
 {!c?.areas.some(a => a.can_validate) ? <Notice error>Se requiere permiso de validación RR. HH. y asignación de área.</Notice> : <>
 <Panel title="Importar Excel de asistencia y costos"><div className="grid gap-4">
 <Notice>Importe los intervalos de HHEE y su desglose 25%, 35% y 100%. Las horas normales son opcionales y se registran una sola vez por trabajador y día, separadas de las HHEE. El costo aproximado se calcula desde los conceptos de la ficha del trabajador; no ingrese costos en esta plantilla.</Notice>
 <div><button className={secondary} onClick={attendanceTemplate}>Descargar plantilla Excel</button></div>
 <Field label="Motivo de corrección (solo si modifica asistencia ya importada; mínimo 15 caracteres)"><textarea className={input} value={reason} onChange={e => { setReason(e.target.value); setSource(null); setPreview(null); }} rows={2}/></Field>
 <label className="flex items-start gap-2 text-sm"><input type="checkbox" checked={refreshRates} onChange={e => { setRefreshRates(e.target.checked); setSource(null); setPreview(null); }}/>Actualizar la tarifa desde la ficha remunerativa vigente al corregir un registro. Requiere motivo y reapertura si ya fue validado.</label>
 <Field label="Excel RR. HH. · máximo 10 MB / 500 filas"><input disabled={busy} className={input} type="file" accept=".xlsx,.xls" onChange={e => { if (e.target.files?.[0])
            void inspect(e.target.files[0]); e.target.value = ''; }}/></Field>
 {busy && <p role="status">Validando asistencia…</p>}{error && <Notice error>{error}</Notice>}
 {preview && <><p className="break-all text-xs text-slate-500">{source?.file_name} · SHA256 {source?.file_hash}</p>
 {preview.applied ? <Notice>Importación aplicada. {preview.changed} filas actualizadas. La ejecución queda pendiente de validación RR. HH.</Notice> : <Notice>{preview.rows.length} filas válidas · {preview.errors.length} errores. Los registros repetidos sin cambios no se duplican.</Notice>}
 {preview.errors.map(e => <Notice error key={e.row}>Fila {e.row}: {e.error}</Notice>)}
 <Table headers={['Fila / Solicitud', 'Trabajador', 'Solicitadas', 'Aprobadas', 'Trabajadas', 'Reconocidas', 'Normal / 25% / 35% / 100%', 'Costo aprox. HHEE', 'Control']}>{preview.rows.map(r => <tr key={r.row}><td>{r.row} · {r.request_code}</td><td>{r.person_code} · {r.person_name}</td><td>{hours(r.planned)}</td><td>{hours(r.approved)}</td><td>{hours(r.actual)}</td><td>{hours(r.recognized)}</td><td className="min-w-40 text-xs">Normal: {hours(r.normal_minutes)}<br />25%: {hours(r.minutes_25)} · 35%: {hours(r.minutes_35)}<br />100%: {hours(r.minutes_100)}</td><td>{money(r.cost)}<p className="mt-1 text-xs text-slate-500">{r.cost_source === "TARIFA_BASE" ? "Ficha remunerativa" : r.cost_source === "RRHH_APROX" ? "Estimación RR. HH. sin desglose" : "Ficha incompleta / pendiente"}</p></td><td className="max-w-xs text-xs">{r.duplicate ? 'Ya registrada, sin cambios' : r.warning || 'Sin alertas'}</td></tr>)}</Table>
 {!preview.applied && <button disabled={busy || preview.errors.length > 0 || !preview.rows.length} className={btn} onClick={() => void apply()}>Confirmar importación completa</button>}
 </>}
 </div></Panel><Notice>Después de importar, revise cada ejecución, confirme su causa y resultado y valide los datos. Una observación gerencial no elimina horas efectivamente trabajadas.</Notice>
 </>}
 </Shell><Requests validation embedded/></>;
}
