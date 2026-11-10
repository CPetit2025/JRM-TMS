'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, CheckCircle2, ClipboardCheck, Clock, Loader2, Plus, RefreshCw } from 'lucide-react'
import { useRouter, useSearchParams } from 'next/navigation'
import { DataTable } from '@/components/ui/data-table'
import { PageHeader } from '@/components/ui/page-header'
import { FilterField, FilterToolbar, filterControl } from '@/components/ui/filter-toolbar'
import { StatusBadge } from '@/components/ui/status-badge'
import { createClient } from '@/lib/supabase/client'
import { errorMessage, fmtDate } from '@/lib/caja'
import { SEVERITY, STATUS, callRpc, findingActions, type FindingRow, type Kpis } from '@/lib/audit-findings'
import { FindingForm } from './FindingForm'
import { HallazgosOtPdfButton } from './HallazgosOtPdfButton'
import { useFindingAbilities } from './useFindingAbilities'
import { usePagination } from '@/lib/use-pagination'
import { TablePagination } from '@/components/ui/table-pagination'

const limaDay = (date = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date)
const FILTERS0 = { from: limaDay(new Date(Date.now() - 30 * 864e5)), to: limaDay(), ot: '', client: '', severity: '', status: '', responsible_id: '', auditor_id: '' }

/** Indicadores de las filas visibles (se usan cuando el filtro de texto de OT o cliente recorta la lista). */
export const countKpis = (rows: FindingRow[]): Kpis => ({
  abiertos: rows.filter(r => r.status !== 'CERRADO').length,
  vencidos: rows.filter(r => r.overdue && r.status !== 'CERRADO').length,
  pendientes_validacion: rows.filter(r => r.status === 'PENDIENTE_VALIDACION').length,
  cerrados: rows.filter(r => r.status === 'CERRADO').length,
})

