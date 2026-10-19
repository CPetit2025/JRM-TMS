'use client'

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import Link from 'next/link'
import { usePathname } from 'next/navigation'
import { BarChart3, ClipboardList, Loader2, Settings2, Users } from 'lucide-react'
import { call, type FlowContext } from '@/lib/hhee/flujo'

// Contexto del módulo HHEE (permisos, áreas, causas y personal) y cabecera con las tres ventanas del flujo
const Ctx = createContext<{ ctx: FlowContext; reload: () => Promise<void> } | null>(null)

export function FlowProvider({ children }: { children: ReactNode }) {
  const [ctx, setCtx] = useState<FlowContext | null>(null)
  const [error, setError] = useState('')
  const reload = useCallback(async () => {
    try { setCtx(await call<FlowContext>('hhee_flow_context')); setError('') } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo cargar HHEE') }
  }, [])
  useEffect(() => {
    let alive = true
    call<FlowContext>('hhee_flow_context').then(c => { if (alive) setCtx(c) }).catch(e => { if (alive) setError(e instanceof Error ? e.message : 'No se pudo cargar HHEE') })
    return () => { alive = false }
  }, [])
  const path = usePathname()
  const tabs = [
    { href: '/hhee/solicitudes', label: 'Solicitudes y aprobación', icon: ClipboardList },
    { href: '/hhee/personal', label: 'Personal', icon: Users },
    { href: '/hhee', label: 'Panel gerencial', icon: BarChart3 },
  ]
  return (
    <div className="mx-auto grid max-w-[1600px] gap-4 pb-10">
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center justify-between gap-2 px-5 pt-4">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-widest text-slate-500">Control de horas extras · Distribución</p>
            <h1 className="text-lg font-black tracking-tight text-[#002855]">Horas extras (HHEE)</h1>
            <p className="text-xs text-slate-500">Personal → solicitud del supervisor → aprobación con informe PDF y correo → panel gerencial</p>
          </div>
          {ctx?.caps.config && <Link href="/hhee/configuracion" className="inline-flex min-h-9 items-center gap-1.5 rounded-lg border border-slate-300 px-3 text-xs font-semibold text-[#002855]"><Settings2 className="h-4 w-4" /> Áreas, accesos y causas</Link>}
        </div>
        <nav aria-label="Control de horas extras" className="mt-3 flex gap-1 overflow-x-auto border-t border-slate-100 px-2">
          {tabs.map(t => {
            const active = t.href === '/hhee' ? path === '/hhee' : path.startsWith(t.href)
            return <Link key={t.href} href={t.href} aria-current={active ? 'page' : undefined}
              className={`flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-xs font-bold uppercase tracking-wide ${active ? 'border-[#cf152d] text-[#002855]' : 'border-transparent text-slate-500 hover:text-slate-800'}`}>
              <t.icon className="h-4 w-4" />{t.label}</Link>
          })}
        </nav>
      </div>
      {error ? <p role="alert" className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">{error} <button type="button" className="font-semibold underline" onClick={() => void reload()}>Reintentar</button></p>
        : !ctx ? <p role="status" className="flex items-center gap-2 p-6 text-sm text-slate-500"><Loader2 className="h-4 w-4 animate-spin" /> Cargando permisos, áreas y personal…</p>
        : <Ctx.Provider value={{ ctx, reload }}>{children}</Ctx.Provider>}
    </div>
  )
}

export function useFlow() {
  const v = useContext(Ctx)
  if (!v) throw new Error('HHEE requiere FlowProvider')
  return v
}

export const inputCls = 'w-full min-w-0 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-blue-500 disabled:bg-slate-50'
export const btnCls = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg bg-[#002855] px-4 py-2 text-sm font-semibold text-white disabled:cursor-not-allowed disabled:opacity-50'
export const btn2Cls = 'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg border border-slate-300 bg-white px-4 py-2 text-sm font-semibold text-[#002855] disabled:opacity-50'

export function Field({ label, hint, children, className = '' }: { label: string; hint?: string; children: ReactNode; className?: string }) {
  return <label className={`grid min-w-0 gap-1 text-xs font-semibold text-slate-600 ${className}`}>{label}{children}{hint && <span className="text-[11px] font-normal text-slate-500">{hint}</span>}</label>
}
export function Card({ title, subtitle, actions, children }: { title: string; subtitle?: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className="min-w-0 rounded-xl border border-slate-200 bg-white shadow-sm">
      <header className="flex flex-wrap items-start justify-between gap-2 border-b border-slate-100 px-4 py-3">
        <div className="min-w-0"><h2 className="text-sm font-bold text-slate-800">{title}</h2>{subtitle && <p className="mt-0.5 text-xs text-slate-500">{subtitle}</p>}</div>
        {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
      </header>
      <div className="p-4">{children}</div>
    </section>
  )
}
export function Kpi({ label, value, hint, tone = 'default' }: { label: string; value: ReactNode; hint?: ReactNode; tone?: 'default' | 'navy' | 'ok' | 'warn' | 'crit' }) {
  const color = { default: 'text-slate-900', navy: 'text-[#002855]', ok: 'text-emerald-700', warn: 'text-amber-700', crit: 'text-red-700' }[tone]
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
      <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500">{label}</p>
      <p className={`mt-1 text-2xl font-black tabular-nums ${color}`}>{value}</p>
      {hint && <div className="mt-1 text-[11px] leading-snug text-slate-500">{hint}</div>}
    </div>
  )
}
export function Modal({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', key)
    return () => window.removeEventListener('keydown', key)
  }, [onClose])
  // Portal a <body>: el contenido del panel crea su propio contexto de apilamiento y la cabecera fija lo tapaba
  if (typeof document === 'undefined') return null
  return createPortal(
    <div className="fixed inset-0 z-[300] flex items-start justify-center overflow-y-auto bg-slate-950/40 p-2 sm:p-6" role="dialog" aria-modal="true" aria-label={title}>
      <div className={`w-full ${wide ? 'max-w-6xl' : 'max-w-3xl'} rounded-2xl bg-slate-50 shadow-2xl`}>
        <div className="sticky top-0 z-10 flex items-center justify-between gap-2 rounded-t-2xl border-b border-slate-200 bg-white px-5 py-3">
          <h2 className="text-base font-bold text-[#002855]">{title}</h2>
          <button type="button" onClick={onClose} className="min-h-9 rounded-lg px-3 text-sm font-semibold text-slate-600 hover:bg-slate-100">Cerrar</button>
        </div>
        <div className="grid gap-4 p-4 sm:p-5">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
