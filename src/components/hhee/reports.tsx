'use client';
import { useState } from 'react';
import { useHhee } from './provider';
import { useData } from './data';
import { initialFilters, reportEmail, dateLabel, hours, money } from '@/lib/hhee/core';
import { exportReport } from '@/lib/hhee/report';
import { trackingEmailUrl, type EmailClient } from '@/lib/tracking-email';
import { btn, Field, FilterBar, input, Notice, Panel, secondary, Shell, Table } from './ui';
export function Reports() {
    const [filters, setFilters] = useState(initialFilters), { data: d, error, loading } = useData(filters);
    const [msg, setMsg] = useState(''), [busy, setBusy] = useState(false);
    const download = async (format: 'pdf' | 'excel') => { if (!d)
        return; setBusy(true); setMsg(''); try {
        await exportReport(d, format);
    }
    catch (e) {
        setMsg(e instanceof Error ? e.message : 'No se pudo exportar.');
    }
    finally {
        setBusy(false);
    } };
    return <Shell title="Informe para Gerencia" description="Reporte ejecutivo con resultados validados, causas y compromisos. Revise el contenido antes de compartir.">
 <FilterBar value={filters} onChange={setFilters}/>{error && <Notice error>{error}</Notice>}{msg && <Notice error>{msg}</Notice>}{loading && <p role="status">Preparando informe…</p>}
 {d && <><Panel title="Vista previa · Gerencia de Logística"><div className="flex flex-wrap justify-between gap-3"><p className="text-sm">Período: {dateLabel(d.from)} al {dateLabel(d.to)} · Corte: {dateLabel(d.generated_at)}</p><div className="flex gap-2"><button disabled={busy || loading} className={btn} onClick={() => void download('pdf')}>Descargar PDF gerencial</button><button disabled={busy || loading || (d.total > d.row_limit || d.actions_total > d.actions.length)} className={secondary} onClick={() => void download('excel')}>Exportar Excel</button></div></div>
 {(d.total > d.row_limit || d.actions_total > d.actions.length) && <Notice>Acote el período para exportar el detalle completo a Excel (máximo {d.row_limit} solicitudes). El PDF consolida todos los indicadores del alcance.</Notice>}
 <dl className="my-5 grid gap-4 sm:grid-cols-4">{[['Horas validadas', hours(d.metrics.validated_minutes)], ['Costo conocido', d.cost_visible ? money(d.metrics.validated_cost) : 'Acceso restringido'], ['Pendiente de validación', hours(d.metrics.pending_minutes)], ['Excepciones por revisar', d.metrics.pending_exceptions]].map(([k, v]) => <div key={k}><dt className="text-xs text-slate-500">{k}</dt><dd className="mt-1 text-xl font-bold text-[#002855]">{v}</dd></div>)}</dl>
 {d.cost_visible && d.metrics.pending_cost > 0 && <Notice>El costo conocido está incompleto: {d.metrics.pending_cost} filas aún no tienen valorización de RR. HH.</Notice>}
 <Table headers={['Causa confirmada', 'Horas validadas', ...(d.cost_visible ? ['Costo conocido'] : [])]}>{d.causes.map(a => <tr key={a.id}><td>{a.name}</td><td>{hours(a.hours * 60)}</td>{d.cost_visible && <td>{money(a.cost)}</td>}</tr>)}</Table><h3 className="mt-5 mb-2 font-semibold">Decisiones y acciones</h3>{d.actions.length ? <ul className="grid gap-2 text-sm">{d.actions.map(a => <li key={a.id}><b>{a.area_name}</b> · {a.title} · {a.assigned_name} · {dateLabel(a.due_date)} · {a.state}</li>)}</ul> : <p className="text-sm text-slate-500">Sin acciones registradas. Defina medidas sobre las causas que requieren intervención.</p>}
 </Panel>
 <EmailComposer key={d.generated_at} data={d} loading={loading}/></>}
 </Shell>;
}
function EmailComposer({ data: d, loading }: {
    data: import('@/lib/hhee/types').Data;
    loading: boolean;
}) {
    const { context: c } = useHhee(), t = reportEmail(d);
    const [to, setTo] = useState(c?.settings.report_to || ''), [cc, setCc] = useState(c?.settings.report_cc || ''), [subject, setSubject] = useState(t.subject), [body, setBody] = useState(t.body), [client, setClient] = useState<EmailClient>('outlook'), [msg, setMsg] = useState(''), [copied, setCopied] = useState(false);
    const compose = () => { setMsg(''); try {
        const url = trackingEmailUrl(client, { to, cc, subject, body });
        if (client === 'default')
            window.location.href = url;
        else
            window.open(url, '_blank', 'noopener,noreferrer');
    }
    catch (e) {
        setMsg(e instanceof Error ? e.message : 'Revise el correo.');
    } };
    return <>{msg && <Notice error>{msg}</Notice>} <Panel title="Preparar correo profesional"><div className="grid gap-4">
 <Notice>Descargue el PDF y adjúntelo en su correo corporativo. Esta opción abre un borrador; no envía el correo ni adjunta archivos automáticamente. Su firma habitual se incorpora desde el cliente de correo.</Notice>
 <div className="grid gap-3 sm:grid-cols-2"><Field label="Para *"><input className={input} value={to} onChange={e => setTo(e.target.value)} placeholder="gerencia@jrmsac.com.pe"/></Field><Field label="CC"><input className={input} value={cc} onChange={e => setCc(e.target.value)}/></Field></div><Field label="Asunto"><input className={input} value={subject} onChange={e => setSubject(e.target.value)}/></Field><Field label="Mensaje · vista previa editable"><textarea className={input} rows={19} value={body} onChange={e => setBody(e.target.value)}/></Field><div className="flex flex-wrap gap-3"><select aria-label="Cliente de correo" className={secondary} value={client} onChange={e => setClient(e.target.value as EmailClient)}><option value="outlook">Outlook corporativo</option><option value="gmail">Gmail</option><option value="default">Aplicación predeterminada</option></select><button disabled={loading} className={btn} onClick={compose}>Abrir borrador de correo</button><button className={secondary} onClick={() => void navigator.clipboard.writeText(subject + '\n\n' + body).then(() => setCopied(true)).catch(() => setMsg('No se pudo copiar. Seleccione el texto del mensaje.'))}>{copied ? 'Mensaje copiado' : 'Copiar mensaje'}</button></div>
 <p className="text-xs text-slate-500">Corte sugerido: día {c?.settings.report_day} de la semana (1=lunes) a las {c?.settings.report_time?.slice(0, 5)}, hora de Lima. Preparación y envío manual durante el piloto.</p>
 </div></Panel></>;
}
