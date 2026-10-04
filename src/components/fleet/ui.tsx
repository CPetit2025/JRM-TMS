'use client'

import { useCallback, useEffect, useState, type ReactNode } from 'react'
import { useSearchParams } from 'next/navigation'
import { REC_TONE, type FeConfianza, type FeFilters, type FeRec, type FeTone } from '@/lib/fleet/types'

// Piezas comunes del módulo Eficiencia de Flota

export const TONE_CLASS: Record<FeTone, string> = {
  crit: 'border-red-200 bg-red-50 text-red-700',
  warn: 'border-amber-200 bg-amber-50 text-amber-800',
  info: 'border-sky-200 bg-sky-50 text-sky-800',
  good: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  muted: 'border-slate-200 bg-slate-50 text-slate-600',
}
const TONE_MARK: Record<FeTone, string> = { crit: '▲', warn: '◆', info: '✚', good: '●', muted: '○' }

export function RecPill({ rec }: { rec: FeRec }) {
  const t = REC_TONE[rec] ?? 'muted'
  return (
    <span className={`inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11px] font-bold ${TONE_CLASS[t]}`}>
      <span className="font-mono text-[10px]">{TONE_MARK[t]}</span>{rec}
    </span>
  )
}

// Confianza del cálculo según los meses completos de datos (12 o más: alta; 6 a 11: media; menos: baja)
const CONF_TONE: Record<FeConfianza, FeTone> = { Alta: 'good', Media: 'info', Baja: 'warn' }
export function ConfianzaPill({ c }: { c: FeConfianza }) {
  return <span title="Meses completos de datos: 12 o más = alta; 6 a 11 = media; menos = baja"
    className={`inline-flex whitespace-nowrap rounded-full border px-2 py-0.5 text-[10px] font-bold ${TONE_CLASS[CONF_TONE[c]]}`}>Confianza {c.toLowerCase()}</span>
}

export function Panel({ title, hint, actions, children, className = '' }: { title?: ReactNode; hint?: ReactNode; actions?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`rounded-xl border border-slate-200 bg-white p-4 shadow-sm ${className}`}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-start justify-between gap-2">
          <div>
            {title && <h3 className="text-sm font-black text-slate-800">{title}</h3>}
            {hint && <p className="mt-0.5 text-xs text-slate-500">{hint}</p>}
          </div>
          {actions}
        </div>
      )}
      {children}
    </section>
  )
}

export function Note({ children }: { children: ReactNode }) {
  return <p className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{children}</p>
}

// Periodo de análisis desde la URL (?d=AAAA-MM&h=AAAA-MM)
export function useFeFilters(): FeFilters {
  const sp = useSearchParams()
  const d = sp.get('d'); const h = sp.get('h')
  return { desde: d ? `${d}-01` : undefined, hasta: h ? `${h}-01` : undefined }
}

// Carga una función con los filtros; se recalcula cuando cambian o al pedir "Actualizar"
export function useFeQuery<T>(fn: (f: FeFilters) => Promise<T>, f: FeFilters) {
  const key = `${f.desde || ''}|${f.hasta || ''}`
  const [nonce, setNonce] = useState(0)
  const [res, setRes] = useState<{ key: string; data?: T; error?: string } | null>(null)
  const k2 = `${key}|${nonce}`
  useEffect(() => {
    let alive = true
    fn(f).then(data => { if (alive) setRes({ key: k2, data }) }).catch(e => { if (alive) setRes({ key: k2, error: e instanceof Error ? e.message : 'No se pudo calcular' }) })
    return () => { alive = false }
  }, [k2]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const onUpd = () => setNonce(n => n + 1)
    window.addEventListener('fe:updated', onUpd)
    return () => window.removeEventListener('fe:updated', onUpd)
  }, [])
  const reload = useCallback(() => setNonce(n => n + 1), [])
  const current = res?.key === k2 ? res : null
  return { data: current?.data ?? res?.data, error: current?.error, loading: !current, reload }
}
