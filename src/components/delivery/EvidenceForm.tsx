'use client'

import { useEffect, useState } from 'react'
import { Camera, Loader2, X } from 'lucide-react'
import { deliveryPhoto } from '@/lib/delivery'

export type EvidenceDraft = { operation: string; capturedAt: string; files: File[]; packingFiles: File[]; receiver: string; guide: string; note: string }
export function EvidenceForm({ busy, guide: initialGuide = '', onSubmit, onCancel }: {
  busy?: boolean; guide?: string; onSubmit: (draft: EvidenceDraft) => Promise<void>; onCancel?: () => void
}) {
  const [files, setFiles] = useState<File[]>([])
  const [packing, setPacking] = useState<File[]>([])
  const [receiver, setReceiver] = useState('')
  const [guide, setGuide] = useState(initialGuide)
  const [note, setNote] = useState('')
  const [error, setError] = useState('')
  const [preparing, setPreparing] = useState(false)
  const [operation, setOperation] = useState(() => crypto.randomUUID())
  const [previews, setPreviews] = useState<string[]>([])
  const [packingPreviews, setPackingPreviews] = useState<string[]>([])
  useEffect(() => {
    const urls = files.map(file => URL.createObjectURL(file))
    const timer = window.setTimeout(() => setPreviews(urls), 0)
    return () => { window.clearTimeout(timer); urls.forEach(url => URL.revokeObjectURL(url)) }
  }, [files])
  useEffect(() => {
    const urls = packing.map(file => URL.createObjectURL(file))
    const timer = window.setTimeout(() => setPackingPreviews(urls), 0)
    return () => { window.clearTimeout(timer); urls.forEach(url => URL.revokeObjectURL(url)) }
  }, [packing])
  const add = (incoming: FileList | null) => {
    if (!incoming) return
    if (files.length + incoming.length > 5) { setError('Se permiten hasta cinco fotos de la guía.'); return }
    setFiles([...files, ...Array.from(incoming)]); setOperation(crypto.randomUUID()); setError('')
  }
  const addPacking = (incoming: FileList | null) => {
    if (!incoming) return
    if (packing.length + incoming.length > 5) { setError('Se permiten hasta cinco fotos del Packing List.'); return }
    setPacking([...packing, ...Array.from(incoming)]); setOperation(crypto.randomUUID()); setError('')
  }
  const busyAll = busy || preparing
  const photoPicker = (onAdd: (list: FileList | null) => void) => <div className="flex flex-wrap gap-2">
    <label className="cursor-pointer rounded-lg border bg-white p-3 text-sm"><Camera className="mr-1 inline h-4 w-4" />Tomar foto<input disabled={busyAll} type="file" accept="image/jpeg,image/png,image/webp" capture="environment" className="sr-only" onChange={e => { onAdd(e.target.files); e.target.value = '' }} /></label>
    <label className="cursor-pointer rounded-lg border bg-white p-3 text-sm">Elegir fotos<input disabled={busyAll} type="file" multiple accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={e => { onAdd(e.target.files); e.target.value = '' }} /></label>
  </div>
  const thumbs = (urls: string[], label: string, remove: (index: number) => void) => <div className="flex flex-wrap gap-2">{urls.map((url, index) => <div key={url} className="relative">
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img src={url} alt={`${label}, foto ${index + 1}`} className="h-24 w-24 rounded-lg object-cover" />
    <button type="button" disabled={busyAll} aria-label={`Quitar foto ${index + 1} de ${label}`} className="absolute -right-1 -top-1 rounded-full bg-white p-2 shadow" onClick={() => { remove(index); setOperation(crypto.randomUUID()) }}><X className="h-4 w-4" /></button>
  </div>)}</div>
  return <form className="space-y-3 rounded-xl border bg-slate-50 p-3" onSubmit={async e => {
    e.preventDefault(); setError(''); setPreparing(true)
    try {
      if (!files.length) throw new Error('Adjunte la foto de la guía firmada.')
      if (!receiver.trim()) throw new Error('Indique quién recibió la entrega.')
      if (!guide.trim()) throw new Error('Indique el número de la guía de remisión.')
      const photos = await Promise.all(files.map(deliveryPhoto))
      const packingPhotos = await Promise.all(packing.map(deliveryPhoto))
      if ([...photos, ...packingPhotos].reduce((sum, photo) => sum + photo.size, 0) > 4 * 1024 * 1024) throw new Error('Las fotos superan 4 MB. Reduzca la cantidad o resolución.')
      await onSubmit({ operation, capturedAt: new Date().toISOString(), files: photos, packingFiles: packingPhotos, receiver, guide, note })
    } catch (err) { setError(err instanceof Error ? err.message : 'No se pudo enviar la guía.') }
    finally { setPreparing(false) }
  }}>
    <p className="text-sm font-semibold text-[#002855]">Guía de remisión firmada · obligatoria</p>
    {photoPicker(add)}
    {thumbs(previews, 'Guía', index => setFiles(files.filter((_, i) => i !== index)))}
    <div className="space-y-2 border-t pt-3">
      <p className="text-sm font-semibold text-[#002855]">Packing List · si el servicio lo tiene</p>
      {photoPicker(addPacking)}
      {thumbs(packingPreviews, 'Packing List', index => setPacking(packing.filter((_, i) => i !== index)))}
    </div>
    <label className="block text-sm">Nombre de quien recibió<input required maxLength={120} value={receiver} onChange={e => { setReceiver(e.target.value); setOperation(crypto.randomUUID()) }} className="mt-1 w-full rounded-lg border bg-white p-3" /></label>
    <label className="block text-sm">Número de guía *<input required maxLength={80} value={guide} onChange={e => { setGuide(e.target.value); setOperation(crypto.randomUUID()) }} className="mt-1 w-full rounded-lg border bg-white p-3" /></label>
    <label className="block text-sm">Observación<textarea maxLength={1000} value={note} onChange={e => { setNote(e.target.value); setOperation(crypto.randomUUID()) }} className="mt-1 w-full rounded-lg border bg-white p-3" rows={2} /></label>
    {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
    <div className="flex gap-2">{onCancel && <button type="button" disabled={busy || preparing} onClick={onCancel} className="rounded-lg border p-3 text-sm">Cancelar</button>}
      <button disabled={busy || preparing} className="flex min-h-12 flex-1 items-center justify-center gap-2 rounded-lg bg-[#002855] px-3 font-bold text-white disabled:opacity-60">{(busy || preparing) && <Loader2 className="h-4 w-4 animate-spin" />}Enviar guía para validación</button>
    </div>
    <p className="text-xs text-slate-500">Adjunta hasta cinco fotos legibles de la guía completa (con firma o sello de recepción) y, si corresponde, hasta cinco del Packing List. El servicio no avanza hasta que el Supervisor de Transporte apruebe la guía.</p>
  </form>
}
