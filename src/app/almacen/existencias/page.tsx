'use client'

import { FormEvent, useCallback, useEffect, useState } from 'react'
import { RefreshCw, Search } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { fmtD, fmtQ } from '@/components/warehouse/inventario/returns'

type Row = { producto: string; descripcion: string; lote: string; ot: string | null; bodega: string; ubicacion: string; unidad: string | null; paquetes: number; fisico: number; reservado: number
  bloqueado: number; disponible: number; cuarentena: number; retorno: number; kg: number | null; sin_peso: number; peso_estado: string | null; actualizado: string }
type Loc = { code: string; label: string }
const btn = 'rounded-lg px-3 py-2 text-sm font-bold disabled:opacity-50'
const field = 'rounded-lg border border-slate-300 px-3 py-2 text-sm'

/** Existencias del WMS: físico, reservado, bloqueado y disponible por producto, lote y ubicación; traslado y bloqueo por escaneo. */
export default function StockPage() {
  const { hasAccess } = usePermissions()
  const canHold = hasAccess('almacen-supervisor') || hasAccess('almacen-inventario')
  const [rows, setRows] = useState<Row[]>([])
  const [rule, setRule] = useState('')
  const [locs, setLocs] = useState<Loc[]>([])
  const [q, setQ] = useState(''), [loc, setLoc] = useState(''), [view, setView] = useState('')
  const [code, setCode] = useState(''), [dest, setDest] = useState(''), [hold, setHold] = useState('BLOQUEADO'), [reason, setReason] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [msg, setMsg] = useState('')
  const load = useCallback(async () => {
    const db = createClient()
    const [r, l] = await Promise.all([db.rpc('wh_stock_query', { p_search: q || null, p_location: loc || null, p_view: view || null }), db.from('wh_locations').select('code,label').eq('active', true).order('code')])
    if (r.error) setError(r.error.message); else { setRows((r.data?.rows || []) as Row[]); setRule(r.data?.regla || '') }
    setLocs((l.data || []) as Loc[])
  }, [q, loc, view])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load()
  }, [load])
  const act = async (e: FormEvent, kind: 'move' | 'hold' | 'release') => {
    e.preventDefault(); setBusy(true); setError(''); setMsg('')
    const db = createClient()
    const r = kind === 'move' ? await db.rpc('wh_package_locate', { p_code: code.trim(), p_location_code: dest, p_reason: reason || null })
      : await db.rpc('wh_package_hold', { p_code: code.trim(), p_status: kind === 'hold' ? hold : null, p_reason: reason })
    setBusy(false)
    if (r.error) { setError(r.error.message); return }
    setMsg(kind === 'move' ? `${r.data.moved} paquete(s) trasladados a ${r.data.location}.` : kind === 'hold' ? `${code} ${hold === 'BLOQUEADO' ? 'bloqueado' : 'en cuarentena'}.` : `${code} liberado.`)
    setCode(''); setReason(''); await load()
  }
  const total = rows.reduce((a, r) => ({ f: a.f + Number(r.fisico), d: a.d + Number(r.disponible), b: a.b + Number(r.bloqueado), r: a.r + Number(r.reservado) }), { f: 0, d: 0, b: 0, r: 0 })
  return <div className="space-y-4">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div><p className="text-xs font-bold uppercase tracking-widest text-blue-700">Control · Inventario</p><h1 className="mt-1 text-3xl font-black text-[#002855]">Existencias</h1>
        <p className="mt-1 text-sm text-slate-600">{rule}</p></div>
      <button onClick={() => void load()} className={`${btn} inline-flex items-center gap-2 border border-slate-300 bg-white`}><RefreshCw size={16}/>Actualizar</button>
    </header>
    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
    {msg && <p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">{msg}</p>}
    <section className="grid gap-3 rounded-xl border border-slate-200 bg-white p-3 lg:grid-cols-2">
      <form onSubmit={e => void act(e, 'move')} className="flex flex-wrap items-end gap-2">
        <label className="text-sm font-semibold">Paquete o LPN<input value={code} onChange={e => setCode(e.target.value)} required placeholder="Escanee o escriba" className={`mt-1 block w-48 ${field}`}/></label>
        <label className="text-sm font-semibold">Ubicación destino<select value={dest} onChange={e => setDest(e.target.value)} required className={`mt-1 block ${field}`}><option value="">Elija…</option>{locs.map(l => <option key={l.code} value={l.code}>{l.code} · {l.label}</option>)}</select></label>
        <button disabled={busy || !code || !dest} className={`${btn} bg-[#002855] text-white`}>Trasladar</button>
      </form>
      {canHold && <form onSubmit={e => void act(e, 'hold')} className="flex flex-wrap items-end gap-2">
        <label className="text-sm font-semibold">Estado<select value={hold} onChange={e => setHold(e.target.value)} className={`mt-1 block ${field}`}><option value="BLOQUEADO">Bloquear</option><option value="CUARENTENA">Cuarentena</option></select></label>
        <label className="min-w-40 flex-1 text-sm font-semibold">Motivo<input value={reason} onChange={e => setReason(e.target.value)} required className={`mt-1 block w-full ${field}`}/></label>
        <button disabled={busy || !code || !reason} className={`${btn} border border-amber-400 text-amber-900`}>Aplicar</button>
        <button type="button" disabled={busy || !code || !reason} onClick={e => void act(e as unknown as FormEvent, 'release')} className={`${btn} border border-slate-300`}>Liberar</button>
      </form>}
    </section>
    <section className="flex flex-wrap items-end gap-2 rounded-xl border border-slate-200 bg-white p-3">
      <form onSubmit={e => { e.preventDefault(); void load() }} className="relative min-w-56 flex-1"><Search size={16} className="absolute left-3 top-2.5 text-slate-400"/>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Producto, lote, descripción o paquete" className={`w-full pl-9 ${field}`}/></form>
      <select value={loc} onChange={e => setLoc(e.target.value)} aria-label="Ubicación" className={field}><option value="">Todas las ubicaciones</option><option value="SIN">Sin ubicación</option>{locs.map(l => <option key={l.code} value={l.code}>{l.code}</option>)}</select>
      {[['', 'Todo'], ['DISPONIBLE', 'Disponible'], ['BLOQUEADO', 'Bloqueado o en cuarentena'], ['RETORNO', 'Retornos']].map(([k, v]) =>
        <button key={k} type="button" aria-pressed={view === k} onClick={() => setView(k)} className={`rounded-full px-3 py-1 text-xs font-semibold ${view === k ? 'bg-[#002855] text-white' : 'ring-1 ring-slate-200'}`}>{v}</button>)}
    </section>
    <p className="text-sm text-slate-600">Totales de la vista (unidades del mismo tipo por fila; no se suman unidades distintas entre filas): físico {fmtQ(total.f)} · reservado {fmtQ(total.r)} · bloqueado {fmtQ(total.b)} · disponible {fmtQ(total.d)}</p>
    <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white"><table className="w-full min-w-[980px] text-left text-sm">
      <thead className="bg-slate-50 text-xs text-slate-600"><tr><th className="p-2">Producto · lote</th><th className="p-2">Bodega · ubicación</th><th className="p-2 text-right">Físico</th><th className="p-2 text-right">Reservado</th>
        <th className="p-2 text-right">Bloqueado</th><th className="p-2 text-right">Disponible</th><th className="p-2 text-right">Peso</th><th className="p-2">Actualizado</th></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i} className="border-t border-slate-100">
        <td className="p-2"><b className="text-[#002855]">{r.producto}</b> <span className="text-slate-600">{r.descripcion}</span><small className="block text-slate-500">lote {r.lote || '—'}{r.ot ? ` · OT ${r.ot}` : ''} · {r.paquetes} paq.{r.retorno ? ` · ${r.retorno} retorno(s)` : ''}</small></td>
        <td className="p-2">{r.bodega}<small className="block font-semibold">{r.ubicacion}</small></td>
        <td className="p-2 text-right">{fmtQ(r.fisico)} {r.unidad}</td><td className="p-2 text-right">{fmtQ(r.reservado)}</td>
        <td className="p-2 text-right">{Number(r.bloqueado) > 0 ? <span className="font-semibold text-amber-800">{fmtQ(r.bloqueado)}{r.cuarentena ? ' · cuarentena' : ''}</span> : '0'}</td>
        <td className="p-2 text-right font-bold text-emerald-800">{fmtQ(r.disponible)}</td>
        <td className="p-2 text-right">{r.kg == null ? 'sin dato' : `${fmtQ(r.kg, 1)} kg`}{r.sin_peso > 0 && <small className="block text-amber-800">{r.sin_peso} sin peso</small>}</td>
        <td className="p-2 text-xs text-slate-500">{fmtD(r.actualizado)}</td></tr>)}
        {!rows.length && <tr><td colSpan={8} className="p-6 text-center text-slate-500">No hay existencias en esta vista.</td></tr>}</tbody></table></div>
  </div>
}