export function FindingsView() {
  const supabase = useMemo(() => createClient(), [])
  const { isLoaded, ...can } = useFindingAbilities()

  const router = useRouter()
  const params = useSearchParams()
  const urlId = params.get('id')
  const [open, setOpen] = useState<{ id: string | null; tab?: 'identificacion' | 'correccion' } | null>(null)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const shown = open || (urlId && urlId !== dismissed && /^[0-9a-f-]{36}$/i.test(urlId) ? { id: urlId } : null)
  const close = () => { setOpen(null); if (urlId) { setDismissed(urlId); router.replace('/despacho/hallazgos') } }

  const [filters, setFilters] = useState(FILTERS0)
  const set = (key: keyof typeof FILTERS0, value: string) => setFilters(f => ({ ...f, [key]: value }))
  const [rows, setRows] = useState<FindingRow[] | null>(null)
  const [serverKpis, setServerKpis] = useState<Kpis | null>(null)
  const [error, setError] = useState('')
  const [users, setUsers] = useState<{ id: string; full_name: string }[]>([])
  const [reload, setReload] = useState(0)
  const refresh = useCallback(() => setReload(n => n + 1), [])

  useEffect(() => { void supabase.rpc('audit_finding_assignable_users').then(({ data }) => setUsers(Array.isArray(data) ? data : data?.users || [])) }, [supabase])
  const { from, to, severity, status, responsible_id, auditor_id } = filters
  useEffect(() => {
    if (!isLoaded) return
    let cancel = false
    const p = Object.fromEntries(Object.entries({ from, to, severity, status, responsible_id, auditor_id }).filter(([, v]) => v))
    callRpc<{ rows?: FindingRow[]; items?: FindingRow[]; kpis?: Kpis }>(supabase, 'audit_finding_list', { p_filters: p })
      .then(data => { if (cancel) return; setRows(data?.rows || data?.items || []); setServerKpis(data?.kpis || null); setError('') })
      .catch(e => { if (!cancel) setError(errorMessage(e)) })
    return () => { cancel = true }
  }, [supabase, isLoaded, from, to, severity, status, responsible_id, auditor_id, reload])

  const ot = filters.ot.trim().toLocaleLowerCase('es-PE'), client = filters.client.trim().toLocaleLowerCase('es-PE')
  const visible = (rows || []).filter(r => (!ot || (r.ot_code || '').toLocaleLowerCase('es-PE').includes(ot)) && (!client || (r.client_name || '').toLocaleLowerCase('es-PE').includes(client)))
  const pg = usePagination(visible, 'hallazgos')
  const kpis = !ot && !client && serverKpis ? serverKpis : countKpis(visible)
  const cards = [
    { label: 'Abiertos', value: kpis.abiertos, icon: Clock, cls: 'text-amber-700 bg-amber-50' },
    { label: 'Vencidos', value: kpis.vencidos, icon: AlertTriangle, cls: 'text-rose-700 bg-rose-50' },
    { label: 'Pendientes de validación', value: kpis.pendientes_validacion, icon: ClipboardCheck, cls: 'text-jrm-navy bg-blue-50' },
    { label: 'Cerrados', value: kpis.cerrados, icon: CheckCircle2, cls: 'text-emerald-700 bg-emerald-50' },
  ]
  const select = (key: keyof typeof FILTERS0, label: string, options: [string, string][]) => <FilterField label={label}>
    <select aria-label={label} className={filterControl} value={filters[key]} onChange={e => set(key, e.target.value)}><option value="">Todos</option>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></FilterField>
  const userOptions = users.map(u => [u.id, u.full_name] as [string, string])
  const btn = 'min-h-11 whitespace-nowrap rounded-lg px-3 text-xs font-semibold lg:min-h-8'

  return <div className="min-w-0 space-y-3">
    <PageHeader showTitle title="Hallazgos de auditoría" description="Registro, corrección y validación de hallazgos de despacho por OT."
      actions={<><button type="button" onClick={refresh} className="flex h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 text-sm hover:bg-slate-50"><RefreshCw className="h-4 w-4" />Actualizar</button>
        {can.write && <button type="button" onClick={() => setOpen({ id: null })} className="flex h-10 items-center gap-2 rounded-lg bg-jrm-navy px-3 text-sm font-semibold text-white hover:bg-jrm-navy-dark"><Plus className="h-4 w-4" />Registrar hallazgo</button>}</>} />

    <section aria-label="Indicadores" className="grid grid-cols-2 gap-2 lg:grid-cols-4">
      {cards.map(c => <div key={c.label} className="flex items-center gap-3 rounded-jrm border border-jrm-line bg-jrm-surface p-3 shadow-jrm-card">
        <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg ${c.cls}`}><c.icon className="h-5 w-5" aria-hidden /></span>
        <div><p className="text-2xl font-bold leading-none text-slate-900" data-kpi={c.label}>{rows === null ? '—' : c.value}</p><p className="mt-1 text-xs text-slate-500">{c.label}</p></div>
      </div>)}
    </section>

    <FilterToolbar label="Filtros de hallazgos" onClear={() => setFilters(FILTERS0)}>
      <FilterField label="Desde"><input type="date" aria-label="Desde" className={filterControl} value={filters.from} max={filters.to} onChange={e => set('from', e.target.value)} /></FilterField>
      <FilterField label="Hasta"><input type="date" aria-label="Hasta" className={filterControl} value={filters.to} min={filters.from} onChange={e => set('to', e.target.value)} /></FilterField>
      <FilterField label="OT"><input aria-label="OT" className={filterControl} value={filters.ot} onChange={e => set('ot', e.target.value)} placeholder="Código" /></FilterField>
      <FilterField label="Cliente"><input aria-label="Cliente" className={filterControl} value={filters.client} onChange={e => set('client', e.target.value)} /></FilterField>
      {select('severity', 'Criticidad', Object.entries(SEVERITY).map(([k, v]) => [k, v.label]))}
      {select('status', 'Estado', Object.entries(STATUS).map(([k, v]) => [k, v.label]))}
      {select('responsible_id', 'Responsable', userOptions)}
      {select('auditor_id', 'Auditor', userOptions)}
    </FilterToolbar>

    {error && <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">No se pudo consultar los hallazgos: {error}</p>}
    {rows === null && !error ? <div className="flex justify-center p-10"><Loader2 className="h-6 w-6 animate-spin text-slate-400" /></div>
      : !visible.length ? <p className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">No hay hallazgos para estos filtros.</p>
      : <section aria-label="Hallazgos" className="overflow-hidden rounded-jrm border border-jrm-line bg-jrm-surface shadow-jrm-card"><div className="overflow-x-auto">
        <DataTable dense className="block w-full text-left text-sm lg:table"><caption className="sr-only">Hallazgos de auditoría de despacho</caption>
          <thead className="hidden bg-slate-50 text-xs text-slate-500 lg:table-header-group"><tr>{['N.º', 'Fecha', 'OT', 'Cliente', 'Categoría', 'Criticidad', 'Responsable', 'Estado', 'Vence', 'Acciones'].map((l, i) => <th key={l} scope="col" className={`whitespace-nowrap px-3 py-2.5 font-semibold ${i === 9 ? 'text-right' : ''}`}>{l}</th>)}</tr></thead>
          <tbody className="block divide-y divide-slate-200 lg:table-row-group">{pg.pageRows.map(r => {
            const a = findingActions(r, can)
            const cell = 'min-w-0 px-3 py-2 align-middle lg:px-2.5'
            const label = (t: string) => <p className="mb-1 text-xs font-semibold text-slate-500 lg:hidden">{t}</p>
            const cats = r.categories || []
            return <tr key={r.id} className="grid grid-cols-1 sm:grid-cols-2 lg:table-row">
              <td className={cell}>{label('N.º')}<span className="whitespace-nowrap font-bold text-jrm-navy">{r.number}</span></td>
              <td className={cell}>{label('Fecha')}<span className="whitespace-nowrap text-xs">{fmtDate(r.registered_at, true)}</span></td>
              <td className={cell}>{label('OT')}<span className="whitespace-nowrap font-semibold">{r.ot_code ? `OT ${r.ot_code}` : '—'}</span></td>
              <td className={cell}>{label('Cliente')}<p className="truncate lg:max-w-48" title={r.client_name || undefined}>{r.client_name || '—'}</p></td>
              <td className={cell}>{label('Categoría')}<span title={cats.join(', ')}>{cats[0] || '—'}{cats.length > 1 ? ` +${cats.length - 1}` : ''}</span></td>
              <td className={cell}>{label('Criticidad')}<StatusBadge tone={SEVERITY[r.severity].tone}>{SEVERITY[r.severity].label}</StatusBadge></td>
              <td className={cell}>{label('Responsable')}{r.responsible_name || <span className="text-slate-400">Sin asignar</span>}</td>
              <td className={cell}>{label('Estado')}<StatusBadge tone={STATUS[r.status].tone}>{STATUS[r.status].label}</StatusBadge></td>
              <td className={cell}>{label('Vence')}<span className={`whitespace-nowrap text-xs ${r.overdue && r.status !== 'CERRADO' ? 'font-semibold text-rose-700' : ''}`}>{r.due_date ? `${fmtDate(r.due_date)}${r.overdue && r.status !== 'CERRADO' ? ' (vencido)' : ''}` : '—'}</span></td>
              <td className={`${cell} lg:text-right`}>{label('Acciones')}<span className="inline-flex flex-wrap gap-1.5 lg:justify-end">
                <button type="button" onClick={() => setOpen({ id: r.id })} className={`${btn} border border-slate-300 bg-white text-jrm-navy hover:bg-slate-50`}>Ver</button>
                {a.edit && <button type="button" onClick={() => setOpen({ id: r.id })} className={`${btn} border border-slate-300 bg-white text-jrm-navy hover:bg-slate-50`}>Editar</button>}
                <HallazgosOtPdfButton contractId={r.contract_id} className={`${btn} border border-slate-300 bg-white text-jrm-navy hover:bg-slate-50`} />
                {a.validate && <button type="button" onClick={() => setOpen({ id: r.id, tab: 'correccion' })} className={`${btn} bg-jrm-navy text-white hover:bg-jrm-navy-dark`}>Validar</button>}
              </span></td>
            </tr>
          })}</tbody>
        </DataTable></div>
        <TablePagination total={pg.total} page={pg.page} pageSize={pg.pageSize} onPageChange={pg.setPage} onPageSizeChange={pg.setPageSize} itemLabel="hallazgos" compact /></section>}

    {shown && <FindingForm key={shown.id || 'nuevo'} findingId={shown.id} initialTab={shown.tab} can={can} onClose={close} onSaved={refresh} />}
  </div>
}
