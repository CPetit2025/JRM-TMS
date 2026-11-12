'use client'
import { useCallback, useEffect, useState } from 'react'
import { ClipboardCheck, RefreshCw } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

// Checklist previo al picking: por ítem del contrato de la OT, lo que pide el contrato (pendiente) frente al stock
// disponible (WMS etiquetado y ERP). La marca de «revisado» es una ayuda para el operario en este navegador.
type Item = { item_code: string; item: string; lote: string; product_code: string; description: string | null; unit: string | null
  contract_qty: number; dispatched_qty: number; pending_qty: number; stock_wms: number; stock_wms_packages: number; stock_erp: number }
type Checklist = { ot: string | null; contratos_at: string | null; stock_at: string | null; items: Item[] }

const n = (v: number) => new Intl.NumberFormat('es-PE', { maximumFractionDigits: 2 }).format(Number(v) || 0)
const at = (v: string | null) => v ? new Date(v).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' }) : '—'
/** Estado del ítem frente a lo pendiente del contrato. */
export function itemState(i: Pick<Item, 'pending_qty' | 'stock_wms' | 'stock_erp'>) {
  const pend = Number(i.pending_qty), wms = Number(i.stock_wms), erp = Number(i.stock_erp)
  if (pend <= 0) return { key: 'DESPACHADO', label: 'Sin pendiente', style: 'bg-slate-100 text-slate-700' }
  if (wms >= pend) return { key: 'LISTO', label: 'Listo para picking', style: 'bg-emerald-100 text-emerald-900' }
  if (wms > 0) return { key: 'PARCIAL', label: 'Parcial en WMS', style: 'bg-amber-100 text-amber-900' }
  if (erp > 0) return { key: 'ERP', label: 'En ERP, sin etiquetar', style: 'bg-blue-100 text-blue-900' }
  return { key: 'SIN_STOCK', label: 'Sin stock', style: 'bg-rose-100 text-rose-900' }
}

export function PrepickingChecklist({ taskId }: { taskId: string }) {
  const [data, setData] = useState<Checklist | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)
  const [onlyPending, setOnlyPending] = useState(true)
  const key = `wh-prepicking:${taskId}`
  const [checked, setChecked] = useState<string[]>([])
  const load = useCallback(async () => {
    setLoading(true)
    const { data: d, error: e } = await createClient().rpc('wh_prepicking_checklist', { p_task_id: taskId })
    if (e) setError(e.message); else { setError(''); setData(d as Checklist) }
    setLoading(false)
  }, [taskId])
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    try { setChecked(JSON.parse(localStorage.getItem(key) || '[]')) } catch { /* sin almacenamiento */ }
    void load()
  }, [key, load])
  const toggle = (code: string) => setChecked(c => { const next = c.includes(code) ? c.filter(x => x !== code) : [...c, code]; try { localStorage.setItem(key, JSON.stringify(next)) } catch { /* ignore */ } return next })
  const items = data?.items || []
  const rows = onlyPending ? items.filter(i => Number(i.pending_qty) > 0) : items
  const count = (k: string) => items.filter(i => itemState(i).key === k).length

  return <section className="rounded-xl border border-slate-200 bg-white p-4 print:hidden" aria-labelledby="prepicking-title">
    <div className="flex flex-wrap items-start justify-between gap-3">
      <div>
        <h2 id="prepicking-title" className="flex items-center gap-2 font-bold text-[#002855]"><ClipboardCheck size={18}/>Checklist previo al picking{data?.ot ? ` · OT ${data.ot}` : ''}</h2>
        <p className="mt-1 text-xs text-slate-500">Cantidad que pide el contrato por ítem frente al stock disponible. Contratos ERP: {at(data?.contratos_at ?? null)} · Stock ERP: {at(data?.stock_at ?? null)}</p>
      </div>
      <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-[#002855] disabled:opacity-50"><RefreshCw size={14} className={loading ? 'animate-spin' : ''}/>Actualizar</button>
    </div>
    {error && <p className="mt-3 rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
    <div className="mt-3 flex flex-wrap gap-2 text-xs font-semibold">
      <span className="rounded-full bg-slate-100 px-3 py-1">{items.length} ítems</span>
      <span className="rounded-full bg-emerald-100 px-3 py-1 text-emerald-900">{count('LISTO')} listos</span>
      <span className="rounded-full bg-amber-100 px-3 py-1 text-amber-900">{count('PARCIAL')} parciales</span>
      <span className="rounded-full bg-blue-100 px-3 py-1 text-blue-900">{count('ERP')} en ERP sin etiquetar</span>
      <span className="rounded-full bg-rose-100 px-3 py-1 text-rose-900">{count('SIN_STOCK')} sin stock</span>
      <span className="rounded-full bg-[#002855] px-3 py-1 text-white">Revisados {checked.filter(c => items.some(i => i.item_code + i.product_code === c)).length}/{rows.length}</span>
      <label className="ml-auto flex items-center gap-1.5 font-normal text-slate-600"><input type="checkbox" checked={onlyPending} onChange={e => setOnlyPending(e.target.checked)}/>Solo con pendiente</label>
    </div>
    <div className="mt-3 max-h-[28rem] overflow-auto rounded-lg border">
      <table className="w-full min-w-[900px] text-left text-xs">
        <thead className="sticky top-0 bg-slate-50 text-slate-600"><tr>
          <th className="p-2">✓</th><th className="p-2">Ítem</th><th className="p-2">Código / descripción</th><th className="p-2">Lote</th>
          <th className="p-2 text-right">Contrato</th><th className="p-2 text-right">Despachado</th><th className="p-2 text-right">Pendiente</th>
          <th className="p-2 text-right">Stock WMS</th><th className="p-2 text-right">Stock ERP</th><th className="p-2">Estado</th>
        </tr></thead>
        <tbody>{rows.map(i => { const s = itemState(i), id = i.item_code + i.product_code; return <tr key={id} className="border-t border-slate-100">
          <td className="p-2"><input type="checkbox" className="h-4 w-4" aria-label={`Revisado ${i.item_code}`} checked={checked.includes(id)} onChange={() => toggle(id)}/></td>
          <td className="p-2 font-bold text-[#002855]">{i.item}<small className="block font-normal text-slate-500">{i.item_code}</small></td>
          <td className="p-2"><b>{i.product_code}</b><small className="block text-slate-500">{i.description || '—'}</small></td>
          <td className="p-2">{i.lote}</td>
          <td className="p-2 text-right">{n(i.contract_qty)} {i.unit || ''}</td>
          <td className="p-2 text-right">{n(i.dispatched_qty)}</td>
          <td className="p-2 text-right font-bold">{n(i.pending_qty)}</td>
          <td className="p-2 text-right">{n(i.stock_wms)}<small className="block text-slate-500">{i.stock_wms_packages} paq.</small></td>
          <td className="p-2 text-right">{n(i.stock_erp)}</td>
          <td className="p-2"><span className={`rounded-full px-2 py-0.5 font-semibold ${s.style}`}>{s.label}</span></td>
        </tr> })}
        {!loading && !rows.length && <tr><td colSpan={10} className="p-6 text-center text-slate-500">{data?.ot ? 'No hay ítems de producto con pendiente para esta OT en la carga de contratos vigente.' : 'La solicitud no tiene OT para consultar el contrato.'}</td></tr>}</tbody>
      </table>
    </div>
  </section>
}
