'use client'
import { useEffect, useId, useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertTriangle, CheckCircle2, CircleDashed, ClipboardCheck, Clock, Download, Eye, FileSpreadsheet, FileText, Image as ImageIcon, Info, Loader2, Pencil, Scale, Trash2, Truck, UploadCloud, X, XCircle } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { money } from '@/lib/caja'
import { Modal } from '@/components/ui/modal'
import { TableActions } from '@/components/ui/table-actions'
import { BILLING_LABEL, CONCEPT_LABEL } from '@/components/despacho/InheritedSpecialServices'

// Secciones del modal de Documentos de Despacho (bosquejo aprobado: Servicios, Guías y notas, Liquidación, Archivos).
// La información económica es de solo consulta y sale de la misma fuente que el Cierre económico (economic_closure_detail);
// validar y aprobar costos se hace únicamente en /despacho/documentos/economico.

type EconomicItem = {
  key: string; kind: 'FLETE' | 'SERVICIO'; id: string | null; concept: string; request_number: string | null; supplier: string | null
  referential_pen: number | null; agreed_pen: number | null; final_pen: number | null; billing_unit: string | null; executed_qty: number | null
  billable_qty: number | null; reason: string | null; observation?: string | null; status: string
}
type EconomicService = { id: string; agreed_rate: number | null; agreed_qty: number | null; workers: number | null; billing_unit: string | null }
export type EconomicDetail = {
  success: true; state: { status: string; pending: string[]; referential_pen: number; agreed_pen: number; final_pen: number | null }
  services: EconomicService[]; items?: EconomicItem[]
}
export type ModalContext = { success: true; status: string; returned_at: string | null; documents: { id: string; category: string | null; size_bytes: number | null; uploaded_by_name: string | null }[]; voided: number }

export const economicHref = (dispatchId: string) => `/despacho/documentos/economico?despacho=${dispatchId}`
const pct = (base: number | null | undefined, value: number | null | undefined) =>
  base == null || value == null || !Number(base) ? null : Math.round((Number(value) - Number(base)) / Number(base) * 100)
function PctPill({ base, value }: { base: number | null | undefined; value: number | null | undefined }) {
  const p = pct(base, value)
  if (p == null || p === 0) return null
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ${p > 0 ? 'bg-emerald-100 text-emerald-800' : 'bg-emerald-100 text-emerald-800'}`}>{p > 0 ? '+' : ''}{p}%</span>
}
const soles = (v: number | null | undefined) => (v == null ? '—' : `S/ ${money(Number(v))}`)

const ITEM_STATE: Record<string, { label: string; cls: string; icon: typeof CheckCircle2 }> = {
  APROBADO: { label: 'Cerrado', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200', icon: CheckCircle2 },
  VALIDADO: { label: 'Validado', cls: 'bg-sky-50 text-sky-700 ring-sky-200', icon: CheckCircle2 },
  EN_REVISION: { label: 'En revisión', cls: 'bg-blue-50 text-blue-700 ring-blue-200', icon: Clock },
  OBSERVADO: { label: 'Observado', cls: 'bg-red-50 text-red-700 ring-red-200', icon: XCircle },
  POR_VALIDAR: { label: 'Pendiente', cls: 'bg-amber-50 text-amber-700 ring-amber-200', icon: Clock },
  NO_APLICA: { label: 'No aplica', cls: 'bg-slate-50 text-slate-600 ring-slate-200', icon: CircleDashed },
}
const stateOf = (i: EconomicItem) => (!Number(i.agreed_pen) && !Number(i.final_pen) && i.final_pen != null ? 'NO_APLICA' : i.status in ITEM_STATE ? i.status : 'POR_VALIDAR')
function StateChip({ state }: { state: string }) {
  const s = ITEM_STATE[state] || ITEM_STATE.POR_VALIDAR; const Icon = s.icon
  return <span className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${s.cls}`}><Icon className="h-3 w-3" />{s.label}</span>
}
const pendingItem = (i: EconomicItem) => ['POR_VALIDAR', 'OBSERVADO'].includes(stateOf(i))
const itemLabel = (i: EconomicItem) => (i.kind === 'FLETE' ? 'Transporte' : CONCEPT_LABEL[i.concept] || i.concept)
const observationOf = (i: EconomicItem) => i.observation || i.reason || (stateOf(i) === 'POR_VALIDAR' ? (i.billing_unit === 'HORA' ? 'Por validar horas' : 'Por validar') : stateOf(i) === 'NO_APLICA' ? 'No se requirió' : '—')

