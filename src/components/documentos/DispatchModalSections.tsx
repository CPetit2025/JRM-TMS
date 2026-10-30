'use client'
import { useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { AlertTriangle, CheckCircle2, Clock, Download, ExternalLink, FileText, Scale } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { money } from '@/lib/caja'
import { BILLING_LABEL, CONCEPT_LABEL } from '@/components/despacho/InheritedSpecialServices'

// Secciones del modal de Documentos de Despacho. La información económica es de solo consulta y sale de la misma fuente que
// el Cierre económico (economic_closure_detail); la aprobación económica se hace únicamente en /despacho/documentos/economico.

type EconomicService = {
  id: string; request_number: string; concept: string; supplier: string | null; status: string; billing_unit: string | null
  agreed_rate: number | null; agreed_qty: number | null; workers: number | null; estimated_pen: number | null; planned_pen: number | null
  final_pen: number | null; final_executed_qty: number | null; final_billable_qty: number | null; final_reason: string | null; final_validated_at: string | null
  item_status?: string | null
}
type EconomicDetail = {
  success: true; state: { status: string; pending: string[]; referential_pen: number; agreed_pen: number; final_pen: number | null }
  freight: { success?: boolean; referential_pen: number; agreed_pen: number; final_pen: number | null; final_reason: string | null; executed_as_planned: boolean | null; extras_pen: number | null; item_status?: string | null } | null
  services: EconomicService[]
}
export type ModalContext = { success: true; status: string; returned_at: string | null; documents: { id: string; category: string | null; size_bytes: number | null; uploaded_by_name: string | null }[]; voided: number }

const ECO_STATUS: Record<string, { label: string; cls: string }> = {
  PENDIENTE: { label: 'Económico pendiente', cls: 'bg-amber-100 text-amber-800' },
  EN_REVISION: { label: 'En revisión económica', cls: 'bg-blue-100 text-blue-800' },
  OBSERVADO: { label: 'Observado económico', cls: 'bg-red-100 text-red-700' },
  CIERRE_PARCIAL: { label: 'Cierre económico parcial', cls: 'bg-sky-100 text-sky-800' },
  CERRADO: { label: 'Cierre económico completado', cls: 'bg-emerald-100 text-emerald-800' },
}
export const ecoBadge = (status?: string | null) => {
  const s = ECO_STATUS[status || ''] || ECO_STATUS.PENDIENTE
  return <span className={`inline-flex rounded px-2 py-0.5 text-[11px] font-semibold ${s.cls}`}>{s.label}</span>
}
/** Un monto sin registro no se muestra como S/ 0.00 confirmado. */
const amount = (v: number | null | undefined, empty = 'Sin registro') => v == null ? <span className="text-xs font-normal text-slate-400">{empty}</span> : <>S/ {money(Number(v))}</>
const variation = (base: number | null | undefined, value: number | null | undefined) => {
  if (base == null || value == null || !Number(base)) return null
  const d = Math.round((Number(value) - Number(base)) * 100) / 100
  if (!d) return null
  return <span className={`ml-1 text-[11px] font-semibold ${d > 0 ? 'text-red-700' : 'text-emerald-700'}`}>{d > 0 ? '+' : ''}{Math.round(d / Number(base) * 100)}%</span>
}
const itemState = (s: { final_validated_at?: string | null; item_status?: string | null; status?: string }) =>
  s.status === 'ANULADO' ? { label: 'No ejecutado', cls: 'bg-slate-100 text-slate-600' }
    : s.item_status === 'APROBADO' ? { label: 'Cerrado', cls: 'bg-emerald-100 text-emerald-800' }
    : s.item_status === 'OBSERVADO' ? { label: 'Observado', cls: 'bg-red-100 text-red-700' }
    : s.final_validated_at ? { label: 'Validado', cls: 'bg-blue-100 text-blue-800' } : { label: 'Pendiente', cls: 'bg-amber-100 text-amber-800' }

/** Lee el detalle económico de la ruta (null si el usuario no tiene acceso o la ruta no aplica). */
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

/** Tarjetas de costo de la ruta: referencial, acordado, final y pendientes (Servicios). */
export function CostSummary({ detail }: { detail: EconomicDetail | null }) {
  if (!detail) return null
  const st = detail.state
  const pending = st.pending?.length || 0
  const card = 'rounded-xl border p-3'
  return (
    <section aria-label="Resumen de costos de la ruta">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-2"><h3 className="text-sm font-bold text-[#002855]">Resumen de costos de la ruta</h3>{ecoBadge(st.status)}</div>
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className={`${card} border-blue-200 bg-blue-50/50`}><p className="text-xs text-slate-500">Referencial</p><p className="text-lg font-bold tabular-nums text-slate-900">{amount(st.referential_pen || null)}</p></div>
        <div className={`${card} border-emerald-200 bg-emerald-50/40`}><p className="text-xs text-slate-500">Acordado</p><p className="text-lg font-bold tabular-nums text-slate-900">{amount(st.agreed_pen || null)}{variation(st.referential_pen, st.agreed_pen)}</p></div>
        <div className={`${card} border-emerald-200 bg-emerald-50/40`}><p className="text-xs text-slate-500">Final</p><p className="text-lg font-bold tabular-nums text-slate-900">{amount(st.final_pen, 'Pendiente')}{variation(st.agreed_pen, st.final_pen)}</p></div>
        <div className={`${card} ${pending ? 'border-amber-200 bg-amber-50' : 'border-slate-200 bg-white'}`}><p className="text-xs text-slate-500">Pendientes</p>
          <p className="text-lg font-bold text-slate-900">{pending ? `${pending} por resolver` : 'Sin pendientes'}</p></div>
      </div>
    </section>
  )
}

type EcoRow = { key: string; label: string; request: string; supplier: string | null; ref: number | null; agreed: number | null; final: number | null; reason: string | null; mode: string; qty: string; rate: number | null; state: { label: string; cls: string } }
function ecoRows(detail: EconomicDetail, transportLabel: string, carrier: string | null): EcoRow[] {
  const f = detail.freight
  const rows: EcoRow[] = []
  if (f && (f.agreed_pen || f.referential_pen || f.final_pen != null)) rows.push({
    key: 'flete', label: 'Transporte', request: 'Ruta', supplier: carrier || transportLabel, ref: f.referential_pen || null, agreed: f.agreed_pen ?? null,
    final: f.final_pen, reason: f.final_reason, mode: 'Viaje', qty: '1', rate: f.agreed_pen ?? null,
    state: f.item_status === 'APROBADO' ? { label: 'Cerrado', cls: 'bg-emerald-100 text-emerald-800' } : f.final_pen != null ? { label: 'Validado', cls: 'bg-blue-100 text-blue-800' } : { label: 'Pendiente', cls: 'bg-amber-100 text-amber-800' },
  })
  for (const s of detail.services) rows.push({
    key: s.id, label: CONCEPT_LABEL[s.concept] || s.concept, request: s.request_number, supplier: s.supplier,
    ref: s.estimated_pen || null, agreed: s.planned_pen ?? null, final: s.final_pen, reason: s.final_reason,
    mode: s.billing_unit ? BILLING_LABEL[s.billing_unit] || s.billing_unit : '—',
    qty: s.final_executed_qty != null ? `${s.final_executed_qty}${s.final_billable_qty != null && s.final_billable_qty !== s.final_executed_qty ? ` (fact. ${s.final_billable_qty})` : ''}${s.workers ? ` × ${s.workers} trab.` : ''}` : '—',
    rate: s.agreed_rate, state: itemState(s),
  })
  return rows
}

/** Listado de servicios con su costo (Servicios) o detalle de liquidación económica (Liquidación). Solo consulta. */
export function EconomicServicesTable({ detail, detailed, transportLabel, carrier, dispatchId }: { detail: EconomicDetail | null; detailed?: boolean; transportLabel: string; carrier: string | null; dispatchId: string }) {
  const rows = useMemo(() => (detail ? ecoRows(detail, transportLabel, carrier) : []), [detail, transportLabel, carrier])
  if (!detail) return null
  const sum = (k: 'ref' | 'agreed' | 'final') => rows.reduce((t, r) => t + Number(r[k] || 0), 0)
  return (
    <section aria-label={detailed ? 'Detalle de liquidación económica' : 'Listado de servicios'} className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-[#002855]">{detailed ? 'Información económica (solo consulta)' : 'Servicios y costos'}</h3>
        <Link href={`/despacho/documentos/economico?despacho=${dispatchId}`} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 bg-white px-2.5 py-1.5 text-xs font-semibold text-[#002855] hover:bg-slate-50">
          <Scale className="h-3.5 w-3.5" />{detailed ? 'Validar en Cierre económico' : 'Ver cierre económico'}<ExternalLink className="h-3 w-3" /></Link>
      </div>
      {rows.length === 0 ? <p className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-500">La ruta no tiene costos registrados.</p> : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[46rem] text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr>
              <th className="px-3 py-2">Servicio</th><th className="px-3 py-2">Proveedor</th>
              {detailed && <><th className="px-3 py-2">Modalidad</th><th className="px-3 py-2 text-right">Cantidad</th><th className="px-3 py-2 text-right">Tarifa</th></>}
              <th className="px-3 py-2 text-right">Referencial</th><th className="px-3 py-2 text-right">Acordado</th><th className="px-3 py-2 text-right">Final</th>
              <th className="px-3 py-2">Estado</th><th className="px-3 py-2">{detailed ? 'Diferencia y justificación' : 'Observación'}</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(r => <tr key={r.key} className={r.state.label === 'Pendiente' ? 'bg-amber-50/40' : ''}>
                <td className="px-3 py-2"><b className="text-slate-800">{r.label}</b><span className="block text-[11px] text-slate-500">{r.request}</span></td>
                <td className="px-3 py-2 text-slate-700">{r.supplier || <span className="text-slate-400">Sin proveedor</span>}</td>
                {detailed && <><td className="px-3 py-2 text-slate-600">{r.mode}</td><td className="px-3 py-2 text-right tabular-nums">{r.qty}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{r.rate == null ? '—' : money(Number(r.rate))}</td></>}
                <td className="px-3 py-2 text-right tabular-nums">{amount(r.ref)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{amount(r.agreed)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{amount(r.final, 'Pendiente')}{variation(r.agreed, r.final)}</td>
                <td className="px-3 py-2"><span className={`rounded px-1.5 py-0.5 text-[11px] font-semibold ${r.state.cls}`}>{r.state.label}</span></td>
                <td className="px-3 py-2 text-xs text-slate-600">{detailed && r.final != null && r.agreed != null && Math.abs(r.final - r.agreed) >= 0.01
                  ? <><b className={r.final > r.agreed ? 'text-red-700' : 'text-emerald-700'}>{r.final > r.agreed ? '+' : ''}{money(r.final - r.agreed)}</b>{r.reason ? ` · ${r.reason}` : ''}</> : r.reason || '—'}</td>
              </tr>)}
            </tbody>
            {detailed && <tfoot className="bg-slate-50 text-sm font-semibold"><tr>
              <td className="px-3 py-2" colSpan={5}>Totales</td>
              <td className="px-3 py-2 text-right tabular-nums">{money(sum('ref'))}</td><td className="px-3 py-2 text-right tabular-nums">{money(sum('agreed'))}</td>
              <td className="px-3 py-2 text-right tabular-nums">{detail.state.final_pen == null ? '—' : money(Number(detail.state.final_pen))}</td><td colSpan={2} />
            </tr></tfoot>}
          </table>
        </div>
      )}
      {detailed && <p className="text-[11px] text-slate-500">Los costos se validan y aprueban en Cierre económico; aquí solo se consultan. El cierre documentario y el económico son independientes.</p>}
    </section>
  )
}

export type GuideRow = { key: string; ot: string; request: string; type: string; number: string | null; date: string | null; status: 'VALIDADA' | 'POR_VALIDAR' | 'OBSERVADA' | 'FALTA' | 'REGISTRADA'; file?: { path: string; name: string } | null; onReview?: () => void }
const GUIDE_STATUS: Record<GuideRow['status'], { label: string; cls: string; icon: typeof CheckCircle2 }> = {
  VALIDADA: { label: 'Validada', cls: 'bg-emerald-100 text-emerald-800', icon: CheckCircle2 },
  REGISTRADA: { label: 'Registrada', cls: 'bg-blue-100 text-blue-800', icon: CheckCircle2 },
  POR_VALIDAR: { label: 'Por validar', cls: 'bg-amber-100 text-amber-800', icon: Clock },
  OBSERVADA: { label: 'Observada', cls: 'bg-red-100 text-red-700', icon: AlertTriangle },
  FALTA: { label: 'Falta', cls: 'bg-red-50 text-red-700 ring-1 ring-inset ring-red-200', icon: AlertTriangle },
}

/** Guías de remisión y notas de despacho de la ruta en una sola tabla, con los documentos obligatorios que faltan. */
export function GuidesTable({ rows, onOpen }: { rows: GuideRow[]; onOpen: (path: string) => void }) {
  return (
    <section aria-label="Guías y notas vinculadas" className="space-y-2">
      <h3 className="text-sm font-bold text-[#002855]">Guías de remisión y notas de despacho</h3>
      {rows.length === 0 ? <p className="rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-500">No hay guías ni notas vinculadas a este despacho.</p> : (
        <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white">
          <table className="w-full min-w-[44rem] text-sm">
            <thead className="bg-slate-50 text-left text-xs text-slate-500"><tr>
              <th className="px-3 py-2">OT · solicitud</th><th className="px-3 py-2">Tipo</th><th className="px-3 py-2">Serie y número</th><th className="px-3 py-2">Fecha</th>
              <th className="px-3 py-2">Estado</th><th className="px-3 py-2">Archivo</th><th className="px-3 py-2 text-right">Acción</th>
            </tr></thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(r => {
                const s = GUIDE_STATUS[r.status]; const Icon = s.icon
                return <tr key={r.key} className={r.status === 'FALTA' ? 'bg-red-50/40' : ''}>
                  <td className="px-3 py-2"><b className="text-slate-800">{r.ot}</b><span className="block text-[11px] text-slate-500">{r.request}</span></td>
                  <td className="px-3 py-2 text-slate-700">{r.type}</td>
                  <td className="px-3 py-2 font-mono text-xs">{r.number || '—'}</td>
                  <td className="px-3 py-2 text-xs text-slate-600">{r.date ? new Date(r.date).toLocaleDateString('es-PE', { timeZone: 'America/Lima' }) : '—'}</td>
                  <td className="px-3 py-2"><span className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] font-semibold ${s.cls}`}><Icon className="h-3 w-3" />{s.label}</span></td>
                  <td className="px-3 py-2 text-xs">{r.file ? <button type="button" onClick={() => onOpen(r.file!.path)} className="inline-flex max-w-48 items-center gap-1 truncate text-blue-800 hover:underline"><FileText className="h-3.5 w-3.5 shrink-0" />{r.file.name}</button> : <span className="text-slate-400">—</span>}</td>
                  <td className="px-3 py-2 text-right">{r.onReview ? <button type="button" onClick={r.onReview} className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold text-[#002855] hover:bg-slate-50">{r.status === 'POR_VALIDAR' || r.status === 'FALTA' ? 'Validar' : 'Ver'}</button>
                    : r.file ? <button type="button" onClick={() => onOpen(r.file!.path)} aria-label="Descargar" className="rounded-lg p-1.5 text-slate-600 hover:bg-slate-100"><Download className="h-4 w-4" /></button> : null}</td>
                </tr>
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-slate-500">Para el cierre documentario se requiere, según el servicio, la Guía de Remisión validada o la Nota de Despacho. Una guía no se registra dos veces.</p>
    </section>
  )
}

export const FILE_CATEGORY: Record<string, string> = { CONFORMIDAD: 'Conformidad de entrega', EVIDENCIA: 'Evidencia fotográfica', COMPROBANTE: 'Comprobante de servicio', OTROS: 'Otros documentos' }
