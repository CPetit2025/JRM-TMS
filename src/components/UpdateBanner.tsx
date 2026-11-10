'use client'
import { useCallback, useEffect, useRef, useState } from 'react'
import { RefreshCw, Database, X } from 'lucide-react'
import { since, until, type SourceState } from '@/lib/update-status'

// Estado de las actualizaciones (ERP, ingresos WMS) sin banner permanente:
//  · un indicador pequeño en la barra superior abre el detalle de cada fuente con «Actualizar ahora»;
//  · cada fuente avisa por separado, con una notificación flotante, solo si se atrasa o falla, o cuando termina una
//    actualización pedida. Se puede cerrar y no vuelve hasta que cambie el estado de esa fuente.
// Mismo componente en TMS y WMS; cada app da su `load`.
export type UpdateSource = { key: string; title: string; state: SourceState; request?: () => Promise<void>; href?: string; actionLabel?: string }

const DOT: Record<SourceState['level'], string> = { ok: 'bg-emerald-500', running: 'bg-blue-500', late: 'bg-amber-500', error: 'bg-rose-600', unknown: 'bg-slate-400' }
const CARD: Record<SourceState['level'], string> = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-900', running: 'border-blue-200 bg-blue-50 text-blue-900',
  late: 'border-amber-300 bg-amber-50 text-amber-950', error: 'border-rose-300 bg-rose-50 text-rose-900', unknown: 'border-slate-200 bg-slate-50 text-slate-700',
}
const LABEL: Record<SourceState['level'], string> = { ok: 'Al día', running: 'Actualizando', late: 'Atrasado', error: 'Con error', unknown: 'Sin datos' }
const STORE = 'update-status-dismissed'
const read = (): Record<string, string> => { try { return JSON.parse(localStorage.getItem(STORE) || '{}') } catch { return {} } }
const write = (v: Record<string, string>) => { try { localStorage.setItem(STORE, JSON.stringify(v)) } catch { /* sin almacenamiento */ } }
/** Identidad del aviso: cambia si cambia el nivel o llega una actualización nueva; así un aviso cerrado no vuelve solo. */
const signature = (s: UpdateSource) => `${s.state.level}|${s.state.lastAt?.getTime() ?? ''}`

function Action({ s, busy, onRequest }: { s: UpdateSource; busy: boolean; onRequest: () => void }) {
  if (s.request) return <button type="button" disabled={busy || s.state.level === 'running'} onClick={onRequest}
    className="inline-flex items-center gap-1 rounded-md border border-current/30 bg-white/80 px-2 py-1 text-xs font-semibold hover:bg-white disabled:opacity-50">
    <RefreshCw size={12} className={busy || s.state.level === 'running' ? 'animate-spin' : ''}/>{s.state.level === 'running' ? 'En curso' : 'Actualizar ahora'}</button>
  if (s.href) return <a href={s.href} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-md border border-current/30 bg-white/80 px-2 py-1 text-xs font-semibold hover:bg-white">
    <RefreshCw size={12}/>{s.actionLabel || 'Actualizar'}</a>
  return null
}

