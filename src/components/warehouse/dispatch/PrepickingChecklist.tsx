'use client'
import { useCallback, useEffect, useState } from 'react'
import { ClipboardCheck, Download, RefreshCw } from 'lucide-react'
import { fmt, fmtDate, logoDataUrl } from '@/lib/warehouse/packing-list'
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

/** PDF del checklist (A4 horizontal): mismas columnas, estado y marca de revisado, con firmas al pie. */
export async function buildPrepickingPdf(c: Checklist, rows: Item[], meta: { requestNumber?: string | null; client?: string | null; checked: string[] }) {
  const { jsPDF } = await import('jspdf')
  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'landscape', compress: true })
  const logo = await logoDataUrl().catch(() => null)
  const W = 297, right = W - 12
  const header = () => {
    if (logo) pdf.addImage(logo, 'PNG', 12, 9, 34, 14)
    pdf.setFont('helvetica', 'bold'); pdf.setFontSize(14); pdf.text('CHECKLIST PREVIO AL PICKING', right, 15, { align: 'right' })
    pdf.setFont('helvetica', 'normal'); pdf.setFontSize(8.5)
    pdf.text(`OT ${c.ot || '—'} · Solicitud ${meta.requestNumber || '—'}${meta.client ? ' · ' + meta.client : ''}`, right, 21, { align: 'right' })
    pdf.line(12, 26, right, 26)
  }
  const cols = [['✓', 14], ['Ítem', 20], ['Código / descripción', 40], ['Lote', 132], ['Contrato', 168, 'r'], ['Despachado', 186, 'r'], ['Pendiente', 202, 'r'], ['Stock WMS', 226, 'r'], ['Stock ERP', 244, 'r'], ['Estado', 250]] as const
  const head = (y: number) => { pdf.setFont('helvetica', 'bold'); pdf.setFontSize(7.5); for (const [t, x, a] of cols) if (t !== '✓') pdf.text(t, x, y, a ? { align: 'right' } : undefined); pdf.setFont('helvetica', 'normal') }
  header()
  pdf.setFontSize(8.5)
  pdf.text(`Impreso: ${fmtDate(new Date().toISOString())} · Contratos ERP: ${fmtDate(c.contratos_at)} · Stock ERP: ${fmtDate(c.stock_at)}`, 12, 32)
  const count = (k: string) => c.items.filter(i => itemState(i).key === k).length
  pdf.setFont('helvetica', 'bold')
  pdf.text(`${rows.length} ítems · ${count('LISTO')} listos · ${count('PARCIAL')} parciales · ${count('ERP')} en ERP sin etiquetar · ${count('SIN_STOCK')} sin stock · revisados ${rows.filter(i => meta.checked.includes(i.item_code + i.product_code)).length}/${rows.length}`, 12, 38)
  let y = 46; head(y); y += 5
  for (const i of rows) {
    if (y > 186) { pdf.addPage(); header(); y = 34; head(y); y += 5 }
    const s = itemState(i), done = meta.checked.includes(i.item_code + i.product_code)
    pdf.rect(13, y - 3, 3.2, 3.2); if (done) { pdf.line(13.6, y - 1.4, 14.4, y - 0.3); pdf.line(14.4, y - 0.3, 15.8, y - 2.6) }
    pdf.setFont('helvetica', 'bold'); pdf.text(i.item, 20, y); pdf.setFont('helvetica', 'normal')
    pdf.text(`${i.product_code} ${i.description || ''}`.slice(0, 56), 40, y)
    pdf.text(i.lote.slice(0, 16), 132, y)
    pdf.text(`${fmt(i.contract_qty)} ${i.unit || ''}`, 168, y, { align: 'right' })
    pdf.text(fmt(i.dispatched_qty), 186, y, { align: 'right' })
    pdf.setFont('helvetica', 'bold'); pdf.text(fmt(i.pending_qty), 202, y, { align: 'right' }); pdf.setFont('helvetica', 'normal')
    pdf.text(`${fmt(i.stock_wms)} (${i.stock_wms_packages} paq.)`, 226, y, { align: 'right' })
    pdf.text(fmt(i.stock_erp), 244, y, { align: 'right' })
    pdf.text(s.label, 250, y)
    pdf.setDrawColor(225); pdf.line(12, y + 1.6, right, y + 1.6); pdf.setDrawColor(0)
    y += 5.6
  }
  if (y > 175) { pdf.addPage(); header(); y = 40 }
  y += 14; pdf.setFontSize(8.5)
  for (const [t, x] of [['Revisado por (picking)', 12], ['Supervisor de almacén', 110], ['Fecha y hora', 208]] as const) { pdf.line(x, y, x + 75, y); pdf.text(t, x, y + 4.5) }
  return pdf
}

export function PrepickingChecklist({ taskId, requestNumber, client }: { taskId: string; requestNumber?: string | null; client?: string | null }) {
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
      <div className="flex gap-2"><button type="button" disabled={!data || !rows.length} onClick={async () => { if (data) (await buildPrepickingPdf(data, rows, { requestNumber, client, checked })).save(`checklist-prepicking-${requestNumber || data.ot || 'tarea'}.pdf`) }}
        className="inline-flex items-center gap-1.5 rounded-lg bg-[#002855] px-3 py-1.5 text-sm font-semibold text-white disabled:opacity-50"><Download size={14}/>Descargar PDF</button>
      <button type="button" onClick={() => void load()} disabled={loading} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-semibold text-[#002855] disabled:opacity-50"><RefreshCw size={14} className={loading ? 'animate-spin' : ''}/>Actualizar</button></div>
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
