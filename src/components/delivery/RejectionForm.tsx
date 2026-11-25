'use client'

import { useEffect, useState } from 'react'
import { Camera, Loader2, X } from 'lucide-react'
import { deliveryPhoto, REJECTION_REASONS } from '@/lib/delivery'

export type MissingLine = { descripcion: string; cantidad: number; unidad: string }
export type RejectionDraft = { operation: string; kind: 'TOTAL' | 'PARCIAL'; reason: string; note: string; files: File[]; lines: MissingLine[] }

// «Rechazada en destino»: el conductor registra lo que pasó con motivo y fotos. El total cierra la parada sin guía y
// avisa a Despacho; el parcial acompaña a la guía de lo que sí se entregó. Siempre pide confirmación antes de enviar.
export function RejectionForm({ busy, onSubmit, onCancel }: { busy?: boolean; onSubmit: (draft: RejectionDraft) => Promise<void>; onCancel: () => void }) {
  const [kind, setKind] = useState<'TOTAL' | 'PARCIAL'>('TOTAL')
  const [reason, setReason] = useState('')
  const [note, setNote] = useState('')
  const [lines, setLines] = useState<{ descripcion: string; cantidad: string; unidad: string }[]>([{ descripcion: '', cantidad: '', unidad: 'UND' }])
  const [files, setFiles] = useState<File[]>([])
  const [previews, setPreviews] = useState<string[]>([])
  const [confirming, setConfirming] = useState(false)
  const [preparing, setPreparing] = useState(false)
  const [error, setError] = useState('')
  const [operation, setOperation] = useState(() => crypto.randomUUID())
  useEffect(() => {
    const urls = files.map(file => URL.createObjectURL(file))
    const timer = window.setTimeout(() => setPreviews(urls), 0)
    return () => { window.clearTimeout(timer); urls.forEach(url => URL.revokeObjectURL(url)) }
  }, [files])
  const changed = () => { setOperation(crypto.randomUUID()); setConfirming(false); setError('') }
  const add = (incoming: FileList | null) => {
    if (!incoming) return
    if (files.length + incoming.length > 5) { setError('Se permiten hasta cinco fotos.'); return }
    setFiles([...files, ...Array.from(incoming)]); changed()
  }
  const working = busy || preparing
  const validLines = lines.filter(l => l.descripcion.trim().length >= 2 && Number(l.cantidad) > 0).map(l => ({ descripcion: l.descripcion.trim(), cantidad: Number(l.cantidad), unidad: l.unidad.trim() }))
  const validate = () => {
    if (!reason) return 'Seleccione el motivo del rechazo.'
    if (kind === 'PARCIAL' && (!validLines.length || validLines.length !== lines.filter(l => l.descripcion.trim() || l.cantidad).length)) return 'Indique cada producto no entregado con su cantidad.'
    if ((reason === 'OTRO' || kind === 'PARCIAL') && note.trim().length < 5) return kind === 'PARCIAL' ? 'Detalle qué se rechazó (producto y cantidad).' : 'Detalle el motivo del rechazo.'
    if (!files.length) return 'Adjunte al menos una foto (mercadería, local o documento).'
    return ''
  }
  const send = async () => {
    setPreparing(true); setError('')
    try {
      const photos = await Promise.all(files.map(deliveryPhoto))
      if (photos.reduce((sum, photo) => sum + photo.size, 0) > 4 * 1024 * 1024) throw new Error('Las fotos superan 4 MB. Reduzca la cantidad o resolución.')
      await onSubmit({ operation, kind, reason, note: note.trim(), files: photos, lines: kind === 'PARCIAL' ? validLines : [] })
    } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo registrar el rechazo.'); setConfirming(false) }
    finally { setPreparing(false) }
  }
  return <div className="space-y-3 rounded-xl border border-red-200 bg-red-50/60 p-3">
    <p className="text-sm font-semibold text-red-900">Rechazada en destino</p>
    <div role="radiogroup" aria-label="Tipo de rechazo" className="grid grid-cols-2 gap-2">
      {([['TOTAL', 'Rechazo total', 'No recibió nada'], ['PARCIAL', 'Rechazo parcial', 'Recibió una parte']] as const).map(([value, label, hint]) =>
        <button key={value} type="button" role="radio" aria-checked={kind === value} disabled={working} onClick={() => { setKind(value); changed() }}
          className={`min-h-12 rounded-lg border p-2 text-left text-sm ${kind === value ? 'border-red-500 bg-white font-semibold text-red-900 ring-2 ring-red-200' : 'border-slate-200 bg-white text-slate-700'}`}>
          {label}<span className="block text-xs font-normal text-slate-500">{hint}</span></button>)}
    </div>
    <label className="block text-sm">Motivo *<select value={reason} disabled={working} onChange={e => { setReason(e.target.value); changed() }} className="mt-1 w-full rounded-lg border bg-white p-3">
      <option value="">Seleccione…</option>{REJECTION_REASONS.map(r => <option key={r.code} value={r.code}>{r.label}</option>)}
    </select></label>
    {kind === 'PARCIAL' && <fieldset className="space-y-2"><legend className="text-sm">Productos no entregados *</legend>
      {lines.map((l, i) => <div key={i} className="grid grid-cols-[1fr_5rem_4rem_auto] gap-1">
        <input aria-label={`Producto ${i + 1}`} placeholder="Producto" value={l.descripcion} disabled={working} onChange={e => { setLines(lines.map((x, j) => j === i ? { ...x, descripcion: e.target.value } : x)); changed() }} className="min-h-11 rounded-lg border bg-white px-2 text-sm" />
        <input aria-label={`Cantidad ${i + 1}`} placeholder="Cant." type="number" min="0" step="any" inputMode="decimal" value={l.cantidad} disabled={working} onChange={e => { setLines(lines.map((x, j) => j === i ? { ...x, cantidad: e.target.value } : x)); changed() }} className="min-h-11 rounded-lg border bg-white px-2 text-sm" />
        <input aria-label={`Unidad ${i + 1}`} value={l.unidad} disabled={working} onChange={e => { setLines(lines.map((x, j) => j === i ? { ...x, unidad: e.target.value } : x)); changed() }} className="min-h-11 rounded-lg border bg-white px-2 text-sm" />
        <button type="button" aria-label={`Quitar producto ${i + 1}`} disabled={working || lines.length === 1} onClick={() => { setLines(lines.filter((_, j) => j !== i)); changed() }} className="min-h-11 rounded-lg border bg-white px-2"><X className="h-4 w-4" /></button>
      </div>)}
      {lines.length < 30 && <button type="button" disabled={working} onClick={() => setLines([...lines, { descripcion: '', cantidad: '', unidad: 'UND' }])} className="min-h-11 rounded-lg border bg-white px-3 text-sm">+ Otro producto</button>}
    </fieldset>}
    <label className="block text-sm">{kind === 'PARCIAL' ? 'Qué se rechazó (producto y cantidad) *' : reason === 'OTRO' ? 'Detalle del motivo *' : 'Detalle (opcional)'}
      <textarea maxLength={1000} value={note} disabled={working} onChange={e => { setNote(e.target.value); changed() }} className="mt-1 w-full rounded-lg border bg-white p-3" rows={2} /></label>
    <div className="space-y-2">
      <p className="text-sm">Fotos del rechazo * <span className="text-xs text-slate-500">mercadería, local cerrado o documento (hasta 5)</span></p>
      <div className="flex flex-wrap gap-2">
        <label className="cursor-pointer rounded-lg border bg-white p-3 text-sm"><Camera className="mr-1 inline h-4 w-4" />Tomar foto<input disabled={working} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="sr-only" onChange={e => { add(e.target.files); e.target.value = '' }} /></label>
        <label className="cursor-pointer rounded-lg border bg-white p-3 text-sm">Elegir fotos<input disabled={working} type="file" multiple accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={e => { add(e.target.files); e.target.value = '' }} /></label>
      </div>
      <div className="flex flex-wrap gap-2">{previews.map((url, index) => <div key={url} className="relative">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={url} alt={`Rechazo, foto ${index + 1}`} className="h-24 w-24 rounded-lg object-cover" />
        <button type="button" disabled={working} aria-label={`Quitar foto ${index + 1}`} className="absolute -right-1 -top-1 rounded-full bg-white p-2 shadow" onClick={() => { setFiles(files.filter((_, i) => i !== index)); changed() }}><X className="h-4 w-4" /></button>
      </div>)}</div>
    </div>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    {confirming ? <div className="space-y-2 rounded-lg border border-red-300 bg-white p-3 text-sm text-red-900">
      <p className="font-semibold">{kind === 'TOTAL' ? '¿Confirmas que el cliente no recibió la entrega?' : '¿Confirmas el rechazo parcial?'}</p>
      <p className="text-xs text-slate-600">{kind === 'TOTAL'
        ? 'Se avisará a Despacho y al Supervisor de Transporte, la parada quedará como rechazada y seguirás con la siguiente. Despacho decide si se reprograma o se anula.'
        : 'Se avisará a Despacho. Después envía la guía firmada de lo que sí se entregó.'}</p>
      <div className="flex gap-2"><button type="button" disabled={working} onClick={() => setConfirming(false)} className="min-h-11 rounded-lg border px-3">Volver</button>
        <button type="button" disabled={working} onClick={() => void send()} className="flex min-h-11 flex-1 items-center justify-center gap-2 rounded-lg bg-red-700 px-3 font-bold text-white disabled:opacity-60">{working && <Loader2 className="h-4 w-4 animate-spin" />}Sí, registrar rechazo</button></div>
    </div> : <div className="flex gap-2">
      <button type="button" disabled={working} onClick={onCancel} className="min-h-11 rounded-lg border bg-white px-3 text-sm">Cancelar</button>
      <button type="button" disabled={working} onClick={() => { const message = validate(); if (message) setError(message); else setConfirming(true) }} className="min-h-11 flex-1 rounded-lg border border-red-400 bg-white px-3 text-sm font-semibold text-red-800">Continuar</button>
    </div>}
  </div>
}
