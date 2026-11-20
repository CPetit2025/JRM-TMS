'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { FormEvent, useCallback, useEffect, useState } from 'react'
import { Plus, RefreshCw, Search } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { ESTADOS, MOTIVOS, fmtD, fmtQ } from '@/components/warehouse/inventario/returns'

type Ret = { id: string; code: string; source: string; numero: string | null; fecha: string | null; cliente: string | null; ruc: string | null; ot: string | null; motivo: string | null; status: string
  tms: string | null; responsable: string | null; due_at: string | null; lineas: number; bajas_erp: number; kg_declarado: number | null; sin_peso: number; kg_recibido: number | null }
const field = 'rounded-lg border border-slate-300 px-3 py-2 text-sm'

/** Bandeja de devoluciones: un expediente por guía de recojo del ERP (540-04 APT LB) y los retornos no anunciados. */
export default function ReturnsPage() {
  const router = useRouter()
  const [rows, setRows] = useState<Ret[]>([]), [status, setStatus] = useState('ABIERTOS'), [q, setQ] = useState('')
  const [prov, setProv] = useState<{ cliente: string; desc: string; qty: string; unidad: string; kg: string } | null>(null)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [loading, setLoading] = useState(true)
  const load = useCallback(async () => {
    const r = await createClient().rpc('wh_returns_list', { p_status: status === 'TODOS' ? null : status, p_search: q || null })
    if (r.error) setError(r.error.message); else { setError(''); setRows((r.data || []) as Ret[]) } setLoading(false)
  }, [status, q])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])
  const create = async (e: FormEvent) => {
    e.preventDefault(); if (!prov) return; setBusy(true)
    const r = await createClient().rpc('wh_return_provisional', { p_cliente: prov.cliente, p_descripcion: prov.desc, p_qty: Number(prov.qty), p_unidad: prov.unidad, p_kg: prov.kg ? Number(prov.kg) : null, p_notes: null, p_due_at: null })
    setBusy(false); if (r.error) { setError(r.error.message); return } router.push(`/almacen/devoluciones/${r.data.id}`)
  }
  return <div className="space-y-4">
    <header className="flex flex-wrap items-end justify-between gap-3"><div><p className="text-xs font-bold uppercase tracking-widest text-blue-700">Logística inversa</p>
      <h1 className="mt-1 text-3xl font-black text-[#002855]">Devoluciones</h1><p className="mt-1 text-sm text-slate-600">Cada guía de recojo del ERP abre un expediente. El ingreso ya está en el ERP: aquí se recibe físicamente, se inspecciona, se decide y se cierra. El material retornado no queda disponible hasta su verificación.</p></div>
      <div className="flex gap-2"><button onClick={() => setProv({ cliente: '', desc: '', qty: '', unidad: 'UND', kg: '' })} className="inline-flex items-center gap-2 rounded-lg border border-violet-300 bg-white px-3 py-2 text-sm font-semibold text-violet-900"><Plus size={16}/>Retorno no anunciado</button>
        <button onClick={() => void load()} className="inline-flex items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold"><RefreshCw size={16}/>Actualizar</button></div></header>
    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
    {prov && <form onSubmit={create} className="grid gap-2 rounded-xl border border-violet-200 bg-violet-50/50 p-3 text-sm sm:grid-cols-[1.2fr_2fr_0.7fr_0.6fr_0.7fr_auto] sm:items-end">
      <label className="font-semibold">Procedencia<input value={prov.cliente} onChange={e => setProv({ ...prov, cliente: e.target.value })} placeholder="Obra o cliente" className={`mt-1 block w-full ${field}`}/></label>
      <label className="font-semibold">Descripción<input required value={prov.desc} onChange={e => setProv({ ...prov, desc: e.target.value })} placeholder="Qué llegó (sin inventar SKU)" className={`mt-1 block w-full ${field}`}/></label>
      <label className="font-semibold">Cantidad<input required type="number" min="0.001" step="any" value={prov.qty} onChange={e => setProv({ ...prov, qty: e.target.value })} className={`mt-1 block w-full ${field}`}/></label>
      <label className="font-semibold">Unidad<input value={prov.unidad} onChange={e => setProv({ ...prov, unidad: e.target.value })} className={`mt-1 block w-full ${field}`}/></label>
      <label className="font-semibold">kg (si se sabe)<input type="number" min="0" step="any" value={prov.kg} onChange={e => setProv({ ...prov, kg: e.target.value })} className={`mt-1 block w-full ${field}`}/></label>
      <span className="flex gap-2"><button type="button" onClick={() => setProv(null)} className="rounded-lg border px-3 py-2 font-semibold">Cancelar</button><button disabled={busy} className="rounded-lg bg-violet-800 px-3 py-2 font-bold text-white">Registrar</button></span></form>}
    <section className="flex flex-wrap items-center gap-2 rounded-xl border border-slate-200 bg-white p-3">
      <form onSubmit={e => { e.preventDefault(); void load() }} className="relative min-w-56 flex-1"><Search size={16} className="absolute left-3 top-2.5 text-slate-400"/>
        <input value={q} onChange={e => setQ(e.target.value)} placeholder="Guía, cliente, OT o expediente" className={`w-full pl-9 ${field}`}/></form>
      {[['ABIERTOS', 'Abiertos'], ...Object.entries(ESTADOS).map(([k, v]) => [k, v.label]), ['TODOS', 'Todos']].map(([k, v]) =>
        <button key={k} type="button" aria-pressed={status === k} onClick={() => setStatus(k)} className={`rounded-full px-3 py-1 text-xs font-semibold ${status === k ? 'bg-[#002855] text-white' : 'ring-1 ring-slate-200'}`}>{v}</button>)}
    </section>
    {loading ? <p className="p-8 text-center text-slate-500">Cargando expedientes…</p> : <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white"><table className="w-full min-w-[900px] text-left text-sm">
      <thead className="bg-slate-50 text-xs text-slate-600"><tr><th className="p-2">Expediente</th><th className="p-2">Guía · fecha</th><th className="p-2">Procedencia</th><th className="p-2">Motivo</th><th className="p-2">Estado</th><th className="p-2 text-right">Líneas</th><th className="p-2 text-right">Peso declarado</th><th className="p-2">Responsable</th></tr></thead>
      <tbody>{rows.map(r => <tr key={r.id} className="border-t border-slate-100 hover:bg-blue-50/40">
        <td className="p-2"><Link href={`/almacen/devoluciones/${r.id}`} className="font-mono font-bold text-blue-800 underline">{r.code}</Link>{r.source === 'NO_ANUNCIADO' && <small className="block text-violet-800">no anunciado</small>}</td>
        <td className="p-2">{r.numero || '—'}<small className="block text-slate-500">{r.fecha || '—'}</small></td>
        <td className="p-2">{r.cliente || '—'}<small className="block text-slate-500">{r.ot ? `OT ${r.ot}` : 'sin OT'}{r.tms ? ` · ${r.tms}` : ''}</small></td>
        <td className="p-2">{r.motivo ? MOTIVOS[r.motivo] : <span className="text-amber-800">por definir</span>}</td>
        <td className="p-2"><span className={`rounded-full px-2 py-0.5 text-xs font-bold ${ESTADOS[r.status]?.style}`}>{ESTADOS[r.status]?.label || r.status}</span>{r.bajas_erp > 0 && <small className="block text-rose-700">{r.bajas_erp} línea(s) anulada(s) en ERP</small>}</td>
        <td className="p-2 text-right">{r.lineas}</td>
        <td className="p-2 text-right">{r.kg_declarado == null ? 'sin dato' : `${fmtQ(r.kg_declarado, 1)} kg`}{r.sin_peso > 0 && <small className="block text-amber-800">{r.sin_peso} sin peso</small>}</td>
        <td className="p-2">{r.responsable || '—'}{r.due_at && <small className="block text-slate-500">compromiso {fmtD(r.due_at)}</small>}</td></tr>)}
        {!rows.length && <tr><td colSpan={8} className="p-6 text-center text-slate-500">No hay expedientes en esta vista.</td></tr>}</tbody></table></div>}
  </div>
}
