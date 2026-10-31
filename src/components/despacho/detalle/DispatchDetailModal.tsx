'use client'
import { useState, type ReactNode, type KeyboardEvent } from 'react'
import { ArrowLeft, ArrowRight, Camera, CircleDollarSign, CheckCircle2, ChevronDown, FileText, Files, History, MapPin } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { StatusBadge } from '@/components/ui/status-badge'
import { conformityLabels, deliveryStatus, type DeliveryRow } from '@/lib/delivery'
import { DETAIL_TABS, type DetailTab } from '@/lib/dispatch-detail'
import { useDispatchDetail } from './useDispatchDetail'
import { ResumenTab } from './ResumenTab'
import { RutaTab } from './RutaTab'
import { HistorialTab } from './HistorialTab'
import { DocumentosTab } from './DocumentosTab'
import { EvidenciasTab } from './EvidenciasTab'
import { useDispatchFiles } from './useDispatchFiles'
import { CostosTab } from './CostosTab'
import { useDispatchCosts } from './useDispatchCosts'

const ICONS: Record<DetailTab, ReactNode> = {
  resumen: <FileText className="h-4 w-4" aria-hidden />, ruta: <MapPin className="h-4 w-4" aria-hidden />, documentos: <Files className="h-4 w-4" aria-hidden />,
  evidencias: <Camera className="h-4 w-4" aria-hidden />, costos: <CircleDollarSign className="h-4 w-4" aria-hidden />, historial: <History className="h-4 w-4" aria-hidden />,
}
const conformityTone = (c: DeliveryRow['conformity']) => c === 'VALIDADA' ? 'success' : c === 'OBSERVADA' || c === 'RECHAZADA' || c === 'RECHAZO_DESTINO' ? 'danger' : c === 'NO_APLICA' || c === 'HISTORICA' ? 'neutral' : 'warning'

/**
 * Detalle de una parada (despacho × solicitud) en pestañas. Solo muestra registros reales y delega cada acción en
 * su flujo actual; ningún cierre (operativo, documentario o económico) se dispara desde aquí. «Finalizar» solo cierra.
 */
