'use client'
import { Fragment, useMemo, useState } from 'react'
import { AlertTriangle, ChevronDown, ChevronUp, Clock, Download, FileText, Filter, History, ListChecks, MapPin, RotateCcw, Satellite, User } from 'lucide-react'
import { toast } from 'sonner'
import type { DeliveryRow } from '@/lib/delivery'
import { EVENT_SOURCES, detailTime, eventActor, eventTitle, filterEvents, historyRows, milestones, pendingItems, type DetailEvent, type DetailTab, type DispatchDetail, type EventFilter } from '@/lib/dispatch-detail'
import { DetailCard, MilestoneList, SourcesWarning } from './DetailParts'

const EMPTY: EventFilter = { from: '', to: '', source: '', actor: '' }
/** Estado mostrado de cada registro (no cambia nada: describe el tipo de evento guardado). */
function eventState(e: DetailEvent): [string, string] {
  if (e.level === 'INCIDENCIA') return ['Incidencia', 'bg-rose-50 text-rose-700 ring-rose-200']
  if (e.level === 'ALERTA') return ['Observado', 'bg-amber-50 text-amber-800 ring-amber-200']
  if (['LLEGADA_DESTINO', 'CONFORMIDAD_VALIDADA', 'STATUS_CHANGE', 'GUIA_RECIBIDA', 'ECONOMICO_APROBAR', 'DOCUMENTARIO_CIERRE_MANUAL'].includes(e.type)) return ['Completado', 'bg-emerald-50 text-emerald-700 ring-emerald-200']
  return ['Registrado', 'bg-slate-100 text-slate-600 ring-slate-200']
}
const dot = (e: DetailEvent) => e.level === 'INCIDENCIA' ? 'bg-rose-500' : e.level === 'ALERTA' ? 'bg-orange-500' : eventState(e)[0] === 'Completado' ? 'bg-emerald-600' : 'bg-slate-300'
const SourceIcon = ({ e }: { e: DetailEvent }) => e.source === 'OPERACION' || e.source === 'ENTREGA' ? <MapPin className="h-4 w-4" /> : e.source === 'INCIDENTE' ? <AlertTriangle className="h-4 w-4" /> : <FileText className="h-4 w-4" />
const ActorIcon = ({ e }: { e: DetailEvent }) => e.actor ? <User className="h-4 w-4" /> : <Satellite className="h-4 w-4" />