/** Lee el detalle económico de la ruta (null si el usuario no tiene acceso). */
export function useEconomicDetail(dispatchId: string, enabled: boolean) {
  const [data, setData] = useState<EconomicDetail | null>(null)
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void createClient().rpc('economic_closure_detail', { p_dispatch_id: dispatchId }).then(({ data: out }) => {
      if (alive) setData(out?.success ? out as EconomicDetail : null)
    })
    return () => { alive = false }
  }, [dispatchId, enabled])
  return enabled ? data : null
}

export function useModalContext(dispatchId: string, reload: number) {
  const [data, setData] = useState<ModalContext | null>(null)
  useEffect(() => {
    let alive = true
    void createClient().rpc('dispatch_documents_modal_context', { p_dispatch_id: dispatchId }).then(({ data: out }) => {
      if (alive) setData(out?.success ? out as ModalContext : null)
    })
    return () => { alive = false }
  }, [dispatchId, reload])
  return data
}

/** 1 · Servicios: resumen de costos de la ruta y listado de servicios con su estado. */
export function ServicesOverview({ detail, dispatchId, onGuides }: { detail: EconomicDetail | null; dispatchId: string; onGuides: () => void }) {
  const router = useRouter()
  if (!detail) return null
  const items = detail.items || []
  const st = detail.state
  const pending = items.filter(pendingItem).length
  const card = 'flex items-center gap-3 rounded-xl border p-3'
  const icon = 'grid h-10 w-10 shrink-0 place-items-center rounded-lg'
  return <>
    <section aria-label="Resumen de costos de la ruta">
      <h3 className="mb-3 text-[15px] font-bold text-[#002855]">Resumen de costos de la ruta</h3>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <div className={`${card} border-blue-200 bg-blue-50/60`}><span className={`${icon} bg-white text-blue-600 ring-1 ring-blue-200`}><Info className="h-5 w-5" /></span>
          <div><p className="text-xs text-slate-600">Referencial</p><p className="text-lg font-bold tabular-nums text-slate-900">{soles(st.referential_pen)}</p></div></div>
        <div className={`${card} border-emerald-200 bg-emerald-50/50`}><span className={`${icon} bg-white text-emerald-600 ring-1 ring-emerald-200`}><Truck className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1"><p className="text-xs text-slate-600">Acordado</p><p className="flex items-center justify-between gap-2 text-lg font-bold tabular-nums text-slate-900">{soles(st.agreed_pen)}<PctPill base={st.referential_pen} value={st.agreed_pen} /></p></div></div>
        <div className={`${card} border-emerald-200 bg-emerald-50/50`}><span className={`${icon} bg-white text-emerald-600 ring-1 ring-emerald-200`}><ClipboardCheck className="h-5 w-5" /></span>
          <div className="min-w-0 flex-1"><p className="text-xs text-slate-600">Final</p><p className="flex items-center justify-between gap-2 text-lg font-bold tabular-nums text-slate-900">{st.final_pen == null ? <span className="text-base text-slate-400">Pendiente</span> : soles(st.final_pen)}<PctPill base={st.agreed_pen} value={st.final_pen} /></p></div></div>
        <div className={`${card} ${pending ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}><span className={`${icon} bg-white ${pending ? 'text-amber-600 ring-1 ring-amber-200' : 'text-slate-400 ring-1 ring-slate-200'}`}><Clock className="h-5 w-5" /></span>
          <div><p className={`text-xs ${pending ? 'text-amber-700' : 'text-slate-600'}`}>Pendientes</p><p className="text-lg font-bold text-slate-900">{pending ? `${pending} servicio${pending === 1 ? '' : 's'}` : 'Ninguno'}</p></div></div>
      </div>
    </section>
    <section aria-label="Listado de servicios">
      <h3 className="mb-3 text-[15px] font-bold text-[#002855]">Listado de servicios</h3>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[52rem] text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-600"><tr>
            <th className="w-10 px-3 py-2.5">#</th><th className="px-3 py-2.5">Tipo de servicio</th><th className="px-3 py-2.5">Proveedor</th><th className="px-3 py-2.5">Referencial</th>
            <th className="px-3 py-2.5">Acordado</th><th className="px-3 py-2.5">Final</th><th className="px-3 py-2.5">Estado</th><th className="px-3 py-2.5">Observación</th><th className="w-10" />
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {items.length === 0 && <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-500">La ruta no tiene costos registrados.</td></tr>}
            {items.map((i, n) => <tr key={i.key}>
              <td className="px-3 py-2.5 text-slate-500">{n + 1}</td>
              <td className="px-3 py-2.5 font-semibold text-slate-900">{itemLabel(i)}{i.kind === 'SERVICIO' && i.request_number && <span className="block text-[11px] font-normal text-slate-500">{i.request_number}</span>}</td>
              <td className="px-3 py-2.5 text-slate-700">{i.supplier || '—'}</td>
              <td className="px-3 py-2.5 tabular-nums">{soles(i.referential_pen)}</td>
              <td className="px-3 py-2.5 tabular-nums">{soles(i.agreed_pen)}</td>
              <td className="px-3 py-2.5 tabular-nums">{soles(i.final_pen)}</td>
              <td className="px-3 py-2.5"><StateChip state={stateOf(i)} /></td>
              <td className="px-3 py-2.5 text-xs text-slate-600">{observationOf(i)}</td>
              <td className="px-2 py-2.5 text-right"><TableActions compact label={`Acciones de ${itemLabel(i)}`} actions={[
                { id: 'eco', label: 'Validar en Cierre económico', icon: <Scale className="h-4 w-4" />, onSelect: () => router.push(economicHref(dispatchId)) },
                { id: 'guias', label: 'Ver guías y notas', icon: <FileText className="h-4 w-4" />, onSelect: onGuides },
              ]} /></td>
            </tr>)}
          </tbody>
        </table>
      </div>
    </section>
  </>
}

export type GuideRow = { key: string; ot: string; request: string; type: string; number: string | null; date: string | null; status: 'VALIDADA' | 'POR_VALIDAR' | 'OBSERVADA' | 'FALTA' | 'REGISTRADA'; file?: { path: string; name: string } | null; onReview?: () => void }
const GUIDE_STATUS: Record<GuideRow['status'], { label: string; cls: string }> = {
  VALIDADA: { label: 'Validada', cls: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  REGISTRADA: { label: 'Registrada', cls: 'bg-blue-50 text-blue-700 ring-blue-200' },
  POR_VALIDAR: { label: 'Por validar', cls: 'bg-amber-50 text-amber-700 ring-amber-200' },
  OBSERVADA: { label: 'Observada', cls: 'bg-red-50 text-red-700 ring-red-200' },
  FALTA: { label: 'Falta', cls: 'bg-red-50 text-red-700 ring-red-200' },
}

/** 2 · Guías y notas: guías de remisión y notas de despacho vinculadas, con los documentos obligatorios que faltan. */
export function GuidesTable({ rows, onOpen, multipleStops }: { rows: GuideRow[]; onOpen: (path: string) => void; multipleStops: boolean }) {
  return (
    <section aria-label="Guías de remisión vinculadas" className="space-y-3">
      <h3 className="text-[15px] font-bold text-[#002855]">Guías de remisión vinculadas</h3>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[46rem] text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-600"><tr>
            <th className="w-10 px-3 py-2.5">#</th><th className="px-3 py-2.5">Tipo</th><th className="px-3 py-2.5">Número</th><th className="px-3 py-2.5">Fecha</th>
            <th className="px-3 py-2.5">Estado</th><th className="px-3 py-2.5">Archivo</th><th className="w-14" />
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 && <tr><td colSpan={7} className="px-3 py-6 text-center text-slate-500">No hay guías ni notas vinculadas a este despacho.</td></tr>}
            {rows.map((r, n) => {
              const s = GUIDE_STATUS[r.status]
              return <tr key={r.key} className={r.status === 'FALTA' ? 'bg-red-50/40' : ''}>
                <td className="px-3 py-2.5 text-slate-500">{n + 1}</td>
                <td className="px-3 py-2.5 text-slate-800">{r.type === 'Guía de Remisión' ? 'GR - Guía de Remisión' : r.type}{multipleStops && <span className="block text-[11px] text-slate-500">{r.ot} · {r.request}</span>}</td>
                <td className="px-3 py-2.5 tabular-nums text-slate-800">{r.number || '—'}</td>
                <td className="px-3 py-2.5 text-slate-700">{r.date ? new Date(r.date).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : '—'}</td>
                <td className="px-3 py-2.5"><span className={`inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold ring-1 ring-inset ${s.cls}`}>{s.label}</span></td>
                <td className="px-3 py-2.5">{r.file ? <button type="button" onClick={() => onOpen(r.file!.path)} className="inline-flex max-w-56 items-center gap-2 text-slate-700 hover:underline"><FileIcon name={r.file.name} /><span className="truncate">{r.file.name}</span></button> : <span className="text-slate-400">—</span>}</td>
                <td className="px-3 py-2.5 text-right">{r.onReview && !r.file
                  ? <button type="button" onClick={r.onReview} className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-[#002855] hover:bg-slate-50">{r.status === 'POR_VALIDAR' || r.status === 'FALTA' ? 'Validar' : 'Ver'}</button>
                  : r.file ? <button type="button" onClick={() => onOpen(r.file!.path)} aria-label={`Descargar ${r.file.name}`} className="grid h-9 w-9 place-items-center rounded-lg border border-slate-200 text-[#002855] hover:bg-slate-50"><Download className="h-4 w-4" /></button>
                  : r.onReview ? <button type="button" onClick={r.onReview} className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-[#002855] hover:bg-slate-50">Ver</button> : null}</td>
              </tr>
            })}
          </tbody>
        </table>
      </div>
      <p className="flex items-start gap-2 rounded-xl border border-blue-200 bg-blue-50/60 p-3 text-xs leading-5 text-slate-700"><Info className="mt-0.5 h-4 w-4 shrink-0 text-blue-600" />
        <span>Las guías se muestran cuando ya llegaron por la guía de entrega, el despacho o un archivo; una guía no se registra dos veces.<br />
          Para completar el cierre documentario se requiere como mínimo la Guía de Remisión (validada) o Nota de Despacho, según el servicio.</span></p>
    </section>
  )
}

/** 3 · Liquidación: detalle de liquidación por servicio y totales (solo consulta; se edita en Cierre económico). */
export function LiquidationDetail({ detail, dispatchId }: { detail: EconomicDetail | null; dispatchId: string }) {
  const router = useRouter()
  const items = detail?.items || []
  const rate = (i: EconomicItem) => i.kind === 'FLETE' ? i.agreed_pen : detail?.services.find(s => s.id === i.id)?.agreed_rate ?? null
  if (!detail) return <p className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">La información económica no está disponible para su perfil.</p>
  const st = detail.state
  const diff = st.final_pen == null ? null : Math.round((Number(st.final_pen) - Number(st.agreed_pen)) * 100) / 100
  const edit = () => router.push(economicHref(dispatchId))
  return <>
    <section aria-label="Detalle de liquidación por servicio">
      <h3 className="mb-3 text-[15px] font-bold text-[#002855]">Detalle de liquidación por servicio</h3>
      <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
        <table className="w-full min-w-[52rem] text-sm">
          <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-600"><tr>
            <th className="w-10 px-3 py-2.5">#</th><th className="px-3 py-2.5">Servicio</th><th className="px-3 py-2.5">Proveedor</th><th className="px-3 py-2.5">Modalidad</th>
            <th className="px-3 py-2.5 text-right">Cantidad</th><th className="px-3 py-2.5 text-right">Tarifa</th><th className="px-3 py-2.5 text-right">Importe (S/)</th><th className="px-3 py-2.5">Obs.</th><th className="w-10" />
          </tr></thead>
          <tbody className="divide-y divide-slate-100">
            {items.length === 0 && <tr><td colSpan={9} className="px-3 py-6 text-center text-slate-500">La ruta no tiene costos registrados.</td></tr>}
            {items.map((i, n) => {
              const pend = stateOf(i) === 'POR_VALIDAR', warn = pend ? 'text-orange-600' : ''
              const qty = i.kind === 'FLETE' ? 1 : i.executed_qty
              return <tr key={i.key} className={pend ? 'bg-orange-50/70' : ''}>
                <td className="px-3 py-2.5 text-slate-500">{n + 1}</td>
                <td className="px-3 py-2.5 font-semibold text-slate-900">{itemLabel(i)}</td>
                <td className={`px-3 py-2.5 ${warn || 'text-slate-700'}`}>{i.supplier || '—'}</td>
                <td className={`px-3 py-2.5 ${warn || 'text-slate-700'}`}>{i.kind === 'FLETE' ? 'Viaje' : i.billing_unit ? BILLING_LABEL[i.billing_unit] || i.billing_unit : '—'}</td>
                <td className={`px-3 py-2.5 text-right tabular-nums ${warn}`}>{qty == null ? '—' : Number(qty).toFixed(Number.isInteger(Number(qty)) ? 0 : 1)}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{rate(i) == null ? '—' : money(Number(rate(i)))}</td>
                <td className="px-3 py-2.5 text-right tabular-nums">{i.final_pen == null ? '—' : money(Number(i.final_pen))}</td>
                <td className={`px-3 py-2.5 text-xs ${warn || 'text-slate-600'}`}>{pend ? 'Pendiente de validar' : observationOf(i)}</td>
                <td className="px-2 py-2.5 text-right"><button type="button" onClick={edit} aria-label={`Validar ${itemLabel(i)} en Cierre económico`} title="Validar en Cierre económico" className="grid h-8 w-8 place-items-center rounded-lg text-[#002855] hover:bg-slate-100"><Pencil className="h-4 w-4" /></button></td>
              </tr>
            })}
          </tbody>
        </table>
      </div>
    </section>
    <section aria-label="Totales">
      <h3 className="mb-2 text-[15px] font-bold text-[#002855]">Totales</h3>
      <dl className="grid divide-y rounded-xl border border-slate-200 bg-slate-50/70 sm:grid-cols-4 sm:divide-x sm:divide-y-0">
        <div className="p-4"><dt className="text-xs text-slate-600">Referencial</dt><dd className="mt-1 text-xl font-bold tabular-nums text-slate-900">{soles(st.referential_pen)}</dd></div>
        <div className="p-4"><dt className="text-xs text-slate-600">Acordado</dt><dd className="mt-1 text-xl font-bold tabular-nums text-slate-900">{soles(st.agreed_pen)}</dd>
          {pct(st.referential_pen, st.agreed_pen) ? <dd className="text-xs font-semibold text-red-600">{pct(st.referential_pen, st.agreed_pen)! > 0 ? '+' : ''}{pct(st.referential_pen, st.agreed_pen)}%</dd> : null}</div>
        <div className="p-4"><dt className="text-xs text-slate-600">Final</dt><dd className="mt-1 text-xl font-bold tabular-nums text-slate-900">{st.final_pen == null ? 'Pendiente' : soles(st.final_pen)}</dd>
          {pct(st.agreed_pen, st.final_pen) ? <dd className={`text-xs font-semibold ${pct(st.agreed_pen, st.final_pen)! > 0 ? 'text-red-600' : 'text-emerald-700'}`}>{pct(st.agreed_pen, st.final_pen)! > 0 ? '+' : ''}{pct(st.agreed_pen, st.final_pen)}%</dd> : null}</div>
        <div className="p-4"><dt className="text-xs text-slate-600">Diferencia acordado vs final</dt><dd className="mt-1 text-xl font-bold tabular-nums text-slate-900">{diff == null ? '—' : `S/ ${money(diff)}`}</dd></div>
      </dl>
      <p className="mt-2 text-[11px] text-slate-500">Los importes se validan y aprueban en Cierre económico (lápiz); aquí solo se consultan. El cierre documentario y el económico son independientes.</p>
    </section>
  </>
}

export const FILE_CATEGORY: Record<string, string> = { COMPROBANTE: 'Comprobante de servicio', CONFORMIDAD: 'Conformidad de entrega', EVIDENCIA: 'Evidencia fotográfica', OTROS: 'Otros documentos' }
const extOf = (name: string) => (name.split('.').pop() || '').toUpperCase().slice(0, 5)
export function FileIcon({ name }: { name: string }) {
  const ext = extOf(name)
  const Icon = ['XLS', 'XLSX', 'CSV'].includes(ext) ? FileSpreadsheet : ['JPG', 'JPEG', 'PNG', 'WEBP'].includes(ext) ? ImageIcon : FileText
  return <Icon className={`h-4 w-4 shrink-0 ${Icon === FileText ? 'text-red-600' : Icon === FileSpreadsheet ? 'text-emerald-600' : 'text-violet-600'}`} aria-hidden />
}
export const FILE_ACCEPT = '.pdf,.jpg,.jpeg,.png,.webp,.xls,.xlsx,.csv'
export const MAX_FILE_MB = 10, MAX_FILES = 5

export type FileRow = { key: string; name: string; type: string; category?: string | null; size: number | null; date: string | null; by: string | null; where?: string | null; onOpen: () => void; onVoid?: () => void }

/** 4 · Archivos: zona de carga (con categoría) y tabla de archivos de la ruta y sus servicios. */
export function FilesSection({ rows, canUpload, staged, onStage, onUnstage, category, onCategory, extra }: {
  rows: FileRow[]; canUpload: boolean; staged: File[]; onStage: (files: File[]) => void; onUnstage: (i: number) => void
  category: string; onCategory: (c: string) => void; extra?: React.ReactNode
}) {
  const [over, setOver] = useState(false)
  const inputId = useId()
  return <section aria-label="Archivos del despacho" className="space-y-3">
    <div><h3 className="text-[15px] font-bold text-[#002855]">Archivos del despacho</h3>
      <p className="text-xs text-slate-500">Documentos relacionados a la ruta, servicios, comprobantes, fotos y otros.</p></div>
    {canUpload && <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_16rem]">
      <div onDragOver={e => { e.preventDefault(); setOver(true) }} onDragLeave={() => setOver(false)}
        onDrop={e => { e.preventDefault(); setOver(false); onStage(Array.from(e.dataTransfer.files || [])) }}
        className={`flex flex-col items-center justify-center gap-2 rounded-xl border-2 border-dashed p-4 text-center ${over ? 'border-blue-400 bg-blue-50' : 'border-slate-300 bg-white'}`}>
        <UploadCloud className="h-6 w-6 text-[#002855]" aria-hidden />
        <p className="text-sm font-semibold text-slate-800">Arrastra archivos aquí</p><p className="-mt-1 text-xs text-blue-700">o selecciona desde tu equipo</p>
        <div className="flex items-stretch overflow-hidden rounded-lg border border-slate-300 bg-white">
          <label htmlFor={inputId} className="flex cursor-pointer items-center gap-2 px-3 py-1.5 text-xs font-semibold text-[#002855] hover:bg-slate-50"><FileText className="h-4 w-4" />Seleccionar archivos</label>
          <input id={inputId} type="file" multiple accept={FILE_ACCEPT} className="sr-only" onChange={e => { onStage(Array.from(e.target.files || [])); e.target.value = '' }} />
          <select aria-label="Categoría de los archivos" value={category} onChange={e => onCategory(e.target.value)} className="border-l border-slate-300 bg-white px-2 text-xs text-slate-700">
            {Object.entries(FILE_CATEGORY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
        </div>
        {extra}
      </div>
      <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-3 text-xs text-slate-700"><p className="font-semibold text-[#002855]">Tipos de archivo permitidos</p>
        <ul className="mt-1 list-disc space-y-0.5 pl-4"><li>PDF, JPG, PNG, Excel (XLS/XLSX)</li><li>Tamaño máximo por archivo: {MAX_FILE_MB} MB</li><li>Hasta {MAX_FILES} archivos por carga</li></ul></div>
    </div>}
    {staged.length > 0 && <ul aria-label="Archivos por guardar" className="space-y-1.5 rounded-xl border border-amber-200 bg-amber-50/60 p-3">
      <li className="text-xs font-semibold text-amber-800">Por guardar ({FILE_CATEGORY[category]}) · pulse «Guardar cambios»</li>
      {staged.map((f, i) => <li key={`${f.name}-${f.size}-${i}`} className="flex items-center gap-2 text-xs"><FileIcon name={f.name} /><span className="min-w-0 flex-1 truncate">{f.name}</span>
        <span className="tabular-nums text-slate-500">{(f.size / 1024 / 1024).toFixed(1)} MB</span>
        <button type="button" onClick={() => onUnstage(i)} aria-label={`Quitar ${f.name}`} className="rounded p-1 text-slate-500 hover:bg-white hover:text-red-700"><X className="h-3.5 w-3.5" /></button></li>)}
    </ul>}
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
      <table className="w-full min-w-[46rem] text-sm">
        <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-600"><tr>
          <th className="px-3 py-2.5">Nombre</th><th className="px-3 py-2.5">Tipo</th><th className="px-3 py-2.5">Tamaño</th><th className="px-3 py-2.5">Fecha</th><th className="px-3 py-2.5">Subido por</th><th className="px-3 py-2.5 text-center">Acciones</th>
        </tr></thead>
        <tbody className="divide-y divide-slate-100">
          {rows.length === 0 && <tr><td colSpan={6} className="px-3 py-6 text-center text-slate-500">Sin archivos cargados.</td></tr>}
          {rows.map(r => <tr key={r.key}>
            <td className="px-3 py-2.5"><button type="button" onClick={r.onOpen} className="flex min-w-0 items-center gap-2 text-left"><FileIcon name={r.name} /><span className="max-w-72 truncate text-slate-800 hover:underline">{r.name}</span></button>
              {(r.category || r.where) && <span className="ml-6 block text-[11px] text-slate-500">{[r.category, r.where].filter(Boolean).join(' · ')}</span>}</td>
            <td className="px-3 py-2.5 text-slate-700">{r.type}</td>
            <td className="px-3 py-2.5 tabular-nums text-slate-700">{r.size ? `${(r.size / 1024 / 1024).toFixed(1)} MB` : '—'}</td>
            <td className="px-3 py-2.5 text-slate-700">{r.date ? new Date(r.date).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : '—'}</td>
            <td className="px-3 py-2.5 text-slate-700">{r.by || '—'}</td>
            <td className="px-3 py-2.5"><div className="flex items-center justify-center gap-2">
              <button type="button" onClick={r.onOpen} aria-label={`Descargar ${r.name}`} className="grid h-8 w-8 place-items-center rounded-lg border border-slate-200 text-[#002855] hover:bg-slate-50">{r.type === 'Evidencia' ? <Eye className="h-4 w-4" /> : <Download className="h-4 w-4" />}</button>
              {r.onVoid && <button type="button" onClick={r.onVoid} aria-label={`Anular ${r.name}`} className="grid h-8 w-8 place-items-center rounded-lg text-red-600 hover:bg-red-50"><Trash2 className="h-4 w-4" /></button>}
            </div></td>
          </tr>)}
        </tbody>
      </table>
    </div>
  </section>
}

type CostEvent = { id: string; concept: string | null; stage: string; old_amount: number | null; new_amount: number | null; new_status: string | null; reason: string | null; created_at: string; supplier: string | null; user: string | null }
const STAGE: Record<string, string> = { REFERENCIAL: 'Referencial', ACORDADO: 'Acordado', AJUSTE: 'Ajuste', FINAL: 'Final', ESTADO: 'Estado' }

/** Historia de cambios de costos de la ruta (service_cost_history). */
export function CostHistoryModal({ dispatchId, onClose }: { dispatchId: string; onClose: () => void }) {
  const [events, setEvents] = useState<CostEvent[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    void createClient().rpc('service_cost_history', { p_dispatch_id: dispatchId }).then(({ data, error: e }) => {
      if (!alive) return
      if (e || !data?.success) { setError(e?.message || data?.error || 'No se pudo leer la historia'); return }
      setEvents(data.events as CostEvent[])
    })
    return () => { alive = false }
  }, [dispatchId])
  return <Modal isOpen onClose={onClose} title="Historia de cambios de costos" maxWidth="max-w-2xl">
    {error ? <p className="text-sm text-red-700">{error}</p> : !events ? <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-400" />
      : events.length === 0 ? <p className="text-sm text-slate-500">Sin cambios de costo registrados.</p>
      : <ul className="space-y-2 text-sm">{events.map(e => <li key={e.id} className="border-l-2 border-slate-200 pl-3">
        <p><b className="text-slate-800">{STAGE[e.stage] || e.stage} · {e.concept === 'FLETE' ? 'Transporte' : CONCEPT_LABEL[e.concept || ''] || e.concept}</b>
          <span className="text-slate-700"> {e.old_amount != null ? `S/ ${money(Number(e.old_amount))} → ` : ''}{e.new_amount != null ? `S/ ${money(Number(e.new_amount))}` : e.new_status}</span>
          {e.supplier && <span className="text-slate-500"> · {e.supplier}</span>}</p>
        <p className="text-xs text-slate-500">{new Date(e.created_at).toLocaleString('es-PE', { timeZone: 'America/Lima' })}{e.user ? ` · ${e.user}` : ''}{e.reason ? ` · Motivo: ${e.reason}` : ''}</p>
      </li>)}</ul>}
  </Modal>
}

type OtFile = { id: string; doc_type: string; file_name: string | null; file_path: string; uploaded_at: string; dispatch_id: string; dispatches?: { dispatch_number: string } | { dispatch_number: string }[] | null }
/** Todos los archivos de las OT de la ruta, en todas sus rutas. */
export function OtFilesModal({ requestIds, onOpen, onClose }: { requestIds: string[]; onOpen: (path: string) => void; onClose: () => void }) {
  const [files, setFiles] = useState<OtFile[] | null>(null)
  const [error, setError] = useState('')
  useEffect(() => {
    let alive = true
    const run = async () => {
      const supabase = createClient()
      const own = await supabase.from('transport_requests').select('contract_id').in('id', requestIds)
      const contracts = [...new Set((own.data || []).map(r => r.contract_id).filter(Boolean))] as string[]
      if (own.error || !contracts.length) { if (alive) { setFiles([]); if (own.error) setError(own.error.message) } return }
      const reqs = await supabase.from('transport_requests').select('id').in('contract_id', contracts).limit(1000)
      const links = await supabase.from('dispatch_requests').select('dispatch_id').in('transport_request_id', (reqs.data || []).map(r => r.id)).limit(2000)
      const dispatchIds = [...new Set((links.data || []).map(l => l.dispatch_id))]
      const docs = dispatchIds.length ? await supabase.from('dispatch_documents').select('id,doc_type,file_name,file_path,uploaded_at,dispatch_id,dispatches(dispatch_number)')
        .in('dispatch_id', dispatchIds).is('voided_at', null).order('uploaded_at', { ascending: false }).limit(500) : { data: [], error: null }
      if (!alive) return
      if (reqs.error || links.error || docs.error) setError((reqs.error || links.error || docs.error)!.message)
      setFiles((docs.data || []) as OtFile[])
    }
    void run()
    return () => { alive = false }
  }, [requestIds])
  const route = (f: OtFile) => (Array.isArray(f.dispatches) ? f.dispatches[0] : f.dispatches)?.dispatch_number || '—'
  return <Modal isOpen onClose={onClose} title="Archivos de la OT (todas sus rutas)" maxWidth="max-w-3xl">
    {error && <p className="mb-2 text-sm text-red-700">{error}</p>}
    {!files ? <Loader2 className="mx-auto h-5 w-5 animate-spin text-slate-400" /> : files.length === 0 ? <p className="text-sm text-slate-500">Sin archivos en otras rutas de la OT.</p>
      : <ul className="divide-y divide-slate-100 text-sm">{files.map(f => <li key={f.id} className="flex items-center gap-2 py-2">
        <FileIcon name={f.file_name || f.file_path} /><button type="button" onClick={() => onOpen(f.file_path)} className="min-w-0 flex-1 truncate text-left text-blue-800 hover:underline">{f.file_name || 'Archivo'}</button>
        <span className="text-xs text-slate-500">Ruta {route(f)} · {new Date(f.uploaded_at).toLocaleDateString('es-PE', { timeZone: 'America/Lima' })}</span></li>)}</ul>}
  </Modal>
}

/** Indicador visual de alerta (para servicios con documentos obligatorios pendientes). */
export function PendingDot() { return <AlertTriangle className="h-3.5 w-3.5 text-amber-500" aria-label="Con pendientes" /> }
