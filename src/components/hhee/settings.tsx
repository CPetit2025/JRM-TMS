'use client';
import { useState, type FormEvent } from 'react';
import * as XLSX from 'xlsx';
import { useHhee } from './provider';
import { decimal } from '@/lib/hhee/import';
import { btn, Field, input, Notice, Panel, secondary, Shell, Table } from './ui';
export function Settings() {
    const { context: c, mutate } = useHhee(), [error, setError] = useState(''), [ok, setOk] = useState(''), [busy, setBusy] = useState(false);
    const [peopleRows, setPeopleRows] = useState<Record<string, unknown>[] | null>(null);
    const run = async (p: Record<string, unknown>) => { setBusy(true); setError(''); setOk(''); try {
        await mutate(p);
        setOk('Configuración guardada.');
        if (p.action === 'people_import')
            setPeopleRows(null);
    }
    catch (e) {
        setError(e instanceof Error ? e.message : 'No se pudo guardar.');
    }
    finally {
        setBusy(false);
    } };
    const form = (action: string, e: FormEvent<HTMLFormElement>) => { e.preventDefault(); void run({ action, ...Object.fromEntries(new FormData(e.currentTarget)) }); };
    const parse = async (file: File) => {
        setError('');
        setPeopleRows(null);
        try {
            if (!/\.xlsx?$/i.test(file.name) || file.size > 5 * 1024 * 1024)
                throw Error('Excel de hasta 5 MB.');
            const wb = XLSX.read(await file.arrayBuffer()), rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(wb.Sheets[wb.SheetNames[0]], { defval: '' });
            if (!rows.length || rows.length > 300)
                throw Error('Entre 1 y 300 trabajadores.');
            const seen = new Set<string>();
            setPeopleRows(rows.map((r, i) => {
                const code = String(r.CODIGO ?? '').trim().toUpperCase(), name = String(r.NOMBRE ?? '').trim(), area = c!.areas.find(a => a.id === String(r.AREA_ID).trim());
                if (!code || name.length < 3 || !area || seen.has(code))
                    throw Error('Fila ' + (i + 2) + ': revise código único, nombre y AREA_ID.');
                seen.add(code);
                return { code, name, area_id: area.id, estimated_hour_cost: decimal(r.COSTO_HORA_HHEE, true) };
            }));
        }
        catch (e) {
            setError(e instanceof Error ? e.message : 'Archivo inválido.');
        }
    };
    const template = () => { const wb = XLSX.utils.book_new(); XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['CODIGO', 'NOMBRE', 'AREA_ID', 'COSTO_HORA_HHEE']]), 'Personal'); XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(c!.areas.map(a => ({ AREA_ID: a.id, AREA: a.name, SEDE: a.site_name }))), 'Áreas'); XLSX.writeFile(wb, 'JRM_HHEE_Directorio.xlsx'); };
    return <Shell title="Configuración del piloto HHEE" description="Áreas, trabajadores y alcances. No se crean permisos automáticamente para otros roles.">
 {!c?.config ? <Notice error>Se requiere permiso de configuración HHEE.</Notice> : <>
 <Notice>Activación: 1. Configure las áreas y trabajadores. 2. Asigne permisos HHEE en Roles y Permisos. 3. Vincule cada usuario con sus áreas aquí. El jefe del área aprueba; Gerencia revisa excepciones; RR. HH. importa y valida la ejecución.</Notice>
 {error && <Notice error>{error}</Notice>}{ok && <Notice>{ok}</Notice>}
 <div className="grid gap-4 xl:grid-cols-2">
 <Panel title="Áreas por sede"><form onSubmit={e => form('area', e)} className="grid gap-3"><Field label="Sede"><select className={input} name="site_id" required>{c.sites.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></Field><Field label="Nombre del área"><input className={input} name="name" required minLength={2} maxLength={100}/></Field><button disabled={busy} className={btn}>Crear área</button></form><ul className="mt-3 grid gap-2 text-sm">{c.areas.map(a => <li key={a.id} className="flex flex-wrap justify-between gap-2"><span>{a.name} · {a.site_name} · {a.active ? 'Activa' : 'Inactiva'}</span><button className="text-blue-700 underline" disabled={busy} onClick={() => void run({ action: 'area', id: a.id, site_id: a.site_id, name: a.name, active: !a.active })}>{a.active ? 'Desactivar' : 'Activar'}</button></li>)}</ul></Panel>
 <Panel title="Usuarios autorizados por área"><form className="grid gap-3" onSubmit={e => form('membership', e)}><Field label="Usuario"><select required className={input} name="user_id">{c.users.map(u => <option key={u.id} value={u.id}>{u.name}</option>)}</select></Field><Field label="Área"><select required className={input} name="area_id">{c.areas.map(a => <option key={a.id} value={a.id}>{a.name} · {a.site_name}</option>)}</select></Field><input type="hidden" name="enabled" value="true"/><button disabled={busy} className={btn}>Vincular usuario al área</button></form><ul className="mt-3 grid gap-2 text-xs">{c.memberships.map(m => <li key={m.user_id + m.area_id} className="flex justify-between gap-2">{c.users.find(u => u.id === m.user_id)?.name} · {c.areas.find(a => a.id === m.area_id)?.name}<button disabled={busy} className="text-red-700 underline" onClick={() => void run({ action: 'membership', ...m, enabled: false })}>Quitar</button></li>)}</ul></Panel>
 </div>
 <Panel title="Directorio de trabajadores"><div className="grid gap-4"><Notice>El costo por hora es una estimación integral de HHEE definida por RR. HH.; no ingrese la remuneración básica. Puede dejarlo vacío. El reporte utiliza el costo efectivo validado del Excel, no esta estimación.</Notice>
 <form className="grid gap-3 md:grid-cols-5" onSubmit={e => form('person', e)}><Field label="Código *"><input name="code" className={input} required maxLength={50}/></Field><Field label="Nombre completo *"><input name="name" className={input} required minLength={3} maxLength={160}/></Field><Field label="Área *"><select name="area_id" className={input}>{c.areas.filter(a => a.active).map(a => <option key={a.id} value={a.id}>{a.name}</option>)}</select></Field><Field label="Costo estimado por HHEE"><input name="estimated_hour_cost" type="number" min={0} step="0.0001" className={input}/></Field><button disabled={busy} className={btn}>Guardar por código</button></form>
 <div className="flex flex-wrap gap-3"><button className={secondary} onClick={template}>Plantilla de directorio</button><Field label="Importar directorio Excel (vista previa)"><input className={input} type="file" accept=".xlsx,.xls" disabled={busy} onChange={e => { if (e.target.files?.[0])
            void parse(e.target.files[0]); e.target.value = ''; }}/></Field></div>
 {peopleRows && <><Notice>{peopleRows.length} trabajadores. Los códigos existentes se actualizarán, incluyendo el área y el costo estimado del archivo. Los nuevos se crearán.</Notice><Table headers={['Código', 'Nombre', 'Área', 'Costo estimado / hora']}>{peopleRows.map(r => <tr key={String(r.code)}><td>{String(r.code)}</td><td>{String(r.name)}</td><td>{c.areas.find(a => a.id === r.area_id)?.name}</td><td>{r.estimated_hour_cost == null ? 'Pendiente' : String(r.estimated_hour_cost)}</td></tr>)}</Table><button disabled={busy} className={btn} onClick={() => void run({ action: 'people_import', rows: peopleRows })}>Confirmar directorio</button></>}
 <Table headers={['Código', 'Trabajador', 'Área', 'Estado', 'Acción']}>{c.people.map(p => <tr key={p.id}><td>{p.code}</td><td>{p.name}</td><td>{c.areas.find(a => a.id === p.area_id)?.name}</td><td>{p.active ? 'Activo' : 'Inactivo'}</td><td><button className="text-blue-700 underline" disabled={busy} onClick={() => void run({ action: 'person', code: p.code, name: p.name, area_id: p.area_id, estimated_hour_cost: p.estimated_hour_cost, active: !p.active })}>{p.active ? 'Desactivar' : 'Activar'}</button></td></tr>)}</Table></div></Panel>
 <Panel title="Recurrencia e informe semanal"><form className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3" onSubmit={e => form('settings', e)}>
 <Field label="Ventana de recurrencia (días)"><input required className={input} name="recurrence_days" type="number" min={7} max={180} defaultValue={c.settings.recurrence_days}/></Field><Field label="Mínimo de eventos área + causa"><input required className={input} name="recurrence_events" type="number" min={2} max={30} defaultValue={c.settings.recurrence_events}/></Field><Field label="Día sugerido del informe"><select className={input} name="report_day" defaultValue={c.settings.report_day}>{['Lunes', 'Martes', 'Miércoles', 'Jueves', 'Viernes', 'Sábado', 'Domingo'].map((v, i) => <option key={v} value={i + 1}>{v}</option>)}</select></Field>
 <Field label="Hora de corte sugerida · Lima"><input className={input} name="report_time" type="time" required defaultValue={c.settings.report_time.slice(0, 5)}/></Field><Field label="Destinatarios gerenciales"><input className={input} name="report_to" maxLength={1000} defaultValue={c.settings.report_to}/></Field><Field label="Copia"><input className={input} name="report_cc" maxLength={1000} defaultValue={c.settings.report_cc}/></Field><button disabled={busy} className={btn}>Guardar criterios del piloto</button></form><p className="mt-3 text-xs text-slate-500">El informe se prepara y comparte manualmente desde «Informe gerencial». Este horario no configura un envío automático de correo.</p></Panel>
 </>}
 </Shell>;
}
