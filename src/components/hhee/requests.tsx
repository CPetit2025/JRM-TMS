'use client';
import { useMemo, useState } from 'react';
import { Modal } from '@/components/ui/modal';
import { useHhee } from './provider';
import { useData } from './data';
import { RequestDetail } from './detail';
import { RequestForm } from './request-form';
import { Badge, btn, FilterBar, Notice, Panel, secondary, Shell, Table } from './ui';
import { code, dateLabel, hours, initialFilters } from '@/lib/hhee/core';
export function Requests({ approval = false, validation = false, embedded = false }: {
    approval?: boolean;
    validation?: boolean;
    embedded?: boolean;
}) {
    const { context: c } = useHhee(), [filters, setFilters] = useState(initialFilters), { data: d, error, loading } = useData(filters);
    const [newOpen, setNewOpen] = useState(false), [id, setId] = useState(''), [queue, setQueue] = useState('pending'), [page, setPage] = useState(0), [sort, setSort] = useState<'date' | 'area' | 'hours' | 'code'>('date'), [asc, setAsc] = useState(false);
    const rows = useMemo(() => {
        const v = (d?.rows || []).filter(r => !approval || queue === 'all' || (queue === 'exceptions' ? r.needs_exception && r.exception_status === 'PENDIENTE' : r.approval === 'PENDIENTE' && !['BORRADOR', 'CANCELADA'].includes(r.state)));
        return [...v].sort((a, b) => { const x = sort === 'date' ? a.work_date : sort === 'area' ? a.area_name : sort === 'hours' ? a.planned_minutes : a.sequence, y = sort === 'date' ? b.work_date : sort === 'area' ? b.area_name : sort === 'hours' ? b.planned_minutes : b.sequence; return (typeof x === 'number' && typeof y === 'number' ? x - y : String(x).localeCompare(String(y))) * (asc ? 1 : -1); });
    }, [d, approval, queue, sort, asc]);
    const Wrapper = embedded ? Embedded : Shell;
    return <Wrapper title={approval ? 'Aprobaciones y excepciones' : validation ? 'Ejecuciones por validar' : 'Solicitudes de horas extras'} description={approval ? 'El jefe del área autoriza la necesidad prevista. Gerencia revisa las excepciones con independencia.' : 'Solicitud, ejecución y validación: etapas separadas con trazabilidad.'}>
 <FilterBar value={filters} onChange={f => { setFilters(f); setPage(0); }}/>{error && <Notice error>{error}</Notice>}{loading && <p role="status">Actualizando solicitudes…</p>}
 <Panel title="Registro de HHEE"><div className="mb-4 flex flex-wrap items-center gap-3">
 {!approval && c?.areas.some(a => a.can_request) && <button className={btn} onClick={() => setNewOpen(true)}>+ Nueva solicitud</button>}
 {approval && <select aria-label="Cola de aprobación" className={secondary} value={queue} onChange={e => { setQueue(e.target.value); setPage(0); }}><option value="pending">Pendientes del jefe de área</option><option value="exceptions">Excepciones para Gerencia</option><option value="all">Todas</option></select>}
 <label className="text-sm">Ordenar: <select className={secondary} value={sort} onChange={e => setSort(e.target.value as typeof sort)}><option value="date">Fecha operativa</option><option value="area">Área</option><option value="hours">Horas solicitadas</option><option value="code">Código</option></select></label><button className={secondary} onClick={() => setAsc(!asc)}>{asc ? 'Ascendente ↑' : 'Descendente ↓'}</button>
 <span className="ml-auto text-xs text-slate-500">{rows.length} solicitudes visibles</span></div>
 {d && d.total > d.row_limit && <Notice>Se muestran las {d.row_limit} solicitudes más recientes de {d.total}. Acote los filtros. Los indicadores gerenciales incluyen todo el alcance, no solo esta tabla.</Notice>}
 <Table headers={['Solicitud / Fecha', 'Área / Actividad', 'Referencia', 'Solicitadas / Trabajadas', 'Ejecución', 'Aprobación', 'Acciones']}>{rows.slice(page * 25, (page + 1) * 25).map(r => <tr key={r.id}><td><b className="text-[#002855]">{code(r.sequence)}</b><p className="text-xs text-slate-500">{dateLabel(r.work_date)}</p></td><td><b>{r.area_name}</b><p className="max-w-sm text-xs text-slate-600">{r.activity}</p>{r.recurrent && <span className="text-xs text-amber-800">Causa recurrente</span>}</td><td>{r.reference_code || '—'}</td><td>{hours(r.planned_minutes)} / {hours(r.actual_minutes)}</td><td><Badge value={r.state}/>{r.needs_exception && <p className="mt-1 text-xs text-amber-800">Excepción: {r.exception_status}</p>}</td><td><Badge value={r.approval}/></td><td><button className={secondary} onClick={() => setId(r.id)}>{validation ? 'Revisar ejecución' : 'Ver detalle'}</button></td></tr>)}
 {!rows.length && <tr><td colSpan={7}>No hay solicitudes que coincidan con los filtros.</td></tr>}</Table><div className="mt-3 flex items-center justify-end gap-3"><button className={secondary} disabled={page === 0} onClick={() => setPage(page - 1)}>Anterior</button><span className="text-xs">Página {page + 1}</span><button className={secondary} disabled={(page + 1) * 25 >= rows.length} onClick={() => setPage(page + 1)}>Siguiente</button></div></Panel>
 {id && <RequestDetail id={id} onClose={() => setId('')}/>}
 <Modal isOpen={newOpen} onClose={() => setNewOpen(false)} title="Nueva solicitud de horas extras" maxWidth="max-w-6xl"><RequestForm onDone={id => { setNewOpen(false); setId(id); }}/></Modal>
 </Wrapper>;
}
function Embedded({ children }: {
    children: React.ReactNode;
    title: string;
    description: string;
}) { return <div className="mx-auto grid max-w-[1600px] gap-5 p-4 sm:p-6">{children}</div>; }
