'use client'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowDown, ArrowUp, Download, Eye, Loader2, Search } from 'lucide-react'
import { DataTable } from '@/components/ui/data-table'
import { Modal } from '@/components/ui/modal'
import { createClient } from '@/lib/supabase/client'
import { errorMessage } from '@/lib/caja'
import { limaDay, PREUSE_FORMAT, type PreuseInspection } from '@/lib/preuse'
import { filterPreuse, preuseResult, sortPreuse, type PreuseFilters, type PreuseSort } from '@/lib/preuse-reports'
import { exportPreusePdf } from '@/lib/preuse-pdf'
import { toast } from 'sonner'

const initial = (): PreuseFilters => ({ from: limaDay(), to: limaDay(), search: '', driver: '', plate: '', inspector: '', result: '' })
const field = 'mt-1 block min-h-11 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm'
const labels = { APTO: 'Apto', OBSERVADO: 'Con observaciones', NO_APTO: 'No apto' }
const columns: { key: PreuseSort['key']; label: string }[] = [
  { key: 'record_sequence', label: 'Registro' }, { key: 'captured_at', label: 'Fecha / hora' },
  { key: 'driver_name', label: 'Conductor' }, { key: 'vehicle_plate', label: 'Unidad' },
  { key: 'result', label: 'Resultado' }, { key: 'inspector_name', label: 'Inspeccionado por' },
]
export function PreuseReports() {
  const supabase = useMemo(() => createClient(), [])
  const [filters, setFilters] = useState(initial), [query, setQuery] = useState<PreuseFilters | null>(null)
  const [rows, setRows] = useState<PreuseInspection[]>([])
  const [busy, setBusy] = useState(false), [exporting, setExporting] = useState(false), [error, setError] = useState('')
  const [sort, setSort] = useState<PreuseSort>({ key: 'captured_at', descending: true }), [page, setPage] = useState(0)
  const [detail, setDetail] = useState<PreuseInspection | null>(null), [authorization, setAuthorization] = useState<PreuseInspection | null>(null)
  const [reason, setReason] = useState(''), [authorizing, setAuthorizing] = useState(false)
  const request = useRef(0)
  const invalidateRequest = useCallback(() => { request.current++ }, [])
  const load = useCallback(async (next: PreuseFilters) => {
    const sequence = ++request.current
    setBusy(true); setError(''); setQuery(null)
    try {
      const { data, error } = await supabase.rpc('list_driver_preuse', { p_from: next.from, p_to: next.to, p_search: [next.search, next.driver, next.plate, next.inspector].join(' ').trim() })
      if (sequence !== request.current) return
      if (error) throw error
      setRows(data || []); setQuery(next); setPage(0)
    } catch (e) { if (sequence === request.current) { setRows([]); setError(errorMessage(e)) } }
    finally { if (sequence === request.current) setBusy(false) }
  }, [supabase])
  useEffect(() => { const timer = window.setTimeout(() => void load(initial()), 0); return () => { window.clearTimeout(timer); invalidateRequest() } }, [load, invalidateRequest])
  const current = query !== null && JSON.stringify(query) === JSON.stringify(filters)
  const filtered = useMemo(() => query ? sortPreuse(filterPreuse(rows, query), sort) : [], [rows, query, sort])
  const visible = filtered.slice(page * 50, (page + 1) * 50)
  const change = (key: keyof PreuseFilters, value: string) => setFilters(previous => ({ ...previous, [key]: value }))
  const download = async (row?: PreuseInspection) => {
    if (busy || exporting || (!row && !current)) return
    setExporting(true)
    try {
      await exportPreusePdf(row ? [row] : filtered, row?.operation_date || filters.from, row?.operation_date || filters.to,
        row ? `FR-DT007_${row.vehicle_plate.replace(/[^a-z0-9]/gi, '')}_${row.operation_date}_${row.record_sequence || row.operation_id}.pdf` : undefined)
    } catch (e) { toast.error(errorMessage(e)) } finally { setExporting(false) }
  }
  const authorize = async (event: React.FormEvent) => {
    event.preventDefault(); if (!authorization || authorizing) return
    setAuthorizing(true)
    try {
      const result = await supabase.rpc('authorize_driver_preuse_repeat', { p_operation: authorization.operation_id, p_reason: reason.trim() })
      if (result.error) throw result.error
      toast.success('Reinspección autorizada. El conductor debe actualizar Checklist y registrar el nuevo formato.')
      setAuthorization(null); setDetail(null); setReason(''); await load(filters)
    } catch (e) { toast.error(errorMessage(e)) } finally { setAuthorizing(false) }
  }
  return <section className="space-y-4">
    <div className="rounded-xl border border-blue-200 bg-blue-50 p-4"><h2 className="font-bold text-[#002855]">FR-DT 007 · Inspección de pre uso</h2><p className="mt-1 text-sm text-slate-600">Un registro ordinario por conductor, unidad y día de Lima. Cada inspección conserva su formato y firma. Las reinspecciones requieren autorización.</p></div>
    <form onSubmit={event => { event.preventDefault(); void load(filters) }} className="grid gap-3 rounded-xl border border-slate-200 bg-white p-4 sm:grid-cols-2 xl:grid-cols-4">
      <label className="text-sm">Desde<input required type="date" value={filters.from} onChange={e => change('from', e.target.value)} className={field} /></label>
      <label className="text-sm">Hasta<input required type="date" min={filters.from} value={filters.to} onChange={e => change('to', e.target.value)} className={field} /></label>
      <label className="text-sm">Buscar registro o brevete<input maxLength={100} value={filters.search} onChange={e => change('search', e.target.value)} placeholder="Registro, nombre, placa o brevete" className={field} /></label>
      <label className="text-sm">Conductor<input maxLength={120} value={filters.driver} onChange={e => change('driver', e.target.value)} className={field} /></label>
      <label className="text-sm">Placa<input maxLength={20} value={filters.plate} onChange={e => change('plate', e.target.value)} placeholder="Ej. BDJ943 o BDJ-943" className={field} /></label>
      <label className="text-sm">Inspeccionado por<input maxLength={120} value={filters.inspector} onChange={e => change('inspector', e.target.value)} className={field} /></label>
      <label className="text-sm">Resultado<select value={filters.result} onChange={e => change('result', e.target.value)} className={field}><option value="">Todos</option>{Object.entries(labels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
      <div className="flex flex-wrap items-end gap-2"><button disabled={busy} className="flex min-h-11 items-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}Consultar</button><button type="button" disabled={busy} onClick={() => { const cleared = initial(); setFilters(cleared); void load(cleared) }} className="min-h-11 rounded-lg border px-3 text-sm">Limpiar</button></div>
    </form>
    {error && <p role="alert" className="rounded-xl bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {!current && !busy && !error && <p role="status" className="text-sm text-amber-800">Filtros pendientes de aplicar. Pulsa Consultar.</p>}
    <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border bg-white p-3"><p className="text-sm">{current ? `${filtered.length} registros · ${filtered.filter(row => row.can_operate).length} aptos según inspección · ${filtered.filter(row => !row.can_operate).length} no aptos` : 'Consulta pendiente'}</p><button type="button" disabled={!current || !filtered.length || busy || exporting} onClick={() => void download()} className="flex min-h-11 items-center gap-2 rounded-lg border px-3 text-sm font-semibold text-[#002855] disabled:opacity-50"><Download className="h-4 w-4" />Exportar resultados PDF</button></div>
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">{busy ? <p className="p-6 text-center text-sm">Consultando inspecciones…</p> : current && !filtered.length ? <p className="p-6 text-center text-sm">Sin registros para estos filtros.</p> : current && <DataTable sortable={false} className="w-full text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-500"><tr>{columns.map(column => <th key={column.key} aria-sort={sort.key === column.key ? sort.descending ? 'descending' : 'ascending' : 'none'} className="p-3"><button type="button" onClick={() => { setSort(previous => ({ key: column.key, descending: previous.key === column.key ? !previous.descending : false })); setPage(0) }} className="flex min-h-10 items-center gap-1 font-semibold">{column.label}{sort.key === column.key ? sort.descending ? <ArrowDown className="h-3 w-3" /> : <ArrowUp className="h-3 w-3" /> : <span aria-hidden>↕</span>}</button></th>)}<th className="p-3">Acciones</th></tr></thead><tbody className="divide-y">{visible.map(row => <tr key={row.operation_id}>
      <td className="p-3 font-semibold">{row.record_sequence || '—'}{row.authorized_repeat && <p className="text-xs font-normal text-blue-700">Reinspección autorizada</p>}{(row.same_day_records || 0) > 1 && !row.authorized_repeat && <p className="text-xs font-normal text-amber-800">Varios registros del día</p>}</td>
      <td className="p-3 whitespace-nowrap">{row.operation_date.split('-').reverse().join('/')}<p className="text-xs text-slate-500">{new Date(row.captured_at).toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', second: '2-digit' })}</p></td><td className="p-3">{row.driver_name}</td><td className="p-3 font-semibold text-[#002855]">{row.vehicle_plate}</td><td className="p-3"><span className={`rounded-full px-2 py-1 text-xs font-semibold ${row.can_operate ? 'bg-emerald-50 text-emerald-800' : 'bg-red-50 text-red-800'}`}>{labels[preuseResult(row)]}</span></td><td className="p-3">{row.inspector_name}</td>
      <td className="p-3"><div className="flex flex-wrap gap-2"><button type="button" onClick={() => setDetail(row)} className="flex min-h-10 items-center gap-1 rounded-lg border px-3 text-xs font-semibold"><Eye className="h-4 w-4" />Detalle</button><button type="button" disabled={exporting} onClick={() => void download(row)} className="flex min-h-10 items-center gap-1 rounded-lg border px-3 text-xs font-semibold text-[#002855] disabled:opacity-50"><Download className="h-4 w-4" />PDF</button>{row.can_authorize_repeat && !row.repeat_authorized && <button type="button" onClick={() => { setAuthorization(row); setReason('') }} className="min-h-10 rounded-lg border border-amber-300 px-3 text-xs font-semibold text-amber-900">Autorizar reinspección</button>}{row.repeat_authorized && <span className="text-xs text-amber-800">Reinspección pendiente</span>}</div></td>
    </tr>)}</tbody></DataTable>}</div>
    {current && filtered.length > 50 && <div className="flex items-center justify-end gap-3 text-sm"><button disabled={!page} onClick={() => setPage(previous => previous - 1)} className="min-h-10 rounded border px-3 disabled:opacity-40">Anterior</button><span>Página {page + 1} de {Math.ceil(filtered.length / 50)}</span><button disabled={(page + 1) * 50 >= filtered.length} onClick={() => setPage(previous => previous + 1)} className="min-h-10 rounded border px-3 disabled:opacity-40">Siguiente</button></div>}
    {detail && <Modal isOpen onClose={() => setDetail(null)} title={`FR-DT 007 · Registro ${detail.record_sequence || ''} · ${detail.vehicle_plate}`} maxWidth="max-w-4xl"><div className="space-y-4 text-sm"><p><b>Conductor:</b> {detail.driver_name} · <b>Fecha:</b> {detail.operation_date}</p><p><b>Brevete:</b> {detail.license} · <b>SOAT:</b> {detail.soat_expiration} · <b>Revisión técnica:</b> {detail.technical_review_expiration}</p><p><b>Vehículo declarado operativo:</b> {detail.vehicle_operational ? 'Sí' : 'No'} · <b>Resultado:</b> {labels[preuseResult(detail)]}</p><div className="overflow-x-auto"><table className="w-full text-left"><thead><tr><th className="p-2">Ítem</th><th className="p-2">Respuesta</th><th className="p-2">Comentarios</th></tr></thead><tbody>{PREUSE_FORMAT.items.map(item => { const answer = detail.answers.find(a => a.code === item.code); return <tr key={item.code} className="border-t"><td className="p-2">{item.text}</td><td className="p-2 font-semibold">{answer?.response}</td><td className="p-2">{answer?.comment || '—'}</td></tr> })}</tbody></table></div><p><b>Observación:</b> {detail.observation || 'Sin observaciones'}</p><p><b>Inspeccionado por:</b> {detail.inspector_name}</p>{detail.reinspection_reason && <p><b>Motivo de reinspección autorizada:</b> {detail.reinspection_reason}</p>}<button type="button" disabled={exporting} onClick={() => void download(detail)} className="min-h-11 rounded-lg bg-[#002855] px-4 font-semibold text-white disabled:opacity-50">Descargar este formato PDF</button></div></Modal>}
    {authorization && <Modal isOpen onClose={() => { if (!authorizing) setAuthorization(null) }} title="Autorizar reinspección FR-DT 007" maxWidth="max-w-xl"><form onSubmit={authorize} className="space-y-4 text-sm"><p>{authorization.driver_name} · {authorization.vehicle_plate} · Registro {authorization.record_sequence}</p><p className="rounded-lg bg-amber-50 p-3 text-amber-900">El registro original se conserva. La autorización permite una nueva inspección del día y deja pendiente la habilitación hasta completarla.</p><label className="block">Motivo de la reinspección<textarea required minLength={10} maxLength={500} value={reason} onChange={e => setReason(e.target.value)} className={field} /></label><button disabled={authorizing} className="min-h-11 rounded-lg bg-[#002855] px-4 font-semibold text-white disabled:opacity-50">{authorizing ? 'Autorizando…' : 'Confirmar autorización'}</button></form></Modal>}
  </section>
}
