'use client'

import { useCallback, useEffect, useState } from 'react'
import { RefreshCw } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { fmtD, fmtQ } from '@/components/warehouse/inventario/returns'

type Diff = { campaign_id: string; campaign: string; bodega: string; estado_campana: string; producto: string; lote: string; ot: string | null; descripcion: string | null; esperado: number; contado: number; diferencia: number; resultado: string; ajuste: string | null }
type Adj = { id: string; code: string; campaign: string; bodega: string; producto: string; lote: string; ot: string | null; esperado: number; contado: number; diferencia: number; motivo: string; causa: string | null
  estado: string; solicito: string | null; solicito_id: string; solicitado: string; decidio: string | null; decidido: string | null; comentario: string | null; erp_ref: string | null }
const STYLE: Record<string, string> = { SOLICITADO: 'bg-amber-100 text-amber-900', AUTORIZADO: 'bg-blue-100 text-blue-900', RECHAZADO: 'bg-rose-100 text-rose-900', REGISTRADO_ERP: 'bg-emerald-100 text-emerald-900' }
const btn = 'rounded-lg px-2.5 py-1.5 text-xs font-bold disabled:opacity-50'

/** Diferencias de conteo y ajustes: Inventario investiga y solicita; Jefatura autoriza (nunca quien solicitó); luego se registra en el ERP. */
export default function AdjustmentsPage() {
  const { hasAccess } = usePermissions()
  const sup = hasAccess('almacen-supervisor'), inv = hasAccess('almacen-inventario') || sup
  const [diffs, setDiffs] = useState<Diff[]>([]), [adjs, setAdjs] = useState<Adj[]>([]), [uid, setUid] = useState('')
  const [form, setForm] = useState<{ key: string; reason: string; cause: string } | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [msg, setMsg] = useState('')
  const load = useCallback(async () => {
    const db = createClient(); const [{ data: a }, r] = await Promise.all([db.auth.getUser(), db.rpc('wh_adjustments_list', { p_status: null })])
    setUid(a.user?.id || ''); if (r.error) setError(r.error.message); else { setDiffs(r.data.diferencias || []); setAdjs(r.data.adjustments || []) }
  }, [])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])
  const call = async (fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) => {
    setBusy(true); setError(''); setMsg(''); const r = await fn(); setBusy(false)
    if (r.error) { setError(r.error.message); return } setMsg(ok); setForm(null); await load()
  }
  return <div className="space-y-4">
    <header className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-widest text-blue-700">Control · Inventario</p>
      <h1 className="mt-1 text-3xl font-black text-[#002855]">Diferencias y ajustes</h1><p className="mt-1 text-sm text-slate-600">Una diferencia no es un ajuste automático. Inventario investiga y solicita; Jefatura autoriza; el ajuste se registra en el ERP y su documento queda aquí.</p></div>
      <button onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"><RefreshCw size={16}/>Actualizar</button></header>
    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
    {msg && <p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">{msg}</p>}
    <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-3"><h2 className="font-bold text-[#002855]">Diferencias de campañas en revisión o cerradas</h2>
      <div className="overflow-x-auto"><table className="w-full min-w-[820px] text-left text-sm">
        <thead className="bg-slate-50 text-xs text-slate-600"><tr><th className="p-2">Campaña</th><th className="p-2">Producto · lote</th><th className="p-2 text-right">Esperado</th><th className="p-2 text-right">Contado</th><th className="p-2 text-right">Diferencia</th><th className="p-2">Ajuste</th></tr></thead>
        <tbody>{diffs.map(d => { const key = `${d.campaign_id}|${d.producto}|${d.lote}`; return <tr key={key} className="border-t border-slate-100 align-top">
          <td className="p-2"><b>{d.campaign}</b><small className="block text-slate-500">{d.bodega}</small></td>
          <td className="p-2"><b className="text-[#002855]">{d.producto}</b> <span className="text-slate-600">{d.descripcion}</span><small className="block text-slate-500">lote {d.lote}{d.ot ? ` · OT ${d.ot}` : ''}</small></td>
          <td className="p-2 text-right">{fmtQ(d.esperado)}</td><td className="p-2 text-right">{fmtQ(d.contado)}</td>
          <td className={`p-2 text-right font-bold ${d.diferencia < 0 ? 'text-rose-700' : 'text-amber-800'}`}>{d.diferencia > 0 ? '+' : ''}{fmtQ(d.diferencia)}</td>
          <td className="p-2">{d.ajuste ? <span className="font-mono text-xs">{d.ajuste}</span> : inv && (form?.key === key
            ? <div className="space-y-1"><input value={form.reason} onChange={e => setForm({ ...form, reason: e.target.value })} placeholder="Motivo (mín. 10 caracteres)" className="w-56 rounded border px-2 py-1 text-xs"/>
                <input value={form.cause} onChange={e => setForm({ ...form, cause: e.target.value })} placeholder="Causa confirmada (opcional)" className="w-56 rounded border px-2 py-1 text-xs"/>
                <div className="flex gap-1"><button disabled={busy || form.reason.trim().length < 10} onClick={() => void call(() => createClient().rpc('wh_adjustment_request', { p_campaign: d.campaign_id, p_product: d.producto, p_lote_key: d.lote, p_reason: form.reason, p_cause: form.cause || null, p_evidence_paths: [] }), 'Ajuste solicitado.')} className={`${btn} bg-[#002855] text-white`}>Solicitar</button>
                <button onClick={() => setForm(null)} className={`${btn} border`}>Cancelar</button></div></div>
            : <button onClick={() => setForm({ key, reason: '', cause: '' })} className={`${btn} border border-slate-300`}>Solicitar ajuste</button>)}</td></tr> })}
          {!diffs.length && <tr><td colSpan={6} className="p-6 text-center text-slate-500">No hay diferencias en campañas recientes.</td></tr>}</tbody></table></div></section>
    <section className="space-y-2"><h2 className="font-bold text-[#002855]">Ajustes</h2>
      {adjs.length === 0 ? <p className="rounded-xl border bg-white p-6 text-center text-sm text-slate-500">Sin ajustes registrados.</p> : adjs.map(a => <article key={a.id} className="space-y-1 rounded-xl border border-slate-200 bg-white p-3 text-sm">
        <div className="flex flex-wrap items-center gap-2"><b className="font-mono text-[#002855]">{a.code}</b><span className={`rounded-full px-2 py-0.5 text-xs font-bold ${STYLE[a.estado]}`}>{a.estado.replace('_', ' ')}</span>
          <span>{a.producto} · lote {a.lote} · {a.campaign}</span><span className="ml-auto font-semibold">esperado {fmtQ(a.esperado)} · contado {fmtQ(a.contado)} · <span className={a.diferencia < 0 ? 'text-rose-700' : 'text-amber-800'}>{a.diferencia > 0 ? '+' : ''}{fmtQ(a.diferencia)}</span></span></div>
        <p className="text-slate-700">{a.motivo}{a.causa ? ` · Causa: ${a.causa}` : ''}</p>
        <p className="text-xs text-slate-500">Solicitó {a.solicito} · {fmtD(a.solicitado)}{a.decidio ? ` · Decidió ${a.decidio} · ${fmtD(a.decidido)}` : ''}{a.comentario ? ` — ${a.comentario}` : ''}{a.erp_ref ? ` · ERP: ${a.erp_ref}` : ''}</p>
        <div className="flex flex-wrap gap-2">
          {sup && a.estado === 'SOLICITADO' && a.solicito_id !== uid && <><button disabled={busy} onClick={() => void call(() => createClient().rpc('wh_adjustment_decide', { p_id: a.id, p_action: 'APPROVE', p_comment: null }), 'Ajuste autorizado.')} className={`${btn} bg-emerald-700 text-white`}>Autorizar</button>
            <button disabled={busy} onClick={() => { const c = window.prompt('Motivo del rechazo:'); if (c?.trim()) void call(() => createClient().rpc('wh_adjustment_decide', { p_id: a.id, p_action: 'REJECT', p_comment: c }), 'Ajuste rechazado.') }} className={`${btn} border border-slate-300`}>Rechazar</button></>}
          {sup && a.estado === 'SOLICITADO' && a.solicito_id === uid && <small className="text-slate-500">Usted lo solicitó: lo autoriza otra persona de Jefatura.</small>}
          {inv && a.estado === 'AUTORIZADO' && <button disabled={busy} onClick={() => { const c = window.prompt('Documento del ERP que registra el ajuste:'); if (c?.trim()) void call(() => createClient().rpc('wh_adjustment_decide', { p_id: a.id, p_action: 'ERP', p_comment: c }), 'Registro en ERP anotado.') }} className={`${btn} border border-blue-300 text-blue-900`}>Anotar documento ERP</button>}
        </div></article>)}</section>
  </div>
}
