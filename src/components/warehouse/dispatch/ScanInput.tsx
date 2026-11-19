'use client'

import { FormEvent, useEffect, useRef, useState } from 'react'
import { Capacitor, registerPlugin } from '@capacitor/core'
import { Camera, ScanLine } from 'lucide-react'

const nativeWarehouseScanner = registerPlugin<{ scan: () => Promise<{ rawValue: string }> }>('WarehouseBarcodeScanner')
type BarcodeDetectorLike = { detect: (source: ImageBitmapSource) => Promise<Array<{ rawValue: string }>> }
type BarcodeDetectorConstructor = new (options: { formats: string[] }) => BarcodeDetectorLike

/** Identificación por lector de teclado, ingreso manual o cámara (a pedido, trasera, sin audio; se apaga tras leer, al cerrar
 * o al pasar a segundo plano; no graba ni envía video). Escanear solo identifica: no aprueba nada. */
// shortcut: copia la lógica de cámara de TaskWorkspace; unificar ambos cuando se toque el escaneo de picking.
export function ScanInput({ onCode, placeholder, disabled }: { onCode: (code: string) => void | Promise<void>; placeholder: string; disabled?: boolean }) {
  const [code, setCode] = useState('')
  const [camera, setCamera] = useState(false)
  const [error, setError] = useState('')
  const video = useRef<HTMLVideoElement>(null)
  const stream = useRef<MediaStream | null>(null)
  const last = useRef({ code: '', at: 0 })
  const stop = () => { stream.current?.getTracks().forEach(t => t.stop()); stream.current = null; setCamera(false) }
  useEffect(() => {
    const hide = () => { if (document.hidden) stop() }
    document.addEventListener('visibilitychange', hide)
    return () => { document.removeEventListener('visibilitychange', hide); stream.current?.getTracks().forEach(t => t.stop()) }
  }, [])
  // Evita registrar dos veces la misma lectura (doble toque o lector que repite)
  const emit = async (raw: string) => {
    const value = raw.trim(); const now = Date.now()
    if (!value || (last.current.code === value && now - last.current.at < 2000)) return
    last.current = { code: value, at: now }; setCode(''); await onCode(value)
  }
  const submit = (e: FormEvent) => { e.preventDefault(); void emit(code) }
  const start = async () => {
    setError('')
    if (Capacitor.isNativePlatform()) {
      try { await emit((await nativeWarehouseScanner.scan()).rawValue) }
      catch (e) { const text = e instanceof Error ? e.message : String(e); if (!/cancel/i.test(text)) setError(text) }
      return
    }
    try {
      const media = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' } }, audio: false })
      stream.current = media; setCamera(true)
      if (!video.current) throw new Error('No se pudo mostrar la cámara.')
      video.current.srcObject = media; await video.current.play()
      const Detector = (window as Window & { BarcodeDetector?: BarcodeDetectorConstructor }).BarcodeDetector
        ?? (await import('barcode-detector/ponyfill')).BarcodeDetector as unknown as BarcodeDetectorConstructor
      const detector = new Detector({ formats: ['code_128', 'qr_code', 'ean_13', 'ean_8'] })
      const loop = async () => {
        if (!video.current || !stream.current) return
        try { const found = await detector.detect(video.current); if (found?.[0]?.rawValue) { stop(); await emit(found[0].rawValue); return } } catch {}
        requestAnimationFrame(() => void loop())
      }
      requestAnimationFrame(() => void loop())
    } catch (e) {
      const name = e instanceof DOMException ? e.name : ''
      setError(name === 'NotAllowedError' ? 'Permiso de cámara denegado: habilítelo en el navegador o ingrese el código.' : name === 'NotFoundError' ? 'El equipo no tiene cámara: ingrese el código.'
        : name === 'NotReadableError' ? 'La cámara está ocupada por otra aplicación.' : e instanceof Error ? e.message : 'No se pudo activar la cámara.')
      stop()
    }
  }
  return <div className="space-y-2">
    <form onSubmit={submit} className="flex gap-2">
      <input value={code} onChange={e => setCode(e.target.value)} disabled={disabled} inputMode="text" autoComplete="off" placeholder={placeholder} aria-label={placeholder} className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2.5 text-base"/>
      <button disabled={disabled || !code.trim()} className="inline-flex items-center gap-1.5 rounded-lg bg-[#002855] px-3 py-2 text-sm font-bold text-white disabled:opacity-50"><ScanLine size={16}/><span className="hidden sm:inline">Buscar</span></button>
      <button type="button" disabled={disabled} aria-label={camera ? 'Cerrar cámara' : 'Escanear con cámara'} onClick={() => camera ? stop() : void start()} className="rounded-lg border border-slate-300 px-3 py-2"><Camera size={16}/></button>
    </form>
    {error && <p role="alert" className="text-sm text-rose-800">{error} <button type="button" onClick={() => void start()} className="font-semibold underline">Reintentar</button></p>}
    <video ref={video} playsInline muted className={camera ? 'max-h-64 w-full rounded-lg bg-black object-contain' : 'hidden'}/>
  </div>
}
