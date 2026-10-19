'use client';
import { useState, type FormEvent } from 'react';
import * as XLSX from 'xlsx';
import { useHhee } from './provider';
import { parseDirectory } from '@/lib/hhee/import';
import { money } from '@/lib/hhee/core';
import type { Person } from '@/lib/hhee/types';
import { PersonForm } from './person-form';
import { btn, Field, input, Notice, Panel, secondary, Shell, Table } from './ui';
export function Settings() {
    const { context: c, mutate } = useHhee(), [error, setError] = useState(''), [ok, setOk] = useState(''), [busy, setBusy] = useState(false);
    const [editing, setEditing] = useState<Person | 'new' | null>(null);
    const [peopleRows, setPeopleRows] = useState<Record<string, unknown>[] | null>(null);
    const run = async (p: Record<string, unknown>) => { setBusy(true); setError(''); setOk(''); try {
        await mutate(p);
        setOk('Configuración guardada.');
        if (p.action === 'people_import')
            setPeopleRows(null);
        return true;
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo guardar.');
        return false;
    }
    finally {
        setBusy(false);
    } };
    const form = (action: string, e: FormEvent<HTMLFormElement>) => { e.preventDefault(); void run({ action, ...Object.fromEntries(new FormData(e.currentTarget)) }); };
    const parse = async (file: File) => {
        setError('');
        setPeopleRows(null);
        try {
            setPeopleRows(await parseDirectory(file, c!.areas));
        }
        catch (e) {
            setError(e instanceof Error ? e.message : 'Archivo inválido.');
        }
    };
    const template = () => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['CODIGO', 'NOMBRE', 'AREA_ID', 'HORAS_MES', 'CONCEPTO', 'MONTO_MENSUAL', 'COMPUTABLE']]), 'Personal'); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(c!.areas.filter(a => a.module_enabled).map(a => ({ AREA_ID: a.id, AREA: a.name, SEDE: a.site_name }))), 'Áreas'); XLSX.writeFile(wb, 'JRM_HHEE_Directorio.xlsx'); };
    return <Shell title="Configuración del piloto HHEE" description="Piloto de Distribución. Habilitación del módulo, fichas remunerativas y permisos por área.">
 {!c?.config ? <Notice error>Se requiere permiso de configuración HHEE.</Notice> : <>
 <Notice>Activación: 1. Mantenga habilitada solo Distribución durante el piloto. 2. Asigne los permisos HHEE en Roles y Permisos. 3. Vincule aquí cada usuario, incluida Gerencia, con su área habilitada. El jefe del área aprueba; Gerencia revisa excepciones; RR. HH. importa y valida la ejecución.</Notice>
 {error && <Notice error>{error}</Notice>}{ok && <Notice>{ok}</Notice>}
 <div className="grid gap-4 xl:grid-cols-2">
 <Panel title="Alcance del módulo por sede"><form onSubmit={e => form('area', e)} className="grid gap-3"><Field label="Sede"><select className={input} name="site_id" required>{c.sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field><Field label="Nombre del área"><input className={input} name="name" required minLength={2} maxLength={100}/></Field><label className="flex gap-2 text-sm"><input type="checkbox" name="module_enabled" value="true"/>Habilitar esta área para HHEE</label><button disabled={busy} className={btn}>Crear área</button></form><ul className="mt-3 grid gap-2 text-sm">{c.areas.map(a => <li key={a.id} className="flex flex-wrap justify-between gap-2"><span>{a.name} · {a.site_name} · {a.active ? 'Activa' : 'Inactiva'} · HHEE {a.module_enabled ? 'habilitado' : 'deshabilitado'}</span><div className="flex gap-3"><button className="text-blue-700 underline" disabled={busy} onClick={() => void run({ action: 'area', id: a.id, site_id: a.site_id, name: a.name, active: a.active, module_enabled: !a.module_enabled })}>{a.module_enabled ? 'Deshabilitar HHEE' : 'Habilitar HHEE'}</button><button className="text-blue-700 underline" disabled={busy} onClick={() => void run({ action: 'area', id: a.id, site_id: a.site_id, name: a.name, active: !a.active })}>{a.active ? 'Desactivar área' : 'Activar área'}</button></div></li>)}</ul></Panel>
 <Panel title="Usuarios autorizados por área"><p className="mb-3 text-sm text-slate-600">El permiso del rol, la sede autorizada y esta vinculación son necesarios. Gerencia también debe estar vinculada. El administrador gestiona el alcance desde aquí.</p><a className="mb-3 inline-block text-sm text-blue-700 underline" href="/permisos">Abrir Roles y Permisos</a><form className="grid gap-3" onSubmit={e => form('membership', e)}><Field label="Usuario"><select required className={input} name="user_id">{c.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field><Field label="Área"><select required className={input} name="area_id">{c.areas.filter(a => a.module_enabled).map(a => <option key={a.id} value={a.id}>{a.name} · {a.site_name}</option>)}</select></Field><input type="hidden" name="enabled" value="true"/><button disabled={busy} className={btn}>Vincular usuario al área</button></form><ul className="mt-3 grid gap-2 text-xs">{c.memberships.map(m => <li key={m.user_id + m.area_id} className="flex justify-between gap-2">{c.users.find(u => u.id === m.user_id)?.name} · {c.areas.find(a => a.id === m.area_id)?.name}<button disabled={busy} className="text-red-700 underline" onClick={() => void run({ action: 'membership', ...m, enabled: false })}>Quitar</button></li>)}</ul></Panel>
 </div>
 <Panel title="Fichas remunerativas de trabajadores"><div className="grid gap-4"><Notice>El costo es aproximado y se calcula desde los conceptos mensuales computables de cada trabajador, divididos entre sus horas mensuales de referencia. No se interpreta la antigua tarifa integral como remuneración base. Las horas normales se muestran aparte de las HHEE.</Notice>
 <div className="flex flex-wrap gap-3"><button className={btn} disabled={busy} onClick={() => setEditing('new')}>+ Registrar trabajador</button><button className={secondary} onClick={template}>Plantilla de fichas remunerativas</button><Field label="Importar fichas Excel (una fila por concepto)"><input className={input} type="file" accept=".xlsx,.xls" disabled={busy} onChange={e => { if (e.target.files?.[0]) void parse(e.target.files[0]); e.target.value = ''; }}/></Field></div>
 {editing && <PersonForm key={typeof editing === 'string' ? editing : editing.id} person={typeof editing === 'string' ? undefined : editing} areas={c.areas.filter(a => a.module_enabled && a.active)} busy={busy} onCancel={() => setEditing(null)} onSave={async p => { if (await run(p)) setEditing(null); }}/>}
 {peopleRows && <><Notice>{peopleRows.length} trabajadores. Se reemplazarán los conceptos de las fichas incluidas por los del archivo; los cálculos históricos conservarán sus tarifas.</Notice><Table headers={['Código', 'Nombre', 'Área', 'Conceptos mensuales', 'Horas de referencia']}>{peopleRows.map(r => <tr key={String(r.code)}><td>{String(r.code)}</td><td>{String(r.name)}</td><td>{c.areas.find(a => a.id === r.area_id)?.name}</td><td>{(r.remuneration_concepts as { name: string; amount: number; computable: boolean }[]).map(v => <p key={v.name}>{v.name}: {money(v.amount)} · {v.computable ? 'Computable' : 'Excluido'}</p>)}</td><td>{String(r.monthly_hours)}</td></tr>)}</Table><button disabled={busy} className={btn} onClick={() => void run({ action: 'people_import', rows: peopleRows })}>Confirmar fichas remunerativas</button></>}
 <Table headers={['Código', 'Trabajador', 'Área', 'Tarifa base aprox. / h', 'Estado', 'Acciones']}>{c.people.map(p => <tr key={p.id}><td>{p.code}</td><td>{p.name}</td><td>{c.areas.find(a => a.id === p.area_id)?.name}</td><td>{money(p.base_hour_cost)}</td><td>{p.active ? 'Activo' : 'Inactivo'}</td><td><div className="flex gap-3"><button className="text-blue-700 underline" disabled={busy} onClick={() => setEditing(p)}>Editar ficha</button><button className="text-blue-700 underline" disabled={busy} onClick={() => void run({ action: 'person', code: p.code, name: p.name, area_id: p.area_id, active: !p.active })}>{p.active ? 'Desactivar' : 'Activar'}</button></div></td></tr>)}</Table></div></Panel>
 <Panel title="Recurrencia e informe semanal"><form className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" onSubmit={e => form('settings', e)}>
 <Field label="Ventana de recurrencia (días)"><input required className={input} name="recurrence_days" type="number" min={7} max={180} defaultValue={c.settings.recurrence_days}/></Field><Field label="Mínimo de eventos área + causa"><input required className={input} name="recurrence_events" type="number" min={2} max={30} defaultValue={c.settings.recurrence_events}/></Field><Field label="Día sugerido del informe"><select className={input} name="report_day" defaultValue={c.settings.report_day}>{['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'].map((v, i) => <option key={v} value={i + 1}>{v}</option>)}</select></Field>
 <Field label="Hora de corte sugerida · Lima"><input className={input} name="report_time" type="time" required defaultValue={c.settings.report_time.slice(0, 5)}/></Field><Field label="Destinatarios gerenciales"><input className={input} name="report_to" maxLength={1000} defaultValue={c.settings.report_to}/></Field><Field label="Copia"><input className={input} name="report_cc" maxLength={1000} defaultValue={c.settings.report_cc}/></Field><button disabled={busy} className={btn}>Guardar criterios del piloto</button></form><p className="mt-3 text-xs text-slate-500">El informe se prepara y comparte manualmente desde «Informe gerencial». Este horario no configura un envío automático de correo.</p></Panel>
 </>}
 </Shell>;
}
