'use client'

import { useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { Modal } from '@/components/ui/modal'
import { createClient } from '@/lib/supabase/client'
import { arrivalSourceLabel, conformityLabels, deliveryTime, type DeliveryDetail, type DeliveryRow } from '@/lib/delivery'

export type DeliveryReviewTarget = Pick<DeliveryRow, 'dispatch_id' | 'request_id' | 'ot_code' | 'request_number' | 'plate' | 'delivery_address'>

export function DeliveryReview({ row, onClose, onChanged }: { row: DeliveryReviewTarget | null; onClose: () => void; onChanged: () => void }) {
  const supabase = useMemo(() => createClient(), [])
  const [detail, setDetail] = useState<DeliveryDetail | null>(null), [urls, setUrls] = useState<Record<string, string>>({})
  const [reason, setReason] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const [version, setVersion] = useState(0)
  const [decision, setDecision] = useState<'REPROGRAMAR' | 'ANULAR'>('REPROGRAMAR'), [decisionReason, setDecisionReason] = useState(''), [newDate, setNewDate] = useState('')
  const decide = async () => {
    if (!row || busy) return
    if (decisionReason.trim().length < 10) { toast.error('Indique el motivo de la decisión (mínimo 10 caracteres)'); return }
    if (decision === 'REPROGRAMAR' && !newDate) { toast.error('Indique la nueva fecha y hora de atención'); return }
    setBusy(true)
    try {
      const { error } = await supabase.rpc('delivery_rejection_decide', { p_dispatch: row.dispatch_id, p_request: row.request_id, p_decision: decision,
        p_reason: decisionReason.trim(), p_required_at: decision === 'REPROGRAMAR' ? new Date(`${newDate}:00-05:00`).toISOString() : null, p_delivery_zone: null })
      if (error) throw error
      toast.success(decision === 'REPROGRAMAR' ? 'Solicitud reprogramada: vuelve a Despacho para armar una nueva ruta' : 'Solicitud anulada')
      setDecisionReason(''); setNewDate(''); onChanged(); setVersion(v => v + 1)
    } catch (e) { toast.error(e && typeof e === 'object' && 'message' in e ? String(e.message) : 'No se pudo registrar la decisión') }
    finally { setBusy(false) }
  }
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
      for (const path of [...value.submissions.flatMap(submission => [...submission.photos, ...(submission.packing_photos || [])]), ...(value.rejection?.photos || [])]) {
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
      {detail.arrived_at && <p className="text-xs text-slate-600">Llegada {deliveryTime(detail.arrived_at)} · {arrivalSourceLabel(detail.arrival_source)}{detail.arrival_accuracy_m != null ? ` · GPS ±${Math.round(detail.arrival_accuracy_m)} m` : ''}</p>}
      {detail.rejection && <section className="space-y-2 rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
        <p className="font-semibold">{detail.rejection.kind === 'TOTAL' ? 'Entrega rechazada en destino (total)' : 'Rechazo parcial en destino'} · {deliveryTime(detail.rejection.captured_at)}</p>
        <p>{detail.rejection.reason}{detail.rejection.note ? ` · ${detail.rejection.note}` : ''}</p>
        {detail.rejection.latitude != null && detail.rejection.longitude != null && <a className="text-xs font-semibold text-blue-700 underline" target="_blank" rel="noreferrer" href={`https://www.google.com/maps?q=${detail.rejection.latitude},${detail.rejection.longitude}`}>Ver ubicación del registro{detail.rejection.accuracy_m != null ? ` (±${Math.round(detail.rejection.accuracy_m)} m)` : ''}</a>}
        <div className="flex flex-wrap gap-2">{detail.rejection.photos.map(photo => urls[photo] ? <a key={photo} href={urls[photo]} target="_blank" rel="noreferrer" className="block h-28 w-40 overflow-hidden rounded-lg border bg-white">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={urls[photo]} alt="Evidencia del rechazo; abrir imagen completa" className="h-full w-full object-contain" /></a> : <span key={photo} className="rounded border bg-white p-3 text-slate-500">Fotografía no disponible</span>)}</div>
        {detail.rejection.kind === 'TOTAL' && (detail.rejection.decision
          ? <p className="rounded-lg bg-white p-2">Decisión: {detail.rejection.decision === 'REPROGRAMADA' ? `reprogramada${detail.rejection.required_date ? ` para el ${detail.rejection.required_date.split('-').reverse().join('/')}` : ''}` : 'anulada'} · {detail.rejection.decision_reason}{detail.rejection.decided_by ? ` · ${detail.rejection.decided_by}` : ''}{detail.rejection.decided_at ? ` · ${deliveryTime(detail.rejection.decided_at)}` : ''}</p>
          : detail.can_decide ? <div className="space-y-2 rounded-lg bg-white p-3 text-slate-800">
            <p className="font-semibold">Decisión de Despacho</p>
            <div className="flex flex-wrap gap-2">{(['REPROGRAMAR', 'ANULAR'] as const).map(value => <label key={value} className={`flex min-h-10 items-center gap-2 rounded-lg border px-3 ${decision === value ? 'border-[#002855] bg-blue-50 font-semibold' : ''}`}>
              <input type="radio" name="rejection-decision" checked={decision === value} onChange={() => setDecision(value)} />{value === 'REPROGRAMAR' ? 'Reprogramar' : 'Anular servicio'}</label>)}</div>
            {decision === 'REPROGRAMAR' && <label className="block">Nueva fecha y hora de atención<input type="datetime-local" value={newDate} onChange={e => setNewDate(e.target.value)} className="mt-1 w-full rounded-lg border p-2" /></label>}
            <label className="block">Motivo *<textarea value={decisionReason} onChange={e => setDecisionReason(e.target.value)} maxLength={500} className="mt-1 min-h-16 w-full rounded-lg border p-2" placeholder="Obligatorio (mínimo 10 caracteres)" /></label>
            <button type="button" disabled={busy} onClick={() => void decide()} className="min-h-11 rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white disabled:opacity-50">Registrar decisión</button>
            <p className="text-xs text-slate-500">El flete de este viaje se consume igual. Al reprogramar, la solicitud vuelve a Despacho para una nueva ruta.</p>
          </div> : <p className="text-xs">Pendiente de la decisión de Despacho o del Supervisor de Transporte (reprogramar o anular).</p>)}
      </section>}
      {detail.state !== 'RECHAZO_DESTINO' && <p className="rounded-lg bg-amber-50 p-3 text-sm text-amber-900">{detail.state === 'NO_APLICA' ? 'Recojo por cliente: este servicio sigue el circuito de nota de salida.' : 'La guía debe ser aprobada por el Supervisor de Transporte para habilitar el avance del servicio.'}</p>}
      {!detail.submissions.length && !['NO_APLICA', 'RECHAZO_DESTINO'].includes(detail.state) && <p className="text-sm text-slate-500">Todavía no se ha recibido la guía de entrega.</p>}
      {detail.submissions.map((submission, i) => <article key={submission.id} className="space-y-2 rounded-xl border p-4">
        <p className="font-semibold">{i === 0 ? 'Sustento actual' : 'Versión anterior'} · {deliveryTime(submission.submitted_at)}</p>
        <p className="text-sm">Guía: {submission.guide_number || 'Sin número vinculado'} · Recibió: {submission.received_by || 'Sin nombre registrado'} · {submission.source === 'APP' ? 'App del conductor' : submission.source === 'WEB' && submission.note?.startsWith('Cargada por Documentos') ? 'Documentos (liquidación)' : submission.source === 'ENLACE' ? 'Portal del proveedor' : 'Registro anterior'}</p>
        {submission.note && <p className="whitespace-pre-wrap text-sm">{submission.note}</p>}
        <div className="flex flex-wrap gap-2">{submission.photos.map(photo => urls[photo] && /\.pdf$/i.test(photo) ? <a key={photo} href={urls[photo]} target="_blank" rel="noreferrer" className="grid h-28 w-40 place-items-center rounded-lg border bg-red-50 text-sm font-semibold text-red-800">Abrir guía (PDF)</a> : urls[photo] ? <a key={photo} href={urls[photo]} target="_blank" rel="noreferrer" className="block h-28 w-40 overflow-hidden rounded-lg border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={urls[photo]} alt="Guía de entrega; abrir imagen completa" className="h-full w-full object-contain" /></a> : <span key={photo} className="rounded border p-3 text-sm text-slate-500">Fotografía no disponible</span>)}</div>
        {(submission.packing_photos || []).length > 0 && <><p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Packing List</p>
        <div className="flex flex-wrap gap-2">{(submission.packing_photos || []).map(photo => urls[photo] ? <a key={photo} href={urls[photo]} target="_blank" rel="noreferrer" className="block h-28 w-40 overflow-hidden rounded-lg border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={urls[photo]} alt="Packing List; abrir imagen completa" className="h-full w-full object-contain" /></a> : <span key={photo} className="rounded border p-3 text-sm text-slate-500">Fotografía no disponible</span>)}</div></>}
        {submission.review && <p className="rounded-lg bg-slate-50 p-2 text-sm">{submission.review.decision} · {deliveryTime(submission.review.reviewed_at)}{submission.review.reason && ` · ${submission.review.reason}`}</p>}
      </article>)}
      {detail.can_review && detail.state === 'RECIBIDA' && <div className="space-y-3 border-t pt-4">
        <label className="block text-sm font-semibold">Motivo / comentario<textarea value={reason} onChange={e => setReason(e.target.value)} maxLength={1000} className="mt-1 min-h-20 w-full rounded-lg border p-2" placeholder="Obligatorio para observar o rechazar" /></label>
        <div className="flex flex-wrap gap-2"><button type="button" disabled={busy || !detail.submissions[0]?.photos.every(p => !!urls[p])} onClick={() => void review('VALIDADA')} className="min-h-11 rounded-lg bg-emerald-700 px-4 text-sm font-semibold text-white disabled:opacity-50">Aprobar conformidad</button><button type="button" disabled={busy} onClick={() => void review('OBSERVADA')} className="min-h-11 rounded-lg border border-amber-400 px-4 text-sm font-semibold text-amber-900 disabled:opacity-50">Observar</button><button type="button" disabled={busy} onClick={() => void review('RECHAZADA')} className="min-h-11 rounded-lg border border-red-300 px-4 text-sm font-semibold text-red-800 disabled:opacity-50">Rechazar</button></div>
      </div>}
      {!detail.can_review && !['NO_APLICA', 'RECHAZO_DESTINO'].includes(detail.state) && <p className="text-sm text-slate-500">La revisión corresponde al Supervisor de Transporte de la sede.</p>}
    </div>}
  </Modal>
}
