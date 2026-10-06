'use client'

import { useEffect, useRef } from 'react'
import { type SignaturePoint } from '@/lib/preuse'

export function PreuseSignature({ value, onChange, disabled = false }: { value: SignaturePoint[][]; onChange: (value: SignaturePoint[][]) => void; disabled?: boolean }) {
  const canvas = useRef<HTMLCanvasElement>(null)
  const active = useRef<SignaturePoint[] | null>(null)
  useEffect(() => {
    const context = canvas.current?.getContext('2d'); if (!context) return
    context.clearRect(0, 0, 600, 180); context.strokeStyle = '#002855'; context.lineWidth = 2.5; context.lineCap = 'round'
    for (const stroke of value) { context.beginPath(); stroke.forEach((p,i) => i ? context.lineTo(p.x * 600, p.y * 180) : context.moveTo(p.x * 600, p.y * 180)); context.stroke() }
  }, [value])
  const point = (event: React.PointerEvent<HTMLCanvasElement>) => { const rect = event.currentTarget.getBoundingClientRect(); return { x: Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width)), y: Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height)) } }
  return <div className="space-y-2"><p className="text-sm font-semibold">Firma de quien inspecciona</p><canvas ref={canvas} width={600} height={180} aria-label="Firma de quien inspecciona" className="h-28 w-full touch-none rounded-lg border border-slate-300 bg-white"
    onPointerDown={e => { if (disabled) return; e.currentTarget.setPointerCapture(e.pointerId); active.current = [point(e)] }}
    onPointerMove={e => { if (!active.current || disabled || active.current.length >= 2000) return; active.current.push(point(e)); const context = canvas.current?.getContext('2d'); if (context) { const p = active.current.at(-2)!; const n = active.current.at(-1)!; context.beginPath(); context.moveTo(p.x * 600,p.y * 180); context.lineTo(n.x * 600,n.y * 180); context.stroke() } }}
    onPointerUp={() => { if (active.current && active.current.length >= 2) onChange([...value, active.current]); active.current = null }}
    onPointerCancel={() => { active.current = null }} /><button type="button" disabled={disabled} onClick={() => onChange([])} className="min-h-11 rounded-lg border border-slate-300 px-3 text-xs font-semibold">Limpiar firma</button></div>
}
