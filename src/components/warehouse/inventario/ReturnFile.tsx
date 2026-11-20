'use client'

import Link from 'next/link'
import { useCallback, useEffect, useState } from 'react'
import { ArrowLeft, RefreshCw } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { CONDICIONES, DISPOSICIONES, DISP_ESTADO, ESTADOS, MOTIVOS, fmtD, fmtQ } from './returns'

type Fraction = { id: number; qty: number; kg: number | null; condition: string; finding: string | null; recommendation: string | null; disposition: string | null; disposition_status: string | null
  disposition_reason: string | null; destination: string | null; inspecciono: string | null; propuso: string | null; autorizo: string | null; ejecuto: string | null; verifico: string | null
  proposed_by: string | null; executed_by: string | null; reproceso: string | null; authorization_comment: string | null }
type Line = { id: number; producto: string | null; glosa: string | null; lote: string | null; unidad: string | null; qty_declared: number; kg_declared: number | null; peso_origen: string; erp_state: string
  qty_received: number | null; kg_received: number | null; weight_method: string | null; recibio: string | null; received_at: string | null; received_by: string | null; package_code: string | null; package_hold: string | null; fractions: Fraction[] }
type Order = { id: string; code: string; cycle: number; status: string; objective: string; executor_type: string; executor_name: string | null; kg_input: number; kg_added: number; kg_recovered: number | null
  kg_waste: number | null; kg_in_process: number | null; kg_diff: number | null; diff_note: string | null; executed_by: string | null; creo: string | null; ejecuto: string | null; verifico: string | null; fracciones: number[] }
type Ret = { id: string; code: string; source: string; numero: string | null; fecha: string | null; cliente: string | null; ruc: string | null; ot: string | null; motivo: string | null; status: string
  tms_request_number: string | null; responsable: string | null; due_at: string | null; notes: string | null; lines: Line[]; reprocesos: Order[]; events: { action: string; comment: string | null; by: string | null; at: string }[] }
const btn = 'rounded-lg px-2.5 py-1.5 text-xs font-bold disabled:opacity-50'
const field = 'rounded border border-slate-300 px-2 py-1 text-sm'

