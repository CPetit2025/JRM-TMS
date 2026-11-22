'use client'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { money } from '@/lib/caja'

type Invoice = { id: number; provider_ruc: string; provider_name: string | null; document_series: string; document_number: string; issue_date: string
  currency: string; base_amount: number; igv_amount: number; total_amount: number; exchange_rate: number; base_pen: number; voided_at: string | null; void_reason: string | null }
const empty = { provider_ruc: '', provider_name: '', document_series: '', document_number: '', issue_date: '', currency: 'PEN', base_amount: '', igv_amount: '', exchange_rate: '' }
const field = 'mt-1 block min-h-10 w-full rounded-lg border border-slate-300 px-2 text-sm'

/** Facturas del proveedor de un viaje de tercero: base imponible, IGV y moneda aparte. La base en soles no se suma al flete final (provisión). */
export function FreightInvoices({ dispatchId }: { dispatchId: string }) {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<Invoice[] | null>(null), [own, setOwn] = useState(true), [form, setForm] = useState(empty)
  const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('')
  const load = useCallback(async () => {
    const [{ data: d }, { data }] = await Promise.all([
      supabase.from('dispatches').select('modalidad, vehicle_plate').eq('id', dispatchId).maybeSingle(),
      supabase.from('dispatch_freight_invoices').select('*').eq('dispatch_id', dispatchId).order('created_at'),
    ])
    setOwn(!d || (d.modalidad !== 'TERCERO' && d.vehicle_plate !== 'EXTERNO')); setRows((data || []) as Invoice[])
  }, [supabase, dispatchId])
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() }, [load])
  if (own || !rows) return null

  const save = async () => {
    setBusy(true); setError('')
    const { error: e } = await supabase.rpc('dispatch_freight_invoice_save', { p_dispatch: dispatchId, p: { ...form, base_amount: Number(form.base_amount), igv_amount: Number(form.igv_amount || 0),
      exchange_rate: form.currency === 'PEN' ? 1 : Number(form.exchange_rate) } })
    setBusy(false)
    if (e) { setError(e.message); return }
    setForm(empty); setOpen(false); void load()
  }
  const voidInvoice = async (id: number) => {
    const reason = window.prompt('Motivo de la anulación')
    if (!reason) return
    const { error: e } = await supabase.rpc('dispatch_freight_invoice_void', { p_id: id, p_reason: reason })
    if (e) setError(e.message); else void load()
  }
  const set = (k: keyof typeof empty) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setForm({ ...form, [k]: e.target.value })
  const active = rows.filter(r => !r.voided_at)
  return <div className="mt-3 rounded-lg border border-slate-200 bg-white p-3 text-sm">
    <div className="flex items-center justify-between gap-2">
      <p className="font-semibold text-[#002855]">Factura del transportista</p>
      {!open && <button type="button" onClick={() => setOpen(true)} className="min-h-10 rounded-lg border border-slate-300 px-3 text-xs font-semibold">Registrar factura</button>}
    </div>
    {rows.length === 0 && !open && <p className="mt-1 text-xs text-slate-500">Sin registros.</p>}
    {rows.length > 0 && <ul className="mt-2 space-y-1 text-xs">{rows.map(r => <li key={r.id} className={r.voided_at ? 'text-slate-400 line-through' : ''}>
      {r.document_series}-{r.document_number} · RUC {r.provider_ruc} · {r.issue_date} · base {r.currency} {r.base_amount.toFixed(2)} + IGV {r.igv_amount.toFixed(2)} = {r.total_amount.toFixed(2)}
      {r.currency !== 'PEN' ? ` · T.C. ${r.exchange_rate}` : ''} · base en soles {money(r.base_pen)}
      {!r.voided_at && <button type="button" onClick={() => void voidInvoice(r.id)} className="ml-2 text-rose-700 underline">Anular</button>}</li>)}</ul>}
    {active.length > 0 && <p className="mt-1 text-xs text-slate-600">Base facturada sin IGV: {money(active.reduce((s, r) => s + r.base_pen, 0))}. Se compara con el flete final; no se suman.</p>}
    {open && <div className="mt-2 grid grid-cols-2 gap-2">
      <label className="text-xs">RUC<input value={form.provider_ruc} onChange={set('provider_ruc')} inputMode="numeric" maxLength={11} className={field} /></label>
      <label className="text-xs">Razón social<input value={form.provider_name} onChange={set('provider_name')} className={field} /></label>
      <label className="text-xs">Serie<input value={form.document_series} onChange={set('document_series')} className={field} /></label>
      <label className="text-xs">Número<input value={form.document_number} onChange={set('document_number')} className={field} /></label>
      <label className="text-xs">Emisión<input type="date" value={form.issue_date} onChange={set('issue_date')} className={field} /></label>
      <label className="text-xs">Moneda<select value={form.currency} onChange={set('currency')} className={field}><option value="PEN">Soles</option><option value="USD">Dólares</option></select></label>
      <label className="text-xs">Base imponible<input value={form.base_amount} onChange={set('base_amount')} inputMode="decimal" className={field} /></label>
      <label className="text-xs">IGV<input value={form.igv_amount} onChange={set('igv_amount')} inputMode="decimal" className={field} /></label>
      {form.currency !== 'PEN' && <label className="text-xs">Tipo de cambio<input value={form.exchange_rate} onChange={set('exchange_rate')} inputMode="decimal" className={field} /></label>}
      <div className="col-span-2 flex gap-2">
        <button type="button" onClick={() => setOpen(false)} className="min-h-10 rounded-lg border px-3 text-xs font-semibold">Cancelar</button>
        <button type="button" disabled={busy} onClick={() => void save()} className="min-h-10 flex-1 rounded-lg bg-[#002855] px-3 text-xs font-semibold text-white disabled:opacity-50">{busy ? 'Guardando…' : 'Guardar factura'}</button>
      </div>
    </div>}
    {error && <p role="alert" className="mt-2 text-xs text-rose-700">{error}</p>}
  </div>
}
