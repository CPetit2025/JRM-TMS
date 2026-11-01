'use client'
import { useEffect, useRef, useState, type ReactNode, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { AlertCircle, ArrowLeft, ArrowRight, Camera, CheckCircle2, ChevronDown, CircleDollarSign, MoreHorizontal, FileText, Files, History, Lock, MapPin, Printer, Route, X } from 'lucide-react'
import { conformityLabels, deliveryStatus, type DeliveryRow } from '@/lib/delivery'
import { DETAIL_TABS, type DetailTab } from '@/lib/dispatch-detail'
import { useDispatchDetail } from './useDispatchDetail'
import { useDispatchFiles } from './useDispatchFiles'
import { useDispatchCosts } from './useDispatchCosts'
import { ResumenTab } from './ResumenTab'
import { RutaTab } from './RutaTab'
import { DocumentosTab } from './DocumentosTab'
import { EvidenciasTab } from './EvidenciasTab'
import { CostosTab } from './CostosTab'
import { HistorialTab } from './HistorialTab'
import { ServiceClosure } from '@/components/despacho/ServiceClosure'

// «Toda la ruta»: el expediente de la ruta completa (acciones de la ruta, tripulación, flete, notas), cuando Torre lo envía
type Tab = DetailTab | 'expediente'
const ICONS: Record<Tab, ReactNode> = {
  expediente: <Route className="h-5 w-5" aria-hidden />,
  resumen: <FileText className="h-5 w-5" aria-hidden />, ruta: <MapPin className="h-5 w-5" aria-hidden />, documentos: <Files className="h-5 w-5" aria-hidden />,
  evidencias: <Camera className="h-5 w-5" aria-hidden />, costos: <CircleDollarSign className="h-5 w-5" aria-hidden />, historial: <History className="h-5 w-5" aria-hidden />, cierre: <Lock className="h-5 w-5" aria-hidden />,
}
const CHIP = { warning: 'bg-amber-100 text-amber-800', danger: 'bg-rose-100 text-rose-800', success: 'bg-emerald-100 text-emerald-800', info: 'bg-blue-100 text-jrm-navy' }
/** Estado principal de la cabecera (como «Conformidad pendiente» del bosquejo): conformidad si hay guía, si no el operativo. */
export function headline(row: DeliveryRow): { label: string; tone: keyof typeof CHIP } {
  if (row.state === 'RECHAZADO_DESTINO') return { label: 'Rechazada en destino', tone: 'danger' }
  if (row.conformity === 'RECIBIDA') return { label: 'Conformidad pendiente', tone: 'warning' }
  if (row.conformity === 'OBSERVADA' || row.conformity === 'RECHAZADA') return { label: `Conformidad ${conformityLabels[row.conformity].toLowerCase()}`, tone: 'danger' }
  if (row.conformity === 'VALIDADA') return { label: 'Conforme', tone: 'success' }
  return { label: deliveryStatus(row.state).label, tone: 'info' }
}
const btn = 'flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-semibold'

/**
 * Detalle de una parada (despacho × solicitud) en seis pestañas, más «Toda la ruta» (expediente de la ruta completa) desde Torre. Solo muestra
 * registros reales y delega cada acción en su flujo actual; ningún cierre (operativo, documentario o económico) se dispara
 * desde aquí. «Cerrar detalle» solo cierra la ventana (no cierra la ruta); «Imprimir» imprime la pestaña visible. En móvil ocupa toda la pantalla.
 */
export function DispatchDetailModal({ row, routeRows = [], onSelect, onClose, onValidate, actions, documentsHref, economicHref, routeFile }: {
  row: DeliveryRow; routeRows?: DeliveryRow[]; onSelect?: (row: DeliveryRow) => void; onClose: () => void
  onValidate?: (row: DeliveryRow) => void; actions?: ReactNode; documentsHref?: string; economicHref?: string; routeFile?: ReactNode
}) {
  const [tab, setTab] = useState<Tab>('resumen'), [menu, setMenu] = useState(false), [mounted, setMounted] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  const { detail, error, loading, reload } = useDispatchDetail(row.dispatch_id, row.request_id)
  // Documentos y evidencias (también los archivos de soporte de Costos) se piden la primera vez que se abre su pestaña
  const [filesWanted, setFilesWanted] = useState(false), [costsWanted, setCostsWanted] = useState(false)
  const files = useDispatchFiles(row.dispatch_id, row.request_id, filesWanted || ['documentos', 'evidencias', 'costos'].includes(tab))
  if (!filesWanted && ['documentos', 'evidencias', 'costos'].includes(tab)) setFilesWanted(true)
  const costs = useDispatchCosts(row.dispatch_id, costsWanted || tab === 'costos')
  if (!costsWanted && tab === 'costos') setCostsWanted(true)
  const tabs: readonly { key: Tab; label: string }[] = routeFile ? [...DETAIL_TABS, { key: 'expediente', label: 'Toda la ruta' }] : DETAIL_TABS
  const index = tabs.findIndex(t => t.key === tab), last = index === tabs.length - 1
  const go = (next: Tab) => { setTab(next); body.current?.scrollTo?.({ top: 0 }); document.getElementById?.(`detalle-tab-${next}`)?.scrollIntoView?.({ inline: 'center', block: 'nearest' }) }
  const move = (step: number) => go(tabs[Math.min(tabs.length - 1, Math.max(0, index + step))].key)
  const onTabKey = (e: KeyboardEvent) => { if (e.key === 'ArrowRight') move(1); else if (e.key === 'ArrowLeft') move(-1) }
  const stops = routeRows.filter(r => r.dispatch_id === row.dispatch_id), head = headline(row)
  useEffect(() => {
    const timer = window.setTimeout(() => setMounted(true), 0)
    const onKey = (e: globalThis.KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    if (document.body?.style) document.body.style.overflow = 'hidden'
    return () => { window.clearTimeout(timer); document.removeEventListener('keydown', onKey); if (document.body?.style) document.body.style.overflow = '' }
  }, [onClose])
  const filesPanel = (render: () => ReactNode) => files.loading ? <p role="status" className="py-10 text-center text-sm text-slate-500">Cargando documentos y evidencias…</p>
    : files.error || !files.files ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{files.error || 'No se pudieron cargar los documentos.'} <button type="button" onClick={files.reload} className="font-semibold underline">Reintentar</button></div>
    : render()
  const dialog = <div id="detalle-despacho" className="fixed inset-0 z-[9999] flex items-center justify-center sm:p-4">
    <div className="print-hide fixed inset-0 bg-slate-900/60 backdrop-blur-sm" onClick={onClose} />
    <div role="dialog" aria-modal="true" aria-label={`Detalle del despacho ${row.dispatch_number || ''} · ${row.request_number}`}
      className="detail-panel relative flex h-dvh w-full max-w-[96rem] flex-col overflow-hidden bg-white shadow-2xl sm:h-[94dvh] sm:rounded-2xl">
      <header className="shrink-0 px-4 pt-4 sm:px-8 sm:pt-6">
        <div className="flex items-start gap-3">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-4 gap-y-2">
            <h2 className="min-w-0 break-words text-lg font-bold text-jrm-navy sm:text-2xl lg:text-[1.75rem]">Detalle del despacho {row.dispatch_number || ''} · {row.request_number}</h2>
            <span className={`inline-flex items-center gap-2 rounded-lg px-3 py-1.5 text-sm font-semibold ${CHIP[head.tone]}`}><AlertCircle aria-hidden className={`h-4 w-4 ${head.tone === 'warning' ? 'fill-amber-500 text-amber-100' : ''}`} />{head.label}</span>
          </div>
          <div className="print-hide flex shrink-0 items-center gap-2">
            <button type="button" onClick={() => window.print()} className={`${btn} hidden border border-slate-300 text-jrm-navy hover:bg-slate-50 md:flex`}><Printer className="h-4 w-4" aria-hidden />Imprimir</button>
            {actions && <div className="relative hidden md:block">
              <button type="button" aria-expanded={menu} aria-haspopup="menu" onClick={() => setMenu(open => !open)} className={`${btn} border border-slate-300 text-jrm-navy hover:bg-slate-50`}>Más acciones<ChevronDown className="h-4 w-4" aria-hidden /></button>
            </div>}
            <button type="button" onClick={onClose} aria-label="Cerrar ventana" className="grid h-10 w-10 place-items-center rounded-lg text-slate-600 hover:bg-slate-100"><X className="h-6 w-6" /></button>
          </div>
        </div>
        {stops.length > 1 && onSelect && <label className="print-hide mt-3 flex flex-wrap items-center gap-2 text-sm font-medium text-slate-600">Servicio de la ruta
          <select value={row.request_id} onChange={e => { const next = stops.find(s => s.request_id === e.target.value); if (next) onSelect(next) }} className="h-9 max-w-64 rounded-lg border border-slate-300 bg-white px-2 text-sm">
            {stops.map((s, i) => <option key={s.request_id} value={s.request_id}>{s.request_number} ({i + 1} de {stops.length})</option>)}
          </select></label>}
        <div role="tablist" aria-label="Secciones del detalle" onKeyDown={onTabKey} className="print-hide -mx-4 mt-3 flex gap-1 overflow-x-auto border-b [scrollbar-width:none] [&::-webkit-scrollbar]:hidden border-slate-200 px-4 sm:-mx-8 sm:mt-4 sm:gap-4 sm:px-8">
          {tabs.map(t => <button key={t.key} type="button" role="tab" id={`detalle-tab-${t.key}`} aria-selected={tab === t.key} aria-controls="detalle-panel" tabIndex={tab === t.key ? 0 : -1}
            onClick={() => go(t.key)} className={`flex min-h-12 shrink-0 items-center gap-2 border-b-[3px] px-2 text-sm font-semibold sm:px-3 sm:text-base ${tab === t.key ? 'border-jrm-navy text-jrm-navy' : 'border-transparent text-slate-500 hover:text-jrm-navy'}`}>{ICONS[t.key]}{t.label}</button>)}
        </div>
      </header>
      {/* Menú de acciones siempre montado: una acción con su propia ventana (cierre operativo) no se pierde al ocultarlo.
          En escritorio cae bajo «Más acciones»; en móvil se abre sobre el pie. */}
      {actions && <div role="menu" onClick={() => setMenu(false)} className={`print-hide ${menu ? 'flex' : 'hidden'} absolute inset-x-3 bottom-20 z-30 flex-col gap-1.5 rounded-xl border border-slate-200 bg-white p-2 shadow-xl md:inset-x-auto md:bottom-auto md:right-24 md:top-[4.5rem] md:w-72 [&>*]:w-full [&>*]:justify-start`}>{actions}</div>}
      <div ref={body} role="tabpanel" id="detalle-panel" aria-labelledby={`detalle-tab-${tab}`} className="detail-body min-h-0 flex-1 overflow-y-auto bg-slate-50/70 p-3 sm:p-6">
        {loading ? <p role="status" className="py-10 text-center text-sm text-slate-500">Cargando detalle del despacho…</p>
          : error || !detail ? <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error || 'No se pudo cargar el detalle.'} <button type="button" onClick={reload} className="font-semibold underline">Reintentar</button></div>
          : tab === 'expediente' ? <div className="space-y-3"><p className="rounded-lg border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-jrm-navy">Toda la ruta {row.dispatch_number}: las acciones de esta pestaña afectan a la ruta completa, no solo a esta entrega.</p>{routeFile}</div>
          : tab === 'resumen' ? <ResumenTab row={row} detail={detail} />
          : tab === 'ruta' ? <RutaTab row={row} detail={detail} />
          : tab === 'documentos' ? filesPanel(() => <DocumentosTab row={row} files={files.files!} urls={files.urls} documentsHref={documentsHref} onGo={go} />)
          : tab === 'evidencias' ? filesPanel(() => <EvidenciasTab row={row} files={files.files!} route={files.route} urls={files.urls} servicesCount={detail.dispatch.services_count} onChanged={files.reload} />)
          : tab === 'costos' ? (costs.loading || !costs.costs ? <p role="status" className="py-10 text-center text-sm text-slate-500">Cargando costos…</p>
            : <CostosTab row={row} costs={costs.costs} files={files.files} urls={files.urls} servicesCount={detail.dispatch.services_count} economicHref={economicHref} />)
          : tab === 'cierre' ? <ServiceClosure dispatchId={row.dispatch_id} />
          : <HistorialTab row={row} detail={detail} onGo={go} />}
      </div>
      <footer className="print-hide flex shrink-0 items-center justify-between gap-2 border-t border-slate-200 bg-white px-3 py-3 sm:px-8 sm:py-4">
        <button type="button" onClick={onClose} className={`${btn} hidden border border-slate-300 px-6 text-jrm-navy hover:bg-slate-50 sm:flex`}>Cerrar</button>
        <div className="flex min-w-0 flex-1 justify-end gap-2">
          {actions && <button type="button" aria-expanded={menu} aria-label="Más acciones" onClick={() => setMenu(open => !open)} className={`${btn} border border-slate-300 px-3 text-jrm-navy md:hidden`}><MoreHorizontal className="h-5 w-5" aria-hidden /></button>}
          {onValidate && row.conformity === 'RECIBIDA' && (tab === 'resumen' || tab === 'ruta' || tab === 'documentos') && <button type="button" onClick={() => onValidate(row)} className={`${btn} bg-jrm-navy px-3 text-white hover:bg-jrm-navy-dark sm:px-4`}><CheckCircle2 className="h-5 w-5" aria-hidden /><span className="sm:hidden">Validar</span><span className="hidden sm:inline">Validar conformidad</span></button>}
          {index > 0 && <button type="button" onClick={() => move(-1)} aria-label="Anterior" className={`${btn} border border-slate-300 px-3 text-jrm-navy hover:bg-slate-50 sm:px-4`}><ArrowLeft className="h-4 w-4" aria-hidden /><span className="hidden sm:inline">Anterior</span></button>}
          {last ? <button type="button" onClick={onClose} className={`${btn} bg-jrm-navy px-4 text-white hover:bg-jrm-navy-dark sm:px-6`}><CheckCircle2 className="h-5 w-5" aria-hidden />Cerrar detalle</button>
            : <button type="button" onClick={() => move(1)} className={`${btn} bg-jrm-navy px-4 text-white hover:bg-jrm-navy-dark sm:px-6`}>Siguiente<ArrowRight className="h-4 w-4" aria-hidden /></button>}
        </div>
      </footer>
    </div>
  </div>
  return mounted ? createPortal(dialog, document.body) : null
}
