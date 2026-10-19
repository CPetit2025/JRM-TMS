'use client'

import { useSyncExternalStore } from 'react'
import type { AptAlmacen } from '@/lib/inventario/types'

// Ámbito del módulo: el APT en sus tres almacenes (647 · 540 · ST, la regla del APT anterior) o todas las bodegas del
// ERP para seguir un lote fuera del APT. Se recuerda en este navegador; sin almacenamiento disponible queda en APT.
export type Ambito = 'apt' | 'todas'
const KEY = 'inv:ambito'
const EVENT = 'inv:ambito'

function read(): Ambito {
  try { return localStorage.getItem(KEY) === 'todas' ? 'todas' : 'apt' } catch { return 'apt' }
}
function subscribe(cb: () => void) {
  window.addEventListener(EVENT, cb)
  window.addEventListener('storage', cb)
  return () => { window.removeEventListener(EVENT, cb); window.removeEventListener('storage', cb) }
}
export function setAmbito(a: Ambito) {
  try { localStorage.setItem(KEY, a) } catch { /* sin almacenamiento: solo esta vista */ }
  window.dispatchEvent(new Event(EVENT))
}
export const useAmbito = () => useSyncExternalStore(subscribe, read, () => 'apt' as Ambito)

// Misma regla que public.apt_almacen
export function aptAlmacen(bodega: string | null | undefined): AptAlmacen | null {
  const b = (bodega ?? '').trim().toUpperCase()
  if (/^647-04\s/.test(b)) return '647'
  if (/^540-04/.test(b)) return '540'
  if (/^ST-VENTAS/.test(b)) return 'ST'
  return null
}
export const ALMACENES: AptAlmacen[] = ['647', '540', 'ST']
export const ALMACEN_LABEL: Record<AptAlmacen, string> = { '647': '647 · ALM PT', '540': '540 · APT LB / MAT. CONFO', ST: 'ST · Ventas' }
export const ALMACEN_COLOR: Record<AptAlmacen, string> = { '647': '#002855', '540': '#2563eb', ST: '#0d9488' }

export function AmbitoSwitch() {
  const ambito = useAmbito()
  return (
    <div role="group" aria-label="Ámbito" className="flex rounded-lg border border-slate-300 p-0.5 text-xs font-semibold">
      {([['apt', 'APT 647 · 540 · ST'], ['todas', 'Todas las bodegas']] as const).map(([v, label]) => (
        <button key={v} type="button" aria-pressed={ambito === v} onClick={() => setAmbito(v)}
          className={`min-h-8 whitespace-nowrap rounded-md px-3 ${ambito === v ? 'bg-[#002855] text-white' : 'text-slate-600 hover:bg-slate-50'}`}>{label}</button>
      ))}
    </div>
  )
}

export function AlmacenTag({ almacen }: { almacen: AptAlmacen | null }) {
  if (!almacen) return null
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap rounded-full border border-slate-200 bg-white px-2 py-0.5 text-[10px] font-bold text-slate-600">
      <span className="h-2 w-2 rounded-full" style={{ background: ALMACEN_COLOR[almacen] }} />{almacen}
    </span>
  )
}

// Producto con su glosa (descripción) debajo del código
export function ProductoCell({ producto, glosa }: { producto: string; glosa?: string | null }) {
  return (
    <>
      <p className="font-mono text-[11px] text-slate-500">{producto}</p>
      <p className="max-w-80 text-slate-800">{glosa ?? '—'}</p>
    </>
  )
}