export function UpdateBanner({ load }: { load: () => Promise<UpdateSource[]> }) {
  const [sources, setSources] = useState<UpdateSource[]>([])
  const [now, setNow] = useState(() => new Date())
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(''), [error, setError] = useState('')
  const [dismissed, setDismissed] = useState<Record<string, string>>({})
  const [finished, setFinished] = useState<Record<string, boolean>>({}) // solicitudes que terminaron en esta pestaña
  const previous = useRef<Record<string, SourceState['level']>>({})
  const panel = useRef<HTMLDivElement>(null)
  const refresh = useCallback(async () => {
    try {
      const next = await load()
      // Aviso de «actualizado» cuando una fuente pasa de en curso a al día
      const done: Record<string, boolean> = {}
      for (const s of next) if (previous.current[s.key] === 'running' && s.state.level === 'ok') done[s.key] = true
      previous.current = Object.fromEntries(next.map(s => [s.key, s.state.level]))
      if (Object.keys(done).length) setFinished(f => ({ ...f, ...done }))
      setSources(next); setNow(new Date()); setError('')
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [load])
  useEffect(() => {
    const first = setTimeout(() => { setDismissed(read()); void refresh() }, 0)
    const timer = setInterval(() => void refresh(), 60_000)
    return () => { clearTimeout(first); clearInterval(timer) }
  }, [refresh])
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (!panel.current?.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close); document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])
  // Los avisos de «actualizado» se van solos
  useEffect(() => {
    if (!Object.keys(finished).length) return
    const t = setTimeout(() => setFinished({}), 15_000)
    return () => clearTimeout(t)
  }, [finished])
  const request = async (s: UpdateSource) => {
    if (!s.request) return
    setBusy(s.key); setError('')
    try { await s.request(); await refresh() } catch (e) { setError(`${s.title}: ${e instanceof Error ? e.message : String(e)}`) } finally { setBusy('') }
  }
  const dismiss = (s: UpdateSource) => { const v = { ...read(), [s.key]: signature(s) }; write(v); setDismissed(v); setFinished(f => ({ ...f, [s.key]: false })) }
  if (!sources.length) return null
  const worst = sources.find(s => s.state.level === 'error') ? 'error' : sources.find(s => s.state.level === 'late') ? 'late'
    : sources.find(s => s.state.level === 'running') ? 'running' : 'ok'
  const alerts = sources.filter(s => finished[s.key] || (['late', 'error'].includes(s.state.level) && dismissed[s.key] !== signature(s)))
  return (
    <>
      <div ref={panel} className="relative print:hidden">
        <button type="button" onClick={() => setOpen(o => !o)} aria-expanded={open} aria-label={`Actualización de datos: ${LABEL[worst]}`}
          title="Actualización de datos (ERP e ingresos)" className="relative inline-flex h-9 items-center gap-1.5 rounded-lg border border-slate-200 px-2 text-xs font-semibold text-slate-600 hover:bg-slate-50">
          <Database size={15}/><span className="hidden sm:inline">Datos</span>
          <span className={`h-2.5 w-2.5 rounded-full ${DOT[worst]} ${worst === 'late' || worst === 'error' ? 'animate-pulse' : ''}`} aria-hidden/>
        </button>
        {open && <div role="dialog" aria-label="Estado de actualización de datos" className="absolute right-0 top-11 z-50 w-[22rem] max-w-[calc(100vw-1.5rem)] space-y-2 rounded-xl border border-slate-200 bg-white p-3 shadow-xl">
          <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Actualización de datos</p>
          {sources.map(s => <div key={s.key} className={`space-y-1 rounded-lg border p-2 text-xs ${CARD[s.state.level]}`}>
            <div className="flex items-center gap-2"><span className={`h-2.5 w-2.5 rounded-full ${DOT[s.state.level]}`} aria-hidden/><b>{s.title}</b><span className="ml-auto">{LABEL[s.state.level]}</span></div>
            <p>Actualizado {since(s.state.lastAt, now)} · próxima automática {until(s.state.nextAt, now)}</p>
            {s.state.level !== 'ok' && <p className="font-semibold">{s.state.detail}</p>}
            <div className="flex justify-end"><Action s={s} busy={busy === s.key} onRequest={() => void request(s)}/></div>
          </div>)}
          {error && <p role="alert" className="text-xs text-rose-700">{error}</p>}
          <p className="text-[11px] text-slate-500">Las cargas automáticas siguen su horario; «Actualizar ahora» agrega una ejecución.</p>
        </div>}
      </div>
      {alerts.length > 0 && <div className="fixed bottom-4 right-4 z-50 flex w-[22rem] max-w-[calc(100vw-2rem)] flex-col gap-2 print:hidden" aria-live="polite">
        {alerts.map(s => <div key={s.key} role="status" className={`rounded-xl border p-3 text-xs shadow-lg ${CARD[finished[s.key] ? 'ok' : s.state.level]} ${!finished[s.key] ? 'animate-pulse' : ''}`}>
          <div className="flex items-start gap-2">
            <span className={`mt-0.5 h-2.5 w-2.5 shrink-0 rounded-full ${DOT[finished[s.key] ? 'ok' : s.state.level]}`} aria-hidden/>
            <div className="min-w-0 flex-1 space-y-1">
              <b className="block">{s.title} · {finished[s.key] ? 'Actualizado' : LABEL[s.state.level]}</b>
              <p>Actualizado {since(s.state.lastAt, now)}{finished[s.key] ? '' : ` · ${s.state.detail}`}</p>
              {!finished[s.key] && <Action s={s} busy={busy === s.key} onRequest={() => void request(s)}/>}
            </div>
            <button type="button" onClick={() => dismiss(s)} aria-label={`Cerrar aviso de ${s.title}`} className="rounded p-0.5 hover:bg-white/70"><X size={14}/></button>
          </div>
        </div>)}
      </div>}
    </>
  )
}
