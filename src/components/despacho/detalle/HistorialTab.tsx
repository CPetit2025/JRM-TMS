'use client'
import { useMemo, useState } from 'react'
import { Download, Filter, History } from 'lucide-react'
import { toast } from 'sonner'
import type { DeliveryRow } from '@/lib/delivery'
import { EVENT_SOURCES, detailTime, eventActor, eventTitle, filterEvents, historyRows, milestones, pendingItems, type DetailTab, type DispatchDetail, type EventFilter } from '@/lib/dispatch-detail'
import { DetailCard, MilestoneList, PendingList, SourcesWarning } from './DetailParts'

const EMPTY: EventFilter = { from: '', to: '', source: '', actor: '' }
const levelDot = (level: string) => level === 'INCIDENCIA' ? 'bg-rose-500' : level === 'ALERTA' ? 'bg-amber-500' : 'bg-slate-400'

export function HistorialTab({ row, detail, onGo }: { row: DeliveryRow; detail: DispatchDetail; onGo: (tab: DetailTab) => void }) {
  const [draft, setDraft] = useState<EventFilter>(EMPTY), [filter, setFilter] = useState<EventFilter>(EMPTY), [exporting, setExporting] = useState(false)
  const shown = useMemo(() => filterEvents(detail.events, filter), [detail.events, filter])
  const sources = [...new Set(detail.events.map(e => e.source))], actors = [...new Set(detail.events.map(eventActor))].sort()
  const exportHistory = async () => {
    setExporting(true)
    try {
      const XLSX = await import('xlsx'), book = XLSX.utils.book_new()
      XLSX.utils.book_append_sheet(book, XLSX.utils.json_to_sheet(historyRows(shown)), 'Historial')
      XLSX.writeFile(book, `historial-despacho-${row.dispatch_number || row.dispatch_id}-${row.request_number}.xlsx`)
    } catch { toast.error('No se pudo exportar el historial. Intente nuevamente.') } finally { setExporting(false) }
  }
  const input = 'h-10 w-full rounded-lg border border-slate-300 bg-white px-2 text-sm'
  return <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,2fr)_minmax(18rem,1fr)]">
    <div className="min-w-0 space-y-3">
      <DetailCard title="Historial del despacho" icon={<History className="h-5 w-5" aria-hidden />}
        actions={<button type="button" onClick={() => void exportHistory()} disabled={exporting || !shown.length} className="flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-jrm-navy disabled:opacity-50"><Download className="h-4 w-4" aria-hidden />Exportar historial</button>}>
        <p className="-mt-2 mb-3 text-xs text-slate-500">Eventos y cambios registrados para la solicitud {row.request_number} y su ruta. {shown.length} de {detail.events.length} evento(s).</p>
        <SourcesWarning failed={detail.sources_failed} />
        {!shown.length ? <p className="py-6 text-center text-sm text-slate-500">{detail.events.length ? 'No hay eventos con los filtros seleccionados.' : 'Sin eventos registrados.'}</p> : <>
          <div className="hidden overflow-x-auto md:block"><table className="w-full text-left text-sm">
            <thead className="bg-slate-50 text-xs text-slate-600"><tr>{['Fecha y hora', 'Evento', 'Ámbito', 'Usuario / origen', 'Detalle'].map(h => <th key={h} className="p-2 font-semibold">{h}</th>)}</tr></thead>
            <tbody className="divide-y">{shown.map((e, i) => <tr key={`${e.at}/${i}`} className="align-top">
              <td className="whitespace-nowrap p-2 tabular-nums text-slate-700"><span aria-hidden className={`mr-2 inline-block h-2.5 w-2.5 rounded-full ${levelDot(e.level)}`} />{detailTime(e.at)}</td>
              <td className="p-2"><p className="font-semibold text-slate-800">{eventTitle(e.type)}</p><p className="text-xs text-slate-500">{EVENT_SOURCES[e.source] || e.source}</p></td>
              <td className="p-2 text-slate-600">{e.scope === 'RUTA' ? 'Ruta' : 'Servicio'}</td>
              <td className="p-2 text-slate-700">{eventActor(e)}</td>
              <td className="max-w-80 whitespace-pre-wrap break-words p-2 text-slate-700">{e.detail || '—'}</td>
            </tr>)}</tbody>
          </table></div>
          <ol className="space-y-2 md:hidden">{shown.map((e, i) => <li key={`${e.at}/${i}`} className="rounded-lg border border-slate-200 p-3 text-sm">
            <p className="flex items-center gap-2 text-xs tabular-nums text-slate-500"><span aria-hidden className={`h-2 w-2 rounded-full ${levelDot(e.level)}`} />{detailTime(e.at)} · {e.scope === 'RUTA' ? 'Ruta' : 'Servicio'}</p>
            <p className="font-semibold text-slate-800">{eventTitle(e.type)}</p>{e.detail && <p className="whitespace-pre-wrap break-words text-slate-700">{e.detail}</p>}
            <p className="text-xs text-slate-500">{eventActor(e)}</p>
          </li>)}</ol>
        </>}
      </DetailCard>
    </div>
    <div className="min-w-0 space-y-4">
      <DetailCard title="Filtros" icon={<Filter className="h-5 w-5" aria-hidden />}>
        <form onSubmit={e => { e.preventDefault(); setFilter(draft) }} className="grid gap-3 sm:grid-cols-2">
          <label className="text-xs font-medium text-slate-600">Desde<input type="date" value={draft.from} onChange={e => setDraft({ ...draft, from: e.target.value })} className={input} /></label>
          <label className="text-xs font-medium text-slate-600">Hasta<input type="date" value={draft.to} onChange={e => setDraft({ ...draft, to: e.target.value })} className={input} /></label>
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">Tipo de evento<select value={draft.source} onChange={e => setDraft({ ...draft, source: e.target.value })} className={input}><option value="">Todos los eventos</option>{sources.map(s => <option key={s} value={s}>{EVENT_SOURCES[s] || s}</option>)}</select></label>
          <label className="text-xs font-medium text-slate-600 sm:col-span-2">Usuario / origen<select value={draft.actor} onChange={e => setDraft({ ...draft, actor: e.target.value })} className={input}><option value="">Todos</option>{actors.map(a => <option key={a} value={a}>{a}</option>)}</select></label>
          <button type="button" onClick={() => { setDraft(EMPTY); setFilter(EMPTY) }} className="min-h-10 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-jrm-navy">Limpiar filtros</button>
          <button type="submit" className="min-h-10 rounded-lg bg-jrm-navy px-3 text-sm font-semibold text-white">Aplicar</button>
        </form>
      </DetailCard>
      <DetailCard title="Resumen de estados"><MilestoneList steps={milestones(detail, row, true)} /></DetailCard>
      <DetailCard title="Acción pendiente"><PendingList items={pendingItems(row)} onGo={onGo} /></DetailCard>
    </div>
  </div>
}
