'use client'
import { useCallback, useEffect, useState } from 'react'
import { RefreshCw, ChevronDown, ChevronUp } from 'lucide-react'
import { since, until, type SourceState } from '@/lib/update-status'

// Banner de actualización: cuándo se actualizó cada fuente, cuánto falta para la próxima automática y un botón para
// pedir una ejecución extra. Parpadea si está atrasada o falló. Mismo componente en TMS y WMS; cada app da su `load`.
export type UpdateSource = { key: string; title: string; state: SourceState; request?: () => Promise<void>; href?: string; actionLabel?: string }

const STYLE: Record<SourceState['level'], string> = {
  ok: 'border-emerald-200 bg-emerald-50 text-emerald-900',
  running: 'border-blue-200 bg-blue-50 text-blue-900',
  late: 'border-amber-300 bg-amber-50 text-amber-950 animate-pulse',
  error: 'border-rose-300 bg-rose-50 text-rose-900 animate-pulse',
  unknown: 'border-slate-200 bg-slate-50 text-slate-600',
}
const DOT: Record<SourceState['level'], string> = { ok: 'bg-emerald-500', running: 'bg-blue-500', late: 'bg-amber-500', error: 'bg-rose-600', unknown: 'bg-slate-400' }
const STORE = 'update-banner-collapsed'

export function UpdateBanner({ load }: { load: () => Promise<UpdateSource[]> }) {
  const [sources, setSources] = useState<UpdateSource[]>([])
  const [now, setNow] = useState(() => new Date())
  const [busy, setBusy] = useState(''), [error, setError] = useState('')
  const [collapsed, setCollapsed] = useState(() => { try { return localStorage.getItem(STORE) === '1' } catch { return false } })
  const refresh = useCallback(async () => {
    try { setSources(await load()); setNow(new Date()) } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }, [load])
  useEffect(() => {
    const first = setTimeout(() => void refresh(), 0)
    const timer = setInterval(() => void refresh(), 60_000)
    return () => { clearTimeout(first); clearInterval(timer) }
  }, [refresh])
  const toggle = () => setCollapsed(c => { try { localStorage.setItem(STORE, c ? '0' : '1') } catch { /* sin almacenamiento */ } return !c })
  const request = async (s: UpdateSource) => {
    if (!s.request) return
    setBusy(s.key); setError('')
    try { await s.request(); await refresh() } catch (e) { setError(`${s.title}: ${e instanceof Error ? e.message : String(e)}`) } finally { setBusy('') }
  }
  if (!sources.length) return null
  const worst = sources.some(s => s.state.level === 'error') ? 'error' : sources.some(s => s.state.level === 'late') ? 'late' : 'ok'
  return (
    <section aria-label="Estado de actualización de datos" className="mb-3 print:hidden">
      <div className="flex flex-wrap items-stretch gap-2">
        {sources.map(s => (
          <div key={s.key} role="status" className={`flex min-w-0 flex-1 basis-72 flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border px-3 py-1.5 text-xs ${STYLE[s.state.level]}`}>
            <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${DOT[s.state.level]}`} aria-hidden />
            <b className="whitespace-nowrap">{s.title}</b>
            <span className="whitespace-nowrap">Actualizado {since(s.state.lastAt, now)}</span>
            {!collapsed && <span className="whitespace-nowrap text-[11px] opacity-80">Próxima automática {until(s.state.nextAt, now)}</span>}
            {!collapsed && s.state.level !== 'ok' && <span className="min-w-0 truncate font-semibold" title={s.state.detail}>· {s.state.detail}</span>}
            {s.request && <button type="button" disabled={busy === s.key || s.state.level === 'running'} onClick={() => void request(s)}
              className="ml-auto inline-flex items-center gap-1 rounded-md border border-current/30 bg-white/70 px-2 py-0.5 font-semibold hover:bg-white disabled:opacity-50">
              <RefreshCw size={12} className={busy === s.key || s.state.level === 'running' ? 'animate-spin' : ''}/>{s.state.level === 'running' ? 'En curso' : 'Actualizar ahora'}</button>}
            {!s.request && s.href && <a href={s.href} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 rounded-md border border-current/30 bg-white/70 px-2 py-0.5 font-semibold hover:bg-white">
              <RefreshCw size={12}/>{s.actionLabel || 'Actualizar'}</a>}
          </div>
        ))}
        <button type="button" onClick={toggle} aria-label={collapsed ? 'Mostrar detalle de actualización' : 'Ocultar detalle de actualización'} title={worst === 'ok' ? 'Datos al día' : 'Hay datos sin actualizar'}
          className="rounded-lg border border-slate-200 bg-white px-2 text-slate-500 hover:text-slate-800">{collapsed ? <ChevronDown size={14}/> : <ChevronUp size={14}/>}</button>
      </div>
      {error && <p role="alert" className="mt-1 text-xs text-rose-700">{error}</p>}
    </section>
  )
}
