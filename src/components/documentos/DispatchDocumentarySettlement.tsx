'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { DOCS_BUCKET, errorMessage, receiptUrl } from '@/lib/caja'
import type { DeliveryRow } from '@/lib/delivery'
import { referenceLabel } from '@/lib/suppliers'
import { fetchServiceTypes } from '@/lib/request-service'
import { DeliveryReview, type DeliveryReviewTarget } from '@/components/delivery/DeliveryReview'
import { DocumentNumberLinks } from '@/components/despacho/DocumentNumberLinks'
import { GuidesClosureTab, NOT_SETTLEABLE, knownNumbers, settlementKind, type Checklist, type DocInfo } from '@/components/documentos/GuidesClosureTab'

// Liquidación documentaria de un viaje dentro de Torre de Control (reingeniería, Fase 5): el mismo GuidesClosureTab y
// las mismas consultas y permisos que la bandeja de Documentos de Despacho, para un solo viaje.

type Stop = { request_id: string; request_number: string; ot_code: string | null; client: string | null; delivery: string; sequence: number | null }
type Item = { id: string; status: string; is_pickup: boolean; stops: Stop[]; documents: DocInfo[]; number_references?: { request_id: string; doc_type: string; document_number: string }[] }
type Data = { item: Item; types: Awaited<ReturnType<typeof fetchServiceTypes>>; deliveries: DeliveryRow[]; checklists: Map<string, Checklist> }

const limaDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d)

export function DispatchDocumentarySettlement({ dispatchId, onChanged }: { dispatchId: string; onChanged?: () => void }) {
  const supabase = useMemo(() => createClient(), [])
  const { canWrite, canRead, role, isLoaded } = usePermissions()
  const [data, setData] = useState<Data | null | 'missing'>(null)
  const [linking, setLinking] = useState(false)
  const [review, setReview] = useState<DeliveryReviewTarget | null>(null)

  const load = useCallback(async () => {
    try {
      // La bandeja se consulta por período: se pide el día del viaje (±1) y se toma este viaje
      const { data: d } = await supabase.from('dispatches').select('scheduled_departure').eq('id', dispatchId).maybeSingle()
      const day = new Date(d?.scheduled_departure || Date.now())
      const { data: queue, error } = await supabase.rpc('get_documentary_queue_period', { p_include_departed: true,
        p_from: `${limaDay(new Date(day.getTime() - 864e5))}T00:00:00-05:00`, p_until: `${limaDay(new Date(day.getTime() + 864e5))}T23:59:59.999-05:00` })
      if (error) throw error
      const item = ((queue || []) as Item[]).find(i => i.id === dispatchId)
      if (!item) { setData('missing'); return }
      const [types, rows, checks] = await Promise.all([
        fetchServiceTypes(supabase, item.stops.map(s => s.request_id)),
        supabase.rpc('delivery_tracking_rows', { p_dispatches: [dispatchId] }),
        supabase.rpc('get_settlement_checklists', { p_dispatches: [dispatchId] }),
      ])
      if (rows.error) throw rows.error
      if (checks.error) throw checks.error
      setData({ item, types, deliveries: (rows.data || []) as DeliveryRow[],
        checklists: new Map(((checks.data || []) as (Checklist & { request_id: string })[]).map(c => [c.request_id, c])) })
    } catch (e) { toast.error('No se pudo cargar la documentación del viaje: ' + errorMessage(e)); setData('missing') }
  }, [supabase, dispatchId])
  useEffect(() => { const t = window.setTimeout(() => void load(), 0); return () => window.clearTimeout(t) }, [load])

  if (!data || !isLoaded) return <p role="status" className="py-6 text-center text-sm text-slate-500">Cargando documentación…</p>
  if (data === 'missing') return <p className="py-6 text-center text-sm text-slate-500">La documentación de este viaje no está disponible.</p>
  const { item, types, deliveries, checklists } = data
  // Mismas reglas que la bandeja (DocumentaryQueue)
  const canNumbers = canWrite('documentario')
  const canManual = ['admin', 'jefe de distribución', 'supervisor de transporte'].includes(role) || (role.includes('despach') && role !== 'auditor de despacho')
  const packingOnly = !canRead('documentario') && (canRead('packing-list') || canRead('planificacion'))
  const canSettle = (canNumbers || canManual) && !packingOnly && !NOT_SETTLEABLE.includes(item.status)
  const changed = async () => { await load(); onChanged?.() }
  const openDoc = async (path: string) => {
    const url = await receiptUrl(supabase, `${DOCS_BUCKET}/${path}`)
    if (url) window.open(url, '_blank', 'noopener')
    else toast.error('No se pudo abrir el documento')
  }
  return <>
    <GuidesClosureTab dispatchId={item.id} executed={!['PROGRAMADO', 'CANCELADO'].includes(item.status)} canUpload={canNumbers && canSettle} canManual={canManual && canSettle}
      // shortcut: anular un documento sigue en la bandeja de Documentos (pide la causa); traerlo si se retira la bandeja
      canVoid={false} onVoid={() => undefined}
      stops={item.stops.map(s => ({ request_id: s.request_id, ot: s.ot_code ? `OT ${s.ot_code}` : referenceLabel(types.get(s.request_id)) || 'Sin referencia',
        request_number: s.request_number, client: s.client, kind: checklists.get(s.request_id)?.kind || settlementKind(types.get(s.request_id), item.is_pickup),
        checklist: checklists.get(s.request_id) }))}
      documents={item.documents} numberRefs={item.number_references || []} deliveries={deliveries}
      linking={<DocumentNumberLinks dispatchId={item.id} services={item.stops.map(stop => ({ ...stop, order_reference: referenceLabel(types.get(stop.request_id)) }))}
        known={knownNumbers(item, deliveries)} canEdit={canNumbers && item.status !== 'CANCELADO'} onChanged={changed} />}
      showLinking={linking} onToggleLinking={() => setLinking(v => !v)}
      onOpen={path => void openDoc(path)} onEvidence={setReview} onChanged={changed} />
    <DeliveryReview row={review} onClose={() => setReview(null)} onChanged={() => void changed()} />
  </>
}
