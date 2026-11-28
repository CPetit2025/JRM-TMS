'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { Table, td, tdNum, th } from '@/components/inventario/parts'
import { invApi } from '@/lib/inventario/api'
import { fmtN, fmtPeso, fmtQty } from '@/lib/inventario/format'
import { SINC_MOTIVO } from '@/lib/inventario/sinceramiento'
import type { InvSincTransferencia, InvStockRow, SincMotivo } from '@/lib/inventario/types'

// productos: solo esos códigos de la OT (vista por producto); sin ellos, todo el stock de la OT
export type SincOt = { ot: string; cliente?: string | null; kg: number; productos?: string[] }

/** Sinceramiento al almacén virtual SF: los lotes elegidos de una OT (filas) o un bloque de OT con todo su stock del APT (ots).
 *  El Analista propone y la Jefatura autoriza; la Jefatura puede transferir directo (propone y autoriza en un paso).
 *  La cantidad no puede superar el stock del sistema; el sustento es el acta que se genera. */
export function SincProponer({ ot, cliente, filas, ots, puedeAutorizar, onClose, onDone }: {
  ot?: string; cliente?: string | null; filas?: InvStockRow[]; ots?: SincOt[]; puedeAutorizar: boolean; onClose: () => void; onDone: () => void
}) {
  const lotes = filas ?? []
  const key = (f: InvStockRow) => `${f.bodega}|${f.producto}|${f.lote}`
  const [cant, setCant] = useState<Record<string, string>>(() => Object.fromEntries(lotes.map(f => [key(f), String(f.qty)])))
  const [motivo, setMotivo] = useState<SincMotivo | ''>('')
  const [obs, setObs] = useState('')
  const [directo, setDirecto] = useState(puedeAutorizar)
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [hecho, setHecho] = useState<InvSincTransferencia | null>(null)
  const pu = (f: InvStockRow) => (f.kg_conocido && f.qty > 0 ? f.kg / f.qty : null)
  const num = (f: InvStockRow) => Number(cant[key(f)])
  const invalida = lotes.find(f => !(num(f) > 0) || num(f) > f.qty)
  const kg = ots ? ots.reduce((t, o) => t + o.kg, 0) : lotes.reduce((t, f) => t + (num(f) > 0 ? num(f) * (pu(f) ?? 0) : 0), 0)
  const enviar = async () => {
    setBusy(true); setError('')
    try {
      const base = { motivo: motivo as SincMotivo, observacion: obs.trim(), directo }
      setHecho(await invApi.sincTransferir(ots
        ? { ...base, ots: ots.map(o => ({ ot: o.ot, cliente: o.cliente, productos: o.productos })) }
        : { ...base, ot: ot ?? '', cliente, lineas: lotes.map(f => ({ bodega: f.bodega, producto: f.producto, glosa: f.glosa, lote: f.lote ?? '', unidad: f.unidad, cantidad: num(f), peso_unit: pu(f) })) }))
      onDone()
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo registrar') } finally { setBusy(false) }
  }
  if (hecho) return <Modal isOpen onClose={onClose} title={hecho.directo ? 'Transferido al almacén SF' : 'Propuesta registrada'}
    footer={<div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold">Cerrar</button>
      <Link href="/apt/sinceramiento" className="flex min-h-10 items-center rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white">Ver sinceramientos</Link></div>}>
    <p className="text-sm text-slate-700">{hecho.directo
      ? <>Se autorizaron <b>{fmtN(hecho.actas.length)}</b> acta(s){hecho.bloque ? <> del bloque <b>{hecho.bloque}</b></> : ''}. El stock pasa al almacén virtual SF en el próximo recálculo (unos 2 minutos).</>
      : <>Quedaron <b>{fmtN(hecho.actas.length)}</b> acta(s) por autorizar{hecho.bloque ? <> en el bloque <b>{hecho.bloque}</b></> : ''}. El stock pasa al almacén virtual SF solo cuando la Jefatura las autoriza.</>}</p>
    <p className="mt-2 text-xs text-slate-500">{hecho.actas.map(a => `${a.numero} (OT ${a.ot})`).join(' · ')}</p>
    {hecho.sin_stock.length > 0 && <p className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2 text-xs text-amber-900">Sin stock disponible, no se incluyeron: {hecho.sin_stock.join(', ')}.</p>}
  </Modal>
  const titulo = ots ? `Sincerar ${fmtN(ots.length)} contrato(s)` : `Proponer sinceramiento · OT ${ot}`
  return <Modal isOpen onClose={onClose} title={titulo} maxWidth="max-w-4xl"
    footer={<div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-slate-500">{ots ? `${fmtN(ots.length)} OT · ${ots.some(o => o.productos) ? 'productos elegidos' : 'todo su stock del APT'}` : `${lotes.length} lote(s)`} · {fmtPeso(kg)} al almacén virtual SF</p>
      <div className="flex gap-2"><button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold">Cancelar</button>
        <button type="button" disabled={busy || !motivo || obs.trim().length < 10 || !!invalida} onClick={() => void enviar()}
          className="flex min-h-10 items-center gap-2 rounded-lg bg-[#cf152d] px-4 text-sm font-bold text-white disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} {directo ? 'Transferir a SF' : 'Enviar a autorización'}</button></div>
    </div>}>
    <p className="mb-3 text-xs text-slate-600">Use esto solo para stock que <b>físicamente no existe</b>. No se borra nada del ERP: autorizado, el stock sale del APT hacia el almacén virtual SF y queda pendiente de regularizar en el ERP. Se puede revertir.
      {ots && ' Cada OT queda con su propia acta y todas comparten el número de bloque (acta consolidada).'}</p>
    {ots
      ? <Table paginate={false} head={<tr><th className={th}>OT</th><th className={th}>Cliente</th><th className={th}>Productos</th><th className={`${th} text-right`}>Stock en el APT</th></tr>}>
          {ots.map(o => <tr key={o.ot}><td className={`${td} font-semibold`}>{o.ot}</td><td className={td}>{o.cliente ?? '—'}</td><td className={td}><p className="max-w-64 truncate font-mono text-[11px]" title={o.productos?.join(', ')}>{o.productos ? o.productos.join(', ') : 'Todos'}</p></td><td className={tdNum}>{fmtPeso(o.kg)}</td></tr>)}
        </Table>
      : <Table paginate={false} head={<tr><th className={th}>Bodega</th><th className={th}>Producto · lote</th><th className={`${th} text-right`}>Stock sistema</th><th className={`${th} text-right`}>A sincerar</th></tr>}>
          {lotes.map(f => <tr key={key(f)}>
            <td className={td}>{f.bodega}</td>
            <td className={td}><p className="font-semibold">{f.lote}</p><p className="font-mono text-[11px] text-slate-500">{f.producto}</p><p className="max-w-80 text-slate-700">{f.glosa ?? '—'}</p></td>
            <td className={tdNum}>{fmtQty(f.qty)} <span className="text-slate-400">{f.unidad ?? ''}</span></td>
            <td className={tdNum}><input type="number" min={0} max={f.qty} step="any" value={cant[key(f)]} aria-label={`Cantidad a sincerar del lote ${f.lote}`}
              onChange={e => setCant(c => ({ ...c, [key(f)]: e.target.value }))}
              className={`w-28 rounded-lg border px-2 py-1 text-right ${num(f) > 0 && num(f) <= f.qty ? 'border-slate-300' : 'border-red-400 bg-red-50'}`} /></td>
          </tr>)}
        </Table>}
    {invalida && <p className="mt-2 text-xs text-red-700">La cantidad debe ser mayor que 0 y no superar el stock del sistema ({invalida.lote}).</p>}
    <div className="mt-4 grid gap-3 sm:grid-cols-2">
      <label className="text-sm font-semibold text-slate-700">Motivo
        <select value={motivo} onChange={e => setMotivo(e.target.value as SincMotivo)} className="mt-1 block min-h-10 w-full rounded-lg border border-slate-300 px-2 font-normal">
          <option value="">Elija el motivo…</option>
          {Object.entries(SINC_MOTIVO).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
        </select></label>
      <label className="text-sm font-semibold text-slate-700 sm:row-span-2">Lo verificado (va en el acta)
        <textarea value={obs} onChange={e => setObs(e.target.value)} rows={4} placeholder="Ej.: se recorrió la bodega 647 el 27/11 y el lote no se encontró; el despacho se hizo con guía manual…"
          className="mt-1 block w-full rounded-lg border border-slate-300 px-2 py-1 font-normal" /></label>
      {puedeAutorizar && <label className="flex items-start gap-2 self-end text-sm text-slate-700">
        <input type="checkbox" checked={directo} onChange={e => setDirecto(e.target.checked)} className="mt-1 h-4 w-4" />
        <span><b>Transferir directo como Jefatura de Distribución</b><br /><span className="text-xs text-slate-500">Usted propone y autoriza en un paso; el acta lo registra. Sin marcar, queda por autorizar.</span></span></label>}
    </div>
    {error && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</p>}
  </Modal>
}