export function DispatchDetailModal({ row, routeRows = [], onSelect, onClose, onValidate, actions, documentsHref, economicHref }: {
  row: DeliveryRow; routeRows?: DeliveryRow[]; onSelect?: (row: DeliveryRow) => void; onClose: () => void
  onValidate?: (row: DeliveryRow) => void; actions?: ReactNode; documentsHref?: string; economicHref?: string
}) {
  const [tab, setTab] = useState<DetailTab>('resumen'), [menu, setMenu] = useState(false)
  const { detail, error, loading, reload } = useDispatchDetail(row.dispatch_id, row.request_id)
  // Documentos y evidencias se piden la primera vez que se abre una de esas pestañas
  const [filesWanted, setFilesWanted] = useState(false)
  const files = useDispatchFiles(row.dispatch_id, row.request_id, filesWanted || tab === 'documentos' || tab === 'evidencias')
  if (!filesWanted && (tab === 'documentos' || tab === 'evidencias')) setFilesWanted(true)
  const [costsWanted, setCostsWanted] = useState(false)
  const costs = useDispatchCosts(row.dispatch_id, costsWanted || tab === 'costos')
  if (!costsWanted && tab === 'costos') setCostsWanted(true)
  const index = DETAIL_TABS.findIndex(t => t.key === tab), last = index === DETAIL_TABS.length - 1
  const move = (step: number) => setTab(DETAIL_TABS[Math.min(DETAIL_TABS.length - 1, Math.max(0, index + step))].key)
  const onTabKey = (e: KeyboardEvent) => { if (e.key === 'ArrowRight') move(1); else if (e.key === 'ArrowLeft') move(-1) }
  const stops = routeRows.filter(r => r.dispatch_id === row.dispatch_id)
  const status = deliveryStatus(row.state)
  return <Modal isOpen onClose={onClose} title={`Detalle del despacho ${row.dispatch_number || ''} · ${row.request_number}`} maxWidth="max-w-7xl"
    footer={<div className="flex flex-wrap items-center justify-between gap-2">
      <button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-jrm-navy">Cerrar</button>
      <div className="flex flex-wrap justify-end gap-2">
        {onValidate && row.conformity === 'RECIBIDA' && <button type="button" onClick={() => onValidate(row)} className="flex min-h-10 items-center gap-1.5 rounded-lg border border-jrm-navy px-3 text-sm font-semibold text-jrm-navy"><CheckCircle2 className="h-4 w-4" aria-hidden />Validar conformidad</button>}
        <button type="button" disabled={index === 0} onClick={() => move(-1)} className="flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-sm font-semibold text-jrm-navy disabled:opacity-40"><ArrowLeft className="h-4 w-4" aria-hidden />Anterior</button>
        {last ? <button type="button" onClick={onClose} className="flex min-h-10 items-center gap-1.5 rounded-lg bg-jrm-navy px-4 text-sm font-semibold text-white"><CheckCircle2 className="h-4 w-4" aria-hidden />Finalizar</button>
          : <button type="button" onClick={() => move(1)} className="flex min-h-10 items-center gap-1.5 rounded-lg bg-jrm-navy px-4 text-sm font-semibold text-white">Siguiente<ArrowRight className="h-4 w-4" aria-hidden /></button>}
      </div>
    </div>}>
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge tone={row.state === 'RECHAZADO_DESTINO' ? 'danger' : 'info'} title="Estado operativo">{status.label}</StatusBadge>
        <StatusBadge tone={conformityTone(row.conformity)} title="Conformidad de la entrega">{conformityLabels[row.conformity]}</StatusBadge>
        {stops.length > 1 && onSelect && <label className="flex items-center gap-2 text-xs font-medium text-slate-600">Servicio de la ruta
          <select value={row.request_id} onChange={e => { const next = stops.find(s => s.request_id === e.target.value); if (next) onSelect(next) }} className="h-9 max-w-56 rounded-lg border border-slate-300 bg-white px-2 text-sm">
            {stops.map((s, i) => <option key={s.request_id} value={s.request_id}>{s.request_number} ({i + 1} de {stops.length})</option>)}
          </select></label>}
        {actions && <div className="relative ml-auto">
          <button type="button" aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu(open => !open)} className="flex min-h-10 items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-3 text-sm font-semibold text-jrm-navy">Más acciones<ChevronDown className="h-4 w-4" aria-hidden /></button>
          {/* Siempre montado: una acción con su propia ventana (cierre operativo) no se pierde al ocultar el menú */}
          <div role="menu" onClick={() => setMenu(false)} className={`absolute right-0 z-20 mt-1 ${menu ? 'flex' : 'hidden'} w-72 max-w-[calc(100vw-2rem)] flex-col gap-1.5 rounded-xl border border-slate-200 bg-white p-2 shadow-xl [&>*]:w-full [&>*]:justify-start`}>{actions}</div>
        </div>}
      </div>
      <div role="tablist" aria-label="Secciones del detalle" onKeyDown={onTabKey} className="-mx-1 flex gap-1 overflow-x-auto border-b border-slate-200 px-1">
        {DETAIL_TABS.map(t => <button key={t.key} type="button" role="tab" id={`detalle-tab-${t.key}`} aria-selected={tab === t.key} aria-controls="detalle-panel" tabIndex={tab === t.key ? 0 : -1}
          onClick={() => setTab(t.key)} className={`flex min-h-11 shrink-0 items-center gap-2 border-b-2 px-3 text-sm font-semibold ${tab === t.key ? 'border-jrm-navy text-jrm-navy' : 'border-transparent text-slate-500 hover:text-jrm-navy'}`}>{ICONS[t.key]}{t.label}</button>)}
      </div>
      <div role="tabpanel" id="detalle-panel" aria-labelledby={`detalle-tab-${tab}`} className="min-w-0">
        {loading ? <p role="status" className="py-10 text-center text-sm text-slate-500">Cargando detalle del despacho…</p>
          : error || !detail ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error || 'No se pudo cargar el detalle.'} <button type="button" onClick={reload} className="font-semibold underline">Reintentar</button></div>
          : tab === 'resumen' ? <ResumenTab row={row} detail={detail} />
          : tab === 'ruta' ? <RutaTab row={row} detail={detail} />
          : tab === 'documentos' || tab === 'evidencias' ? (files.loading ? <p role="status" className="py-10 text-center text-sm text-slate-500">Cargando documentos y evidencias…</p>
            : files.error || !files.files ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{files.error || 'No se pudieron cargar los documentos.'} <button type="button" onClick={files.reload} className="font-semibold underline">Reintentar</button></div>
            : tab === 'documentos' ? <DocumentosTab row={row} files={files.files} urls={files.urls} documentsHref={documentsHref} />
            : <EvidenciasTab files={files.files} route={files.route} urls={files.urls} servicesCount={detail.dispatch.services_count} />)
          : tab === 'costos' ? (costs.loading || !costs.costs ? <p role="status" className="py-10 text-center text-sm text-slate-500">Cargando costos…</p>
            : <CostosTab row={row} costs={costs.costs} economicHref={economicHref} />)
          : <HistorialTab row={row} detail={detail} onGo={setTab} />}
      </div>
    </div>
  </Modal>
}