export function HistorialTab({ row, detail, onGo }: { row: DeliveryRow; detail: DispatchDetail; onGo: (tab: DetailTab) => void }) {
  const [draft, setDraft] = useState<EventFilter>(EMPTY), [filter, setFilter] = useState<EventFilter>(EMPTY), [exporting, setExporting] = useState(false), [open, setOpen] = useState<number | null>(null)
  const shown = useMemo(() => filterEvents(detail.events, filter), [detail.events, filter])
  const sources = [...new Set(detail.events.map(e => e.source))], actors = [...new Set(detail.events.map(eventActor))].sort(), pending = pendingItems(row)
  const exportHistory = async () => {
    setExporting(true)
    try {
      const XLSX = await import('xlsx'), book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(historyRows(shown)), 'Historial')
      XLSX.writeFile(book, `historial-despacho-${row.dispatch_number || row.dispatch_id}-${row.request_number}.xlsx`)
    } catch { toast.error('No se pudo exportar el historial. Intente nuevamente.') } finally { setExporting(false) }
  }
  const input = 'mt-1 h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-800'
  return <div className="grid items-start gap-4 sm:gap-5 xl:grid-cols-[minmax(0,2.4fr)_minmax(20rem,1fr)]">
    <div className="min-w-0 space-y-3">
      <DetailCard title={<span><span className="block">Historial del despacho</span><span className="block text-sm font-normal text-slate-500">Registra la secuencia de eventos y cambios de estado del despacho.</span></span>} icon={<History />}
        actions={<button type="button" onClick={() => void exportHistory()} disabled={exporting || !shown.length} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold text-jrm-navy hover:bg-slate-50 disabled:opacity-50"><Download className="h-4 w-4" aria-hidden />Exportar historial</button>}>
        <SourcesWarning failed={detail.sources_failed} />
        <p className="mb-2 text-xs text-slate-500">{shown.length} de {detail.events.length} evento(s) de la solicitud {row.request_number} y su ruta.</p>
        {!shown.length ? <p className="py-6 text-center text-sm text-slate-500">{detail.events.length ? 'No hay eventos con los filtros seleccionados.' : 'Sin eventos registrados.'}</p> : <>
          <div className="hidden overflow-x-auto rounded-lg border border-slate-200 md:block"><table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-slate-600"><tr><th className="w-8" />{['Fecha y hora', 'Evento', 'Estado', 'Usuario / Origen', 'Detalle'].map(h => <th key={h} className="px-3 py-2.5 font-medium">{h}</th>)}<th className="w-10" /></tr></thead>
            <tbody>{shown.map((e, i) => { const [state, cls] = eventState(e); return <Fragment key={`${e.at}/${i}`}><tr className="border-t border-slate-200 align-top">
              <td className="relative pl-3 pt-3.5">{i < shown.length - 1 && <span aria-hidden className="absolute left-[19px] top-8 h-full w-px bg-slate-200" />}<span aria-hidden className={`relative block h-3.5 w-3.5 rounded-full ring-4 ring-white ${dot(e)}`} /></td>
              <td className="whitespace-nowrap px-3 py-2.5 tabular-nums text-slate-700">{new Date(e.at).toLocaleDateString('es-PE', { timeZone: 'America/Lima' })}<span className="block text-slate-500">{new Date(e.at).toLocaleTimeString('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit' })}</span></td>
              <td className="px-3 py-2.5"><div className="flex items-start gap-2"><span className="mt-0.5 text-jrm-navy"><SourceIcon e={e} /></span><div><p className="font-semibold text-jrm-navy">{eventTitle(e.type)}</p><p className="text-xs text-slate-500">{EVENT_SOURCES[e.source] || e.source}</p></div></div></td>
              <td className="px-3 py-2.5"><span className={`inline-flex whitespace-nowrap rounded-md px-2 py-1 text-xs font-semibold ring-1 ring-inset ${cls}`}>{state}</span></td>
              <td className="px-3 py-2.5"><div className="flex items-start gap-2"><span className="mt-0.5 text-slate-500"><ActorIcon e={e} /></span><div><p className="text-slate-800">{e.actor || 'Sistema'}</p><p className="text-xs text-slate-500">{e.origin ? `Origen ${e.origin}` : e.actor ? 'Usuario TMS' : 'Registro automático'}</p></div></div></td>
              <td className="max-w-72 px-3 py-2.5 text-slate-600"><p className="line-clamp-2 break-words">{e.detail || '—'}</p></td>
              <td className="px-2 py-2"><button type="button" aria-expanded={open === i} aria-label="Ver detalle del evento" onClick={() => setOpen(open === i ? null : i)} className="grid h-8 w-8 place-items-center rounded-lg text-slate-500 hover:bg-slate-100">{open === i ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</button></td>
            </tr>{open === i && <tr className="bg-slate-50"><td /><td colSpan={6} className="px-3 py-2.5 text-sm text-slate-700"><p className="whitespace-pre-wrap break-words">{e.detail || 'Sin detalle registrado.'}</p>
              <p className="mt-1 text-xs text-slate-500">{e.scope === 'RUTA' ? 'Registrado en la ruta' : `Registrado en la solicitud ${row.request_number}`} · {detailTime(e.at)}</p></td></tr>}</Fragment> })}</tbody>
          </table></div>
          <ol className="space-y-2 md:hidden">{shown.map((e, i) => { const [state, cls] = eventState(e); return <li key={`${e.at}/${i}`} className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
            <div className="flex items-center justify-between gap-2"><p className="flex items-center gap-2 text-xs tabular-nums text-slate-500"><span aria-hidden className={`h-2.5 w-2.5 rounded-full ${dot(e)}`} />{detailTime(e.at)}</p><span className={`rounded-md px-2 py-0.5 text-xs font-semibold ring-1 ring-inset ${cls}`}>{state}</span></div>
            <p className="mt-1 font-semibold text-jrm-navy">{eventTitle(e.type)}</p>{e.detail && <p className="whitespace-pre-wrap break-words text-slate-700">{e.detail}</p>}
            <p className="text-xs text-slate-500">{eventActor(e)} · {EVENT_SOURCES[e.source] || e.source}</p>
          </li> })}</ol>
        </>}
      </DetailCard>
    </div>
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <DetailCard title="Filtros" icon={<Filter />}>
        <form onSubmit={e => { e.preventDefault(); setFilter(draft); setOpen(null) }} className="grid grid-cols-2 gap-3">
          <label className="text-sm text-slate-600">Desde<input type="date" value={draft.from} onChange={e => setDraft({ ...draft, from: e.target.value })} className={input} /></label>
          <label className="text-sm text-slate-600">Hasta<input type="date" value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} className={input} /></label>
          <label className="col-span-2 text-sm text-slate-600">Tipo de evento<select value={draft.source} onChange={e => setDraft({ ...draft, source: e.target.value })} className={input}><option value="">Todos los eventos</option>{sources.map(s => <option key={s} value={s}>{EVENT_SOURCES[s] || s}</option>)}</select></label>
          <label className="col-span-2 text-sm text-slate-600">Usuario / Origen<select value={draft.actor} onChange={e => setDraft({ ...draft, actor: e.target.value })} className={input}><option value="">Todos</option>{actors.map(a => <option key={a} value={a}>{a}</option>)}</select></label>
          <button type="button" onClick={() => { setDraft(EMPTY); setFilter(EMPTY) }} className="flex min-h-10 items-center gap-2 text-sm font-semibold text-jrm-navy"><RotateCcw className="h-4 w-4" aria-hidden />Limpiar filtros</button>
          <button type="submit" className="min-h-10 rounded-lg bg-jrm-navy px-4 text-sm font-semibold text-white hover:bg-jrm-navy-dark">Aplicar</button>
        </form>
      </DetailCard>
      <DetailCard title="Resumen de estados" icon={<ListChecks />}><MilestoneList steps={milestones(detail, row, true)} columns={false} /></DetailCard>
      {pending.length > 0 && <section aria-label="Acción pendiente" className="rounded-xl border border-orange-200 bg-orange-50 p-4">
        <div className="flex items-start gap-3"><AlertTriangle aria-hidden className="mt-0.5 h-6 w-6 shrink-0 fill-orange-500 text-white" />
          <div className="min-w-0 flex-1"><p className="font-bold text-orange-700">Acción pendiente</p>{pending.map(p => <p key={p.key} className="text-sm text-slate-700">{p.detail}</p>)}</div>
          <button type="button" onClick={() => onGo('documentos')} className="flex min-h-9 shrink-0 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-jrm-navy"><Clock className="h-4 w-4" aria-hidden />Ir a documentos</button>
        </div>
      </section>}
    </div>
  </div>
}
