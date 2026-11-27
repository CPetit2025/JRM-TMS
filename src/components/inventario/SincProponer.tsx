'use client'

import { useState } from 'react'
import Link from 'next/link'
import { Loader2 } from 'lucide-react'
import { Modal } from '@/components/ui/modal'
import { Table, td, tdNum, th } from '@/components/inventario/parts'
import { invApi } from '@/lib/inventario/api'
import { fmtPeso, fmtQty } from '@/lib/inventario/format'
import { SINC_MOTIVO } from '@/lib/inventario/sinceramiento'
import type { InvStockRow, SincMotivo } from '@/lib/inventario/types'

/** Propuesta de sinceramiento (Analista de Inventario): los lotes elegidos pasan al almacén virtual SF cuando la Jefatura
 *  de Distribución la autoriza. La cantidad no puede superar el stock del sistema; el sustento es el acta que se genera. */
export function SincProponer({ ot, cliente, filas, onClose, onDone }: {
  ot: string; cliente?: string | null; filas: InvStockRow[]; onClose: () => void; onDone: () => void
}) {
  const key = (f: InvStockRow) => `${f.bodega}|${f.producto}|${f.lote}`
  const [cant, setCant] = useState<Record<string, string>>(() => Object.fromEntries(filas.map(f => [key(f), String(f.qty)])))
  const [motivo, setMotivo] = useState<SincMotivo | ''>('')
  const [obs, setObs] = useState('')
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [hecho, setHecho] = useState<string | null>(null)
  const pu = (f: InvStockRow) => (f.kg_conocido && f.qty > 0 ? f.kg / f.qty : null)
  const num = (f: InvStockRow) => Number(cant[key(f)])
  const invalida = filas.find(f => !(num(f) > 0) || num(f) > f.qty)
  const kg = filas.reduce((t, f) => t + (num(f) > 0 ? num(f) * (pu(f) ?? 0) : 0), 0)
  const enviar = async () => {
    setBusy(true); setError('')
    try {
      const r = await invApi.sincProponer({ ot, cliente, motivo: motivo as SincMotivo, observacion: obs.trim(),
        lineas: filas.map(f => ({ bodega: f.bodega, producto: f.producto, glosa: f.glosa, lote: f.lote ?? '', unidad: f.unidad, cantidad: num(f), peso_unit: pu(f) })) })
      setHecho(r.numero); onDone()
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudo registrar la propuesta') } finally { setBusy(false) }
  }
  if (hecho) return <Modal isOpen onClose={onClose} title="Propuesta registrada"
    footer={<div className="flex justify-end gap-2"><button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold">Cerrar</button>
      <Link href="/apt/sinceramiento" className="flex min-h-10 items-center rounded-lg bg-[#002855] px-4 text-sm font-semibold text-white">Ver sinceramientos</Link></div>}>
    <p className="text-sm text-slate-700">La propuesta <b>{hecho}</b> quedó por autorizar. La Jefatura de Distribución la verá en Sinceramiento; el stock pasa al almacén virtual SF solo cuando se autoriza.</p>
  </Modal>
  return <Modal isOpen onClose={onClose} title={`Proponer sinceramiento · OT ${ot}`} maxWidth="max-w-4xl"
    footer={<div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-xs text-slate-500">{filas.length} lote(s) · {fmtPeso(kg)} al almacén virtual SF</p>
      <div className="flex gap-2"><button type="button" onClick={onClose} className="min-h-10 rounded-lg border border-slate-300 bg-white px-4 text-sm font-semibold">Cancelar</button>
        <button type="button" disabled={busy || !motivo || obs.trim().length < 10 || !!invalida} onClick={() => void enviar()}
          className="flex min-h-10 items-center gap-2 rounded-lg bg-[#cf152d] px-4 text-sm font-bold text-white disabled:opacity-50">
          {busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden />} Enviar a autorización</button></div>
    </div>}>
    <p className="mb-3 text-xs text-slate-600">Use esto solo para stock que <b>físicamente no existe</b>. No se borra nada del ERP: autorizado, el stock sale del APT hacia el almacén virtual SF y queda pendiente de regularizar en el ERP. Se puede revertir.</p>
    <Table paginate={false} head={<tr><th className={th}>Bodega</th><th className={th}>Producto · lote</th><th className={`${th} text-right`}>Stock sistema</th><th className={`${th} text-right`}>A sincerar</th></tr>}>
      {filas.map(f => <tr key={key(f)}>
        <td className={td}>{f.bodega}</td>
        <td className={td}><p className="font-semibold">{f.lote}</p><p className="font-mono text-[11px] text-slate-500">{f.producto}</p><p className="max-w-80 text-slate-700">{f.glosa ?? '—'}</p></td>
        <td className={tdNum}>{fmtQty(f.qty)} <span className="text-slate-400">{f.unidad ?? ''}</span></td>
        <td className={tdNum}><input type="number" min={0} max={f.qty} step="any" value={cant[key(f)]} aria-label={`Cantidad a sincerar del lote ${f.lote}`}
          onChange={e => setCant(c => ({ ...c, [key(f)]: e.target.value }))}
          className={`w-28 rounded-lg border px-2 py-1 text-right ${num(f) > 0 && num(f) <= f.qty ? 'border-slate-300' : 'border-red-400 bg-red-50'}`} /></td>
      </tr>)}
    </Table>
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
    </div>
    {error && <p role="alert" className="mt-3 rounded-lg border border-red-200 bg-red-50 p-2 text-sm text-red-700">{error}</p>}
  </Modal>
}