/** Expediente de devolución: recepción física, inspección por fracción, disposición, reproceso, verificación y cierre. */
export function ReturnFile({ id }: { id: string }) {
  const { hasAccess } = usePermissions()
  const sup = hasAccess('almacen-supervisor'), inv = hasAccess('almacen-inventario') || sup, rec = hasAccess('almacen-etiquetado') || inv
  const [r, setR] = useState<Ret | null>(null), [uid, setUid] = useState('')
  const [head, setHead] = useState({ motivo: '', tms: '', notes: '' })
  const [recv, setRecv] = useState<Record<number, { qty: string; kg: string; method: string; label: boolean }>>({})
  const [insp, setInsp] = useState<Record<number, { qty: string; condition: string; finding: string }[]>>({})
  const [prop, setProp] = useState<Record<number, { disp: string; reason: string }>>({})
  const [rp, setRp] = useState<Record<string, { added: string; recovered: string; waste: string; process: string; note: string }>>({})
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [msg, setMsg] = useState('')
  const load = useCallback(async () => {
    const db = createClient(); const [{ data: a }, d] = await Promise.all([db.auth.getUser(), db.rpc('wh_return_detail', { p_id: id })])
    setUid(a.user?.id || ''); if (d.error) { setError(d.error.message); return }
    const x = d.data as Ret; setR(x); setHead({ motivo: x.motivo || '', tms: x.tms_request_number || '', notes: x.notes || '' })
  }, [id])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])
  const call = async (fn: () => PromiseLike<{ error: { message: string } | null }>, ok: string) => {
    setBusy(true); setError(''); setMsg(''); const x = await fn(); setBusy(false)
    if (x.error) { setError(x.error.message); return false } setMsg(ok); await load(); return true
  }
  const rpc = (name: string, args: Record<string, unknown>) => () => createClient().rpc(name, args)
  if (!r) return <p className="p-8 text-center text-slate-500">{error || 'Cargando expediente…'}</p>
  const closed = r.status === 'CERRADO'
  const allFractions = r.lines.flatMap(l => l.fractions)
  const reprocessable = allFractions.filter(f => f.disposition === 'REPROCESAR' && f.disposition_status === 'AUTORIZADA')
  return <div className="space-y-4">
    <Link href="/almacen/devoluciones" className="inline-flex items-center gap-2 text-sm font-semibold text-blue-800"><ArrowLeft size={16}/>Devoluciones</Link>
    <header className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-slate-200 bg-white p-4">
      <div className="space-y-1"><p className="text-xs font-bold uppercase tracking-widest text-blue-700">Expediente de devolución{r.source === 'NO_ANUNCIADO' ? ' · no anunciado' : ''}</p>
        <h1 className="text-2xl font-black text-[#002855]">{r.code} <span className={`ml-2 rounded-full px-2 py-0.5 align-middle text-xs font-bold ${ESTADOS[r.status]?.style}`}>{ESTADOS[r.status]?.label}</span></h1>
        <p className="text-sm text-slate-700">{r.numero ? `Guía de recojo ${r.numero} · ${r.fecha}` : 'Sin documento del ERP (provisional)'} · {r.cliente || 'procedencia por regularizar'}{r.ruc ? ` (RUC ${r.ruc})` : ''}{r.ot ? ` · OT ${r.ot}` : ''}</p>
        <p className="text-xs text-slate-500">Los datos de la guía vienen del ERP; el ingreso ya está en el ERP y este expediente no lo repite.</p></div>
      <div className="flex gap-2">{inv && !closed && <button disabled={busy || r.status !== 'RESUELTO'} title={r.status !== 'RESUELTO' ? 'Se cierra cuando todo está recibido, inspeccionado y resuelto' : ''}
        onClick={() => { const n = r.source === 'NO_ANUNCIADO' ? window.prompt('Nota de regularización:') : 'Conciliado'; if (n?.trim()) void call(rpc('wh_return_close', { p_id: r.id, p_note: n }), 'Expediente cerrado.') }} className={`${btn} bg-emerald-700 text-white`}>Cerrar expediente</button>}
        <button onClick={() => void load()} className={`${btn} inline-flex items-center gap-1 border border-slate-300`}><RefreshCw size={14}/>Actualizar</button></div>
    </header>
    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
    {msg && <p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">{msg}</p>}

    <section className="grid gap-2 rounded-xl border border-slate-200 bg-white p-3 text-sm sm:grid-cols-[1fr_1fr_2fr_auto] sm:items-end">
      <label className="font-semibold">Motivo del retorno<select disabled={!inv || closed} value={head.motivo} onChange={e => setHead({ ...head, motivo: e.target.value })} className={`mt-1 block w-full ${field}`}><option value="">Por definir</option>{Object.entries(MOTIVOS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label className="font-semibold">Solicitud RECOJO del TMS<input disabled={!inv || closed} value={head.tms} onChange={e => setHead({ ...head, tms: e.target.value })} placeholder="RT-000000" className={`mt-1 block w-full ${field}`}/></label>
      <label className="font-semibold">Notas<input disabled={!inv || closed} value={head.notes} onChange={e => setHead({ ...head, notes: e.target.value })} className={`mt-1 block w-full ${field}`}/></label>
      {inv && !closed && <button disabled={busy} onClick={() => void call(rpc('wh_return_update', { p_id: r.id, p_motivo: head.motivo, p_tms_request: head.tms, p_responsible: null, p_due_at: null, p_notes: head.notes }), 'Datos guardados.')} className={`${btn} bg-[#002855] py-2 text-white`}>Guardar</button>}
    </section>

    {r.lines.map(l => { const rv = recv[l.id] || { qty: String(l.qty_received ?? l.qty_declared), kg: String(l.kg_received ?? l.kg_declared ?? ''), method: l.kg_declared ? 'DOCUMENTO' : 'BALANZA', label: true }
      const fr = insp[l.id] || [{ qty: String(l.qty_received ?? ''), condition: 'UTILIZABLE', finding: '' }]
      const inspected = l.fractions.reduce((s, f) => s + Number(f.qty), 0)
      return <article key={l.id} className={`space-y-2 rounded-xl border bg-white p-3 text-sm ${l.erp_state === 'BAJA_ERP' ? 'border-rose-200 opacity-75' : 'border-slate-200'}`}>
      <div className="flex flex-wrap items-center gap-2"><b className="text-[#002855]">{l.producto || 'Sin SKU (por identificar)'}</b><span className="text-slate-600">{l.glosa}</span>{l.lote && <small className="text-slate-500">lote {l.lote}</small>}
        {l.erp_state === 'BAJA_ERP' && <span className="rounded-full bg-rose-100 px-2 text-xs font-bold text-rose-900">Anulada en el ERP</span>}
        <span className="ml-auto">Declarado {fmtQ(l.qty_declared)} {l.unidad} · {l.kg_declared == null ? 'peso sin dato' : `${fmtQ(l.kg_declared, 1)} kg (${l.peso_origen.toLowerCase()})`}</span></div>
      {/* Recepción */}
      {l.qty_received != null ? <p className="rounded bg-slate-50 p-2">Recibido {fmtQ(l.qty_received)} {l.unidad}{l.kg_received != null ? ` · ${fmtQ(l.kg_received, 1)} kg (${l.weight_method?.toLowerCase()})` : ' · peso sin dato'} · {l.recibio} · {fmtD(l.received_at)}
          {Number(l.qty_received) !== Number(l.qty_declared) && <b className="ml-1 text-amber-800">· diferencia {fmtQ(Number(l.qty_received) - Number(l.qty_declared))}</b>}
          {l.package_code && <span className="ml-1">· etiqueta <span className="font-mono">{l.package_code}</span>{l.package_hold ? <span className="ml-1 rounded bg-amber-100 px-1 text-xs font-bold text-amber-900">{l.package_hold.toLowerCase()}</span> : <span className="ml-1 rounded bg-emerald-100 px-1 text-xs font-bold text-emerald-900">disponible</span>}</span>}</p>
        : rec && !closed && l.erp_state !== 'BAJA_ERP' && <div className="flex flex-wrap items-end gap-2 rounded bg-blue-50/50 p-2">
          <b className="basis-full text-xs uppercase text-blue-800">Recepción física</b>
          <label className="text-xs font-semibold">Cantidad recibida<input type="number" min="0" step="any" value={rv.qty} onChange={e => setRecv({ ...recv, [l.id]: { ...rv, qty: e.target.value } })} className={`ml-1 w-24 ${field}`}/></label>
          <label className="text-xs font-semibold">kg<input type="number" min="0" step="any" value={rv.kg} onChange={e => setRecv({ ...recv, [l.id]: { ...rv, kg: e.target.value } })} className={`ml-1 w-24 ${field}`}/></label>
          <label className="text-xs font-semibold">Peso por<select value={rv.method} onChange={e => setRecv({ ...recv, [l.id]: { ...rv, method: e.target.value } })} className={`ml-1 ${field}`}><option value="BALANZA">Balanza</option><option value="DOCUMENTO">Documento</option><option value="MAESTRO">Maestro</option><option value="ESTIMADO">Estimado</option></select></label>
          <label className="text-xs"><input type="checkbox" checked={rv.label} onChange={e => setRecv({ ...recv, [l.id]: { ...rv, label: e.target.checked } })}/> Etiquetar en cuarentena</label>
          <button disabled={busy || rv.qty === ''} onClick={() => void call(rpc('wh_return_receive', { p_line: l.id, p_qty: Number(rv.qty), p_kg: rv.kg ? Number(rv.kg) : null, p_method: rv.method, p_label: rv.label, p_note: null }), 'Recepción registrada.')} className={`${btn} bg-[#002855] text-white`}>Registrar recepción</button></div>}
      {/* Inspección */}
      {l.qty_received != null && inv && !closed && inspected < Number(l.qty_received) && l.received_by !== uid && <div className="space-y-1 rounded bg-amber-50/60 p-2">
        <b className="text-xs uppercase text-amber-900">Inspección por fracción · pendiente {fmtQ(Number(l.qty_received) - inspected)} {l.unidad}</b>
        {fr.map((x, i) => <div key={i} className="flex flex-wrap items-end gap-2">
          <input type="number" min="0" step="any" value={x.qty} onChange={e => setInsp({ ...insp, [l.id]: fr.map((y, j) => j === i ? { ...y, qty: e.target.value } : y) })} aria-label="Cantidad" className={`w-24 ${field}`}/>
          <select value={x.condition} onChange={e => setInsp({ ...insp, [l.id]: fr.map((y, j) => j === i ? { ...y, condition: e.target.value } : y) })} aria-label="Condición" className={field}>{Object.entries(CONDICIONES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
          <input value={x.finding} onChange={e => setInsp({ ...insp, [l.id]: fr.map((y, j) => j === i ? { ...y, finding: e.target.value } : y) })} placeholder="Hallazgo (opcional)" className={`min-w-40 flex-1 ${field}`}/></div>)}
        <div className="flex gap-2"><button onClick={() => setInsp({ ...insp, [l.id]: [...fr, { qty: '', condition: 'REQUIERE_REPROCESO', finding: '' }] })} className={`${btn} border border-slate-300`}>+ fracción</button>
          <button disabled={busy} onClick={() => void call(rpc('wh_return_inspect', { p_line: l.id, p_fractions: fr.filter(y => Number(y.qty) > 0).map(y => ({ qty: Number(y.qty), condition: y.condition, finding: y.finding })), p_evidence_paths: [] }), 'Inspección registrada.')} className={`${btn} bg-amber-800 text-white`}>Registrar inspección</button></div></div>}
      {/* Fracciones y disposición */}
      {l.fractions.length > 0 && <div className="overflow-x-auto"><table className="w-full min-w-[760px] text-xs">
        <thead className="bg-slate-50 text-slate-600"><tr><th className="p-1.5 text-left">Fracción</th><th className="p-1.5 text-left">Condición</th><th className="p-1.5 text-left">Disposición</th><th className="p-1.5 text-left">Responsables</th><th className="p-1.5 text-left">Acción</th></tr></thead>
        <tbody>{l.fractions.map(f => { const pv = prop[f.id] || { disp: f.condition === 'UTILIZABLE' ? 'REINCORPORAR' : f.condition === 'REQUIERE_REPROCESO' ? 'REPROCESAR' : f.condition === 'DANADO' ? 'BAJA' : 'MANTENER_BLOQUEADO', reason: '' }
          return <tr key={f.id} className="border-t align-top">
          <td className="p-1.5">{fmtQ(f.qty)} {l.unidad}{f.kg != null && <small className="block text-slate-500">{fmtQ(f.kg, 1)} kg</small>}</td>
          <td className="p-1.5">{CONDICIONES[f.condition]}{f.finding && <small className="block text-slate-500">{f.finding}</small>}</td>
          <td className="p-1.5">{f.disposition ? <><b>{DISPOSICIONES[f.disposition]}</b> <span className="rounded bg-slate-100 px-1">{DISP_ESTADO[f.disposition_status || ''] || f.disposition_status}</span>{f.disposition_reason && <small className="block text-slate-500">{f.disposition_reason}</small>}{f.reproceso && <small className="block font-mono">{f.reproceso}</small>}</> : <span className="text-amber-800">sin decidir</span>}</td>
          <td className="p-1.5 text-slate-600">Inspeccionó {f.inspecciono}{f.propuso && <> · propuso {f.propuso}</>}{f.autorizo && <> · autorizó {f.autorizo}</>}{f.ejecuto && <> · ejecutó {f.ejecuto}</>}{f.verifico && <> · verificó {f.verifico}</>}</td>
          <td className="p-1.5">{!closed && <div className="flex flex-wrap gap-1">
            {inv && (!f.disposition_status || f.disposition_status === 'PROPUESTA' || f.disposition_status === 'RECHAZADA') && <>
              <select value={pv.disp} onChange={e => setProp({ ...prop, [f.id]: { ...pv, disp: e.target.value } })} aria-label="Disposición" className={field}>{Object.entries(DISPOSICIONES).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>
              <input value={pv.reason} onChange={e => setProp({ ...prop, [f.id]: { ...pv, reason: e.target.value } })} placeholder="Motivo" className={`w-28 ${field}`}/>
              <button disabled={busy || !pv.reason.trim()} onClick={() => void call(rpc('wh_return_disposition', { p_fraction: f.id, p_action: 'PROPOSE', p_disposition: pv.disp, p_reason: pv.reason, p_destination: null, p_due_at: null }), 'Disposición propuesta.')} className={`${btn} border border-slate-300`}>Proponer</button></>}
            {sup && f.disposition_status === 'PROPUESTA' && f.proposed_by !== uid && <><button disabled={busy} onClick={() => void call(rpc('wh_return_disposition', { p_fraction: f.id, p_action: 'APPROVE', p_disposition: null, p_reason: null, p_destination: null, p_due_at: null }), 'Disposición autorizada.')} className={`${btn} bg-emerald-700 text-white`}>Autorizar</button>
              <button disabled={busy} onClick={() => { const c = window.prompt('Motivo del rechazo:'); if (c?.trim()) void call(rpc('wh_return_disposition', { p_fraction: f.id, p_action: 'REJECT', p_disposition: null, p_reason: c, p_destination: null, p_due_at: null }), 'Disposición rechazada.') }} className={`${btn} border border-slate-300`}>Rechazar</button></>}
            {rec && f.disposition_status === 'AUTORIZADA' && f.disposition !== 'REPROCESAR' && <button disabled={busy} onClick={() => void call(rpc('wh_return_disposition', { p_fraction: f.id, p_action: 'EXECUTE', p_disposition: null, p_reason: null, p_destination: null, p_due_at: null }), 'Disposición ejecutada.')} className={`${btn} bg-[#002855] text-white`}>Ejecutar</button>}
            {inv && f.disposition_status === 'EJECUTADA' && f.disposition !== 'REPROCESAR' && f.executed_by !== uid && <button disabled={busy} onClick={() => void call(rpc('wh_return_disposition', { p_fraction: f.id, p_action: 'VERIFY', p_disposition: null, p_reason: null, p_destination: null, p_due_at: null }), 'Verificado.')} className={`${btn} border border-emerald-400 text-emerald-900`}>Verificar</button>}
          </div>}</td></tr> })}</tbody></table></div>}
    </article> })}

    <section className="space-y-2 rounded-xl border border-slate-200 bg-white p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2"><h2 className="font-bold text-[#002855]">Reprocesos</h2>
        {inv && !closed && reprocessable.length > 0 && <button disabled={busy} onClick={() => { const ex = window.prompt('Ejecutor (interno o nombre del taller externo):', 'Taller interno'); if (ex) void call(rpc('wh_reprocess', { p_action: 'CREATE', p_order: null, p_fractions: reprocessable.map(f => f.id), p_data: { objective: 'Recuperar material', executor_type: /interno/i.test(ex) ? 'INTERNO' : 'EXTERNO', executor_name: ex } }), 'Orden de reproceso creada.') }} className={`${btn} bg-orange-700 text-white`}>Crear orden con {reprocessable.length} fracción(es)</button>}</div>
      {r.reprocesos.length === 0 ? <p className="text-slate-500">Sin órdenes de reproceso.</p> : r.reprocesos.map(o => { const v = rp[o.id] || { added: '0', recovered: '', waste: '0', process: '0', note: '' }
        const bal = o.kg_input + Number(v.added || 0) - Number(v.recovered || 0) - Number(v.waste || 0) - Number(v.process || 0)
        return <article key={o.id} className="space-y-1 rounded-lg border p-2">
        <p><b className="font-mono">{o.code}</b> · ciclo {o.cycle} · {o.status.replace('_', ' ').toLowerCase()} · {o.executor_name || o.executor_type} · entrada {fmtQ(o.kg_input, 1)} kg</p>
        {o.kg_recovered != null && <p className="text-slate-700">Balance: entrada {fmtQ(o.kg_input, 1)} + insumos {fmtQ(o.kg_added, 1)} = recuperado {fmtQ(o.kg_recovered, 1)} + residuo {fmtQ(o.kg_waste, 1)} + en proceso {fmtQ(o.kg_in_process, 1)} + diferencia {fmtQ(o.kg_diff, 3)} kg{o.diff_note ? ` (${o.diff_note})` : ''}{o.verifico ? ` · verificó ${o.verifico}` : ''}</p>}
        {!closed && <div className="flex flex-wrap items-end gap-1">
          {rec && o.status === 'ABIERTA' && <button disabled={busy} onClick={() => void call(rpc('wh_reprocess', { p_action: 'START', p_order: o.id, p_fractions: null, p_data: {} }), 'Reproceso iniciado.')} className={`${btn} bg-[#002855] text-white`}>Iniciar</button>}
          {rec && ['EN_PROCESO', 'EN_PAUSA'].includes(o.status) && <>
            {(['added', 'recovered', 'waste', 'process'] as const).map(k => <label key={k} className="text-xs">{{ added: 'Insumos kg', recovered: 'Recuperado kg', waste: 'Residuo kg', process: 'En proceso kg' }[k]}<input type="number" min="0" step="any" value={v[k]} onChange={e => setRp({ ...rp, [o.id]: { ...v, [k]: e.target.value } })} className={`ml-1 w-20 ${field}`}/></label>)}
            <span className={`text-xs font-semibold ${Math.abs(bal) > 0.001 ? 'text-amber-800' : 'text-emerald-800'}`}>diferencia {fmtQ(bal, 3)} kg</span>
            {Math.abs(bal) > 0.001 && <input value={v.note} onChange={e => setRp({ ...rp, [o.id]: { ...v, note: e.target.value } })} placeholder="Explique la diferencia" className={`w-44 ${field}`}/>}
            <button disabled={busy || v.recovered === ''} onClick={() => void call(rpc('wh_reprocess', { p_action: 'FINISH', p_order: o.id, p_fractions: null, p_data: { kg_added: Number(v.added || 0), kg_recovered: Number(v.recovered), kg_waste: Number(v.waste || 0), kg_in_process: Number(v.process || 0), diff_note: v.note } }), 'Reproceso terminado.')} className={`${btn} bg-orange-700 text-white`}>Terminar</button></>}
          {inv && o.status === 'TERMINADA' && o.executed_by !== uid && <><button disabled={busy} onClick={() => void call(rpc('wh_reprocess', { p_action: 'VERIFY', p_order: o.id, p_fractions: null, p_data: { note: 'Conforme' } }), 'Reproceso verificado.')} className={`${btn} bg-emerald-700 text-white`}>Verificar</button>
            <button disabled={busy} onClick={() => void call(rpc('wh_reprocess', { p_action: 'CYCLE', p_order: o.id, p_fractions: null, p_data: {} }), 'Nuevo ciclo abierto.')} className={`${btn} border border-slate-300`}>Otro ciclo</button></>}
        </div>}</article> })}
    </section>

    <section className="rounded-xl border border-slate-200 bg-white p-3 text-xs text-slate-700"><h2 className="mb-1 text-sm font-bold text-[#002855]">Historial</h2>
      <ol className="space-y-0.5">{r.events.map((e, i) => <li key={i}><b>{e.action.replace(/_/g, ' ').toLowerCase()}</b> · {e.by || 'sistema'} · {fmtD(e.at)}{e.comment ? ` — ${e.comment}` : ''}</li>)}
        {!r.events.length && <li>Sin movimientos registrados.</li>}</ol></section>
  </div>
}
