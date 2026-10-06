'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { createClient } from '@/lib/supabase/client'
import { conformityLabels, deliveryTime, type DeliveryDetail, type DeliveryRow } from '@/lib/delivery'

export type DeliveryReviewTarget = Pick<DeliveryRow, 'dispatch_id' | 'request_id' | 'ot_code' | 'request_number' | 'plate' | 'delivery_address'>

export function DeliveryReview({ row, onClose, onChanged }: { row: DeliveryReviewTarget | null; onClose: () => void; onChanged: () => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [detail, setDetail] = useState<DeliveryDetail | null>(null), [urls, setUrls] = useState<Record<string, string>>({})
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [version, setVersion] = useState(0)
  useEffect(() => {
    if (!row) return
    let cancelled = false
    const timer = window.setTimeout(() => {
      setDetail(null); setUrls({}); setReason(''); setError('')
      void (async () => {
      const { data, error } = await supabase.rpc('delivery_get', { p_dispatch: row.dispatch_id, p_request: row.request_id })
      if (cancelled) return
      if (error) { setError(error.message); return }
      const value = data as DeliveryDetail
      setDetail(value)
      const signed: Record<string, string> = {}
      for (const submission of value.submissions) for (const path of submission.photos) {
        const { data } = await supabase.storage.from('driver_evidence').createSignedUrl(path, 300)
        if (data?.signedUrl) signed[path] = data.signedUrl
      }
      if (!cancelled) setUrls(signed)
    })().catch(e => { if (!cancelled) setError(e instanceof Error ? e.message : 'No se pudieron cargar las evidencias') })
    }, 0)
    return () => { cancelled = true; window.clearTimeout(timer) }
  }, [row, supabase, version])
  const review = async (decision: 'VALIDADA' | 'OBSERVADA' | 'RECHAZADA') => {
    const submission = detail?.submissions[0]
    if (!row || !submission || busy) return
    if (decision !== 'VALIDADA' && !reason.trim()) { toast.error('Indique el motivo de la observación o rechazo'); return }
    setBusy(true)
    try {
      const { error } = await supabase.rpc('delivery_review', { p_dispatch: row.dispatch_id, p_request: row.request_id,
        p_submission: submission.id, p_decision: decision, p_reason: reason.trim() || null })
      if (error) throw error
      toast.success(decision === 'VALIDADA' ? 'Conformidad aprobada; avance habilitado' : 'Corrección habilitada para el transportista')
      onChanged(); setVersion(v => v + 1)
    } catch (e) { toast.error(e && typeof e === 'object' && 'message' in e ? String(e.message) : 'No se pudo validar'); setVersion(v => v + 1) }
    finally { setBusy(false) }
  }
  return <Modal isOpen={!!row} onClose={onClose} title={`Conformidad · ${row?.ot_code || ''} · ${row?.request_number || ''}`} maxWidth="max-w-3xl">
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-red-800">{error}</p>}
    {!detail && !error && <p className="p-6 text-center">Cargando evidencias…</p>}
    {detail && <div className="space-y-4">
      <p className="text-sm">{row?.plate} · {row?.delivery_address}</p>
      <p className="font-semibold">{conformityLabels[detail.state]}</p>
      <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{detail.state === 'NO_APLICA' ? 'Recojo por cliente: este servicio sigue el circuito de nota de salida.' : 'La guía debe ser aprobada por el Supervisor de Transporte para habilitar el avance del servicio.'}</p>
      {!detail.submissions.length && detail.state !== 'NO_APLICA' && <p className="text-sm text-slate-500">Todavía no se ha recibido la guía de entrega.</p>}
      {detail.submissions.map((submission, i) => <article key={submission.id} className="space-y-2 rounded-xl border p-4">
        <p className="font-semibold">{i === 0 ? 'Sustento actual' : 'Versión anterior'} · {deliveryTime(submission.submitted_at)}</p>
        <p className="text-sm">Guía: {submission.guide_number || 'Sin número vinculado'} · Recibió: {submission.received_by || 'Sin nombre registrado'} · {submission.source === 'APP' ? 'App del conductor' : submission.source === 'ENLACE' ? 'Portal del proveedor' : 'Registro anterior'}</p>
        {submission.note && <p className="whitespace-pre-wrap text-sm">{submission.note}</p>}
        <div className="flex flex-wrap gap-2">{submission.photos.map(photo => urls[photo] ? <a key={photo} href={urls[photo]} target="_blank" rel="noreferrer" className="block h-28 w-40 overflow-hidden rounded-lg border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={urls[photo]} alt="Guía de entrega; abrir imagen completa" className="h-full w-full object-contain" /></a> : <span key={photo} className="rounded border p-3 text-sm text-slate-500">Fotografía no disponible</span>)}</div>
        {submission.review && <p className="rounded-lg bg-slate-50 p-2 text-sm">{submission.review.decision} · {deliveryTime(submission.review.reviewed_at)}{submission.review.reason && ` · ${submission.review.reason}`}</p>}
      </article>)}
      {detail.can_review && detail.state === 'RECIBIDA' && <div className="space-y-3 border-t pt-4">
        <label className="block text-sm font-semibold">Motivo / comentario<textarea value={reason} onChange={e => setReason(e.target.value)} maxLength={1000} className="mt-1 min-h-20 w-full rounded-lg border p-2" placeholder="Obligatorio para observar o rechazar" /></label>
        <div className="flex flex-wrap gap-2"><button type="button" disabled={busy || !detail.submissions[0]?.photos.every(p => !!urls[p])} onClick={() => void review('VALIDADA')} className="min-h-11 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white disabled:opacity-50">Aprobar conformidad</button><button type="button" disabled={busy} onClick={() => void review('OBSERVADA')} className="min-h-11 rounded-lg border border-amber-400 px-4 text-sm font-semibold text-amber-900 disabled:opacity-50">Observar</button><button type="button" disabled={busy} onClick={() => void review('RECHAZADA')} className="min-h-11 rounded-lg border border-red-300 px-4 text-sm font-semibold text-red-800 disabled:opacity-50">Rechazar</button></div>
      </div>}
      {!detail.can_review && detail.state !== 'NO_APLICA' && <p className="text-sm text-slate-500">La revisión corresponde al Supervisor de Transporte de la sede.</p>}
    </div>}
  </Modal>
}
