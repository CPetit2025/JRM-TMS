'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Printer, RotateCcw, ScanLine, ClipboardCheck, X } from 'lucide-react'
import { Code128Barcode } from '@/components/warehouse/Code128Barcode'

type Receipt = {
  receipt_key: string; document_no: string; fecha: string; bodega: string; lote: string | null
  product_code: string; description: string | null; unit: string | null; contract_code: string | null
  quantity: number; weight_kg: number | null; customer_name: string | null; customer_source: 'ERP/OT' | 'MANUAL' | null
  physical_quantity: number | null; variance: number | null; variance_reason: string | null
  validation_status: 'PENDING' | 'STALE' | 'VALIDATED'; label_count: number; labeled_qty: number; label_status: string
}
type BrowserPrinter = { send: (data: string, onSuccess: () => void, onError: (error?: { message?: string }) => void) => void }
type BrowserPrintApi = { getDefaultDevice: (kind: string, onSuccess: (device: BrowserPrinter) => void, onError: () => void) => void }
type Label = {
  package_code: string; source_document_no: string; source_lot: string; source_product_code: string
  description: string; quantity: number; weight_kg: number | null; unit: string | null
  sequence_no: number; sequence_total: number; source_warehouse: string; source_date: string
  contract_code: string | null; customer_name: string
}

export default function WarehouseLabelingPage() {
  const [query, setQuery] = useState('')
  const [receipts, setReceipts] = useState<Receipt[]>([])
  const [selected, setSelected] = useState<Receipt | null>(null)
  const [sizes, setSizes] = useState<Record<string, { units_per_package: number; unit: string | null }>>({})
  const [physicalQuantity, setPhysicalQuantity] = useState('')
  const [varianceReason, setVarianceReason] = useState('')
  const [manualCustomer, setManualCustomer] = useState('')
  const [count, setCount] = useState('1')
  const [capacity, setCapacity] = useState('')
  const [labels, setLabels] = useState<Label[]>([])
  const [labelsPrinted, setLabelsPrinted] = useState(false)
  const [printTarget, setPrintTarget] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!selected) return
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setSelected(null) }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', onKeyDown) }
  }, [selected])

  useEffect(() => {
    void (async () => {
      const { data } = await createClient().from('wh_pack_sizes').select('product_code,units_per_package,unit')
      if (!data) return
      const mapped: Record<string, { units_per_package: number; unit: string | null }> = {}
      for (const row of data) mapped[row.product_code.toUpperCase()] = { units_per_package: Number(row.units_per_package), unit: row.unit }
      setSizes(mapped)
    })()
  }, [])

  const search = useCallback(async (selectKey?: string) => {
    if (query.trim().length < 2) { setError('Ingrese un IPT, OT/contrato o lote para buscar.'); return }
    setSearching(true); setError(''); setMessage('')
    const { data, error: rpcError } = await createClient().rpc('wh_receipt_candidates', { p_query: query.trim() })
    if (rpcError) setError(rpcError.message)
    else {
      const rows = (data || []) as Receipt[]
      setReceipts(rows)
      if (selectKey) {
        const next = rows.find(row => row.receipt_key === selectKey)
        if (next) setSelected(next)
      }
    }
    setSearching(false)
  }, [query])

  const select = (receipt: Receipt) => {
    setSelected(receipt); setLabels([]); setLabelsPrinted(false); setMessage(''); setError('')
    const physical = receipt.physical_quantity ?? Number(receipt.quantity)
    setPhysicalQuantity(String(physical))
    setVarianceReason(receipt.variance_reason || '')
    setManualCustomer(receipt.customer_source === 'MANUAL' ? receipt.customer_name || '' : '')
    const standard = sizes[receipt.product_code.toUpperCase()]
    if (standard) { setCapacity(String(standard.units_per_package)); setCount(String(Math.ceil(physical / standard.units_per_package))) }
    else { setCapacity(''); setCount('1') }
  }

  const validateReceipt = async () => {
    if (!selected) return
    setBusy(true); setError(''); setMessage('')
    const { data, error: rpcError } = await createClient().rpc('wh_validate_receipt', {
      p_receipt_key: selected.receipt_key,
      p_physical_quantity: Number(physicalQuantity),
      p_variance_reason: varianceReason.trim() || null,
      p_manual_customer_name: manualCustomer.trim() || null,
    })
    if (rpcError) { setError(rpcError.message); setBusy(false); return }
    const next: Receipt = {
      ...selected,
      physical_quantity: Number(physicalQuantity),
      variance: Number(physicalQuantity) - Number(selected.quantity),
      variance_reason: varianceReason.trim() || null,
      validation_status: 'VALIDATED',
      customer_name: data?.customer_name || selected.customer_name || manualCustomer.trim() || null,
      customer_source: data?.customer_source || selected.customer_source || 'MANUAL',
    }
    setSelected(next)
    setReceipts(rows => rows.map(row => row.receipt_key === next.receipt_key ? next : row))
    setCount(capacity ? String(Math.ceil(Number(physicalQuantity) / Number(capacity))) : count)
    setMessage('Recepción validada y auditada. Ya puede distribuir la cantidad física en bultos.')
    setBusy(false)
  }

  const generate = async () => {
    if (!selected || selected.validation_status !== 'VALIDATED') return
    setBusy(true); setError(''); setMessage('')
    const per = capacity ? Number(capacity) : null
    const packageCount = Number(count)
    const physical = Number(selected.physical_quantity)
    const { data, error: rpcError } = await createClient().rpc('wh_label_package', {
      p_receipt_key: selected.receipt_key,
      p_package_count: packageCount,
      p_units_per_package: per,
    })
    if (rpcError) { setError(rpcError.message); setBusy(false); return }
    const codes = (data?.package_codes || []) as string[]
    let remaining = physical
    const generated = codes.map((package_code, index): Label => {
      const quantity = per ? Math.min(per, remaining) : index === codes.length - 1 ? remaining : Math.round(physical / packageCount * 1000) / 1000
      remaining -= quantity
      const weight = selected.weight_kg !== null && selected.weight_kg !== undefined && Number(selected.quantity) > 0
        ? Number((selected.weight_kg * quantity / Number(selected.quantity)).toFixed(3)) : null
      return {
        package_code, source_document_no: selected.document_no, source_lot: selected.lote || '',
        source_product_code: selected.product_code, description: selected.description || selected.product_code,
        quantity, weight_kg: weight, unit: selected.unit, sequence_no: index + 1,
        sequence_total: codes.length, source_warehouse: selected.bodega, source_date: selected.fecha,
        contract_code: selected.contract_code, customer_name: selected.customer_name || 'Cliente por registrar',
      }
    })
    setLabels(generated); setLabelsPrinted(false)
    setMessage(`${codes.length} etiqueta(s) únicas generadas desde el conteo físico del IPT ${selected.document_no}.`)
    setBusy(false)
  }

  const print = async (targetLabels: Label[] = labels) => {
    setError('')
    if (labelsPrinted) {
      const reason = window.prompt('Motivo de reimpresión de etiquetas:')
      if (!reason?.trim()) return
      for (const label of targetLabels) {
        const { error: rpcError } = await createClient().rpc('wh_reprint_label', { p_package_code: label.package_code, p_reason: reason })
        if (rpcError) { setError(rpcError.message); return }
      }
    } else {
      const { error: rpcError } = await createClient().rpc('wh_print_labels', { p_package_codes: targetLabels.map(label => label.package_code) })
      if (rpcError) { setError(rpcError.message); return }
      setLabelsPrinted(true)
    }
    const fallbackPrint = () => {
      setPrintTarget(targetLabels.length === 1 ? targetLabels[0].package_code : null)
      window.addEventListener('afterprint', () => setPrintTarget(null), { once: true })
      window.setTimeout(() => window.print(), 80)
    }
    const browser = (window as Window & { BrowserPrint?: BrowserPrintApi }).BrowserPrint
    if (browser?.getDefaultDevice) {
      browser.getDefaultDevice('printer', device => {
        const clean = (value: string) => value.replace(/[\^~]/g, ' ')
        const zpl = targetLabels.map(label => `^XA^PW800^LL400^FO30,18^A0N,27,27^FD${clean(label.source_product_code)}^FS^FO30,52^A0N,21,21^FD${clean(label.description).slice(0, 45)}^FS^FO30,82^BY2,2,72^BCN,72,Y,N,N^FD${label.package_code}^FS^FO30,175^A0N,20,20^FD${label.package_code}^FS^FO30,208^A0N,18,18^FDERP ${clean(label.source_document_no)} Lote ${clean(label.source_lot || '-')}^FS^FO30,237^A0N,17,17^FDOT ${clean(label.contract_code || '-')} Cliente ${clean(label.customer_name).slice(0, 38)}^FS^FO30,260^A0N,17,17^FDBodega ${clean(label.source_warehouse)} ${label.source_date}^FS^FO30,285^A0N,21,21^FD${label.quantity} ${clean(label.unit || '')} ${label.weight_kg === null ? 'Peso por registrar' : `${label.weight_kg} kg`} ${label.sequence_no}/${label.sequence_total}^FS^XZ`).join('')
        device.send(zpl, () => setMessage('Etiquetas enviadas a Zebra.'), error => { setError(String(error?.message || error)); fallbackPrint() })
      }, () => { setError('No se detectó Zebra Browser Print; se abrirá la impresión PDF del navegador.'); fallbackPrint() })
    } else fallbackPrint()
  }

  const requiresVarianceReason = selected && Number(physicalQuantity) !== Number(selected.quantity)
  const canGenerate = selected?.validation_status === 'VALIDATED' && Number(selected.physical_quantity) > 0 && selected.label_status !== 'DIFFERENCE'
  const planQuantity = Number(selected?.physical_quantity || 0)
  const planCount = Math.min(100, Math.max(0, Number(count) || 0))
  const planCapacity = Number(capacity) > 0 ? Number(capacity) : null
  let planRemaining = planQuantity
  const plannedPackages = selected?.validation_status === 'VALIDATED' ? Array.from({ length: planCount }, (_, index) => {
    const quantity = planCapacity ? Math.min(planCapacity, planRemaining) : index === planCount - 1 ? planRemaining : Math.round(planQuantity / (planCount || 1) * 1000) / 1000
    planRemaining = Math.max(0, Number((planRemaining - quantity).toFixed(3)))
    return { sequence: index + 1, quantity, kind: planCapacity && quantity < planCapacity ? 'Saldo' : 'Completo' }
  }) : []

  return <div className="mx-auto max-w-6xl space-y-5">
    <header>
      <p className="text-xs font-bold uppercase tracking-widest text-blue-700">WMS · Recepción APT</p>
      <h1 className="mt-1 text-3xl font-black text-[#002855]">Recepción, validación y etiquetado</h1>
      <p className="mt-1 text-sm text-slate-600">Busque el IPT por Nro_Documento o encuentre el ingreso por OT, contrato o lote. Confirme lo recibido antes de generar las etiquetas.</p>
    </header>
    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
    {message && <p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">{message}</p>}

    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="font-bold text-[#002855]">1. Buscar ingreso vigente del actualizable APT</h2><p className="mt-1 text-xs text-slate-500">El IPT puede incluir varias líneas; el sistema mantiene cada producto y lote por separado.</p></div>
        <a href="/almacen/apt/datos" className="rounded-lg border px-3 py-2 text-sm font-semibold text-[#002855]">Actualizar APT</a>
      </div>
      <div className="mt-3 flex gap-2">
        <input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void search() } }} placeholder="IPT (Nro_Documento), OT/contrato o lote…" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2.5 text-sm" />
        <button disabled={searching || query.trim().length < 2} onClick={() => void search()} className="rounded-lg bg-[#002855] px-4 text-sm font-bold text-white disabled:opacity-50">{searching ? 'Buscando…' : 'Buscar'}</button>
      </div>
      {receipts.length > 0 && <div className="mt-3 max-h-96 divide-y overflow-auto rounded-lg border">
        {receipts.map(receipt => <button type="button" key={receipt.receipt_key} onClick={() => select(receipt)} className={`grid w-full gap-2 px-3 py-3 text-left text-sm hover:bg-blue-50 md:grid-cols-[1.1fr_2fr_1.4fr_auto] ${selected?.receipt_key === receipt.receipt_key ? 'bg-blue-50' : ''}`}>
          <span><b className="text-[#002855]">IPT {receipt.document_no}</b><small className="block text-slate-500">{receipt.fecha} · Bodega {receipt.bodega}</small></span>
          <span>{receipt.product_code} · {receipt.description || '—'}<small className="block text-slate-500">Lote {receipt.lote || '—'} · OT/Contrato {receipt.contract_code || '—'}</small></span>
          <span>Cliente: <b>{receipt.customer_name || 'Por ingresar'}</b><small className="block text-slate-500">{receipt.quantity} {receipt.unit || ''} ERP · {receipt.validation_status === 'VALIDATED' ? `${receipt.physical_quantity} físico` : 'Pendiente de validar'}</small></span>
          <span className="text-right"><b>{receipt.label_count} etiqueta(s)</b><small className="block text-slate-500">{receipt.label_status}</small></span>
        </button>)}
      </div>}
    </section>

    {selected && <div className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/55 sm:items-center sm:p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="wms-receipt-dialog-title" className="flex max-h-[100dvh] w-full max-w-5xl flex-col overflow-hidden bg-slate-50 shadow-2xl sm:max-h-[92dvh] sm:rounded-2xl">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
          <div className="min-w-0"><p className="text-[10px] font-extrabold uppercase tracking-[.16em] text-blue-700">Recepción APT · Validación y etiquetado</p><h2 id="wms-receipt-dialog-title" className="mt-1 truncate text-lg font-black text-[#002855] sm:text-xl">IPT {selected.document_no} · {selected.product_code}</h2><p className="mt-0.5 truncate text-xs text-slate-500 sm:text-sm">{selected.description || 'Producto'} · {selected.fecha} · Lote {selected.lote || '—'}</p></div>
          <button type="button" onClick={() => setSelected(null)} aria-label="Cerrar recepción" className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-[#002855]"><X size={20}/></button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-3 sm:p-5">
          {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
          {message && <p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">{message}</p>}
      <section className="rounded-xl border border-slate-200 bg-white p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div><p className="text-xs font-bold uppercase tracking-wide text-blue-700">2. Ingreso seleccionado</p><h2 className="mt-1 text-xl font-bold text-[#002855]">IPT {selected.document_no} · {selected.product_code}</h2><p className="mt-1 text-sm text-slate-600">{selected.description || 'Producto'} · {selected.fecha} · Bodega {selected.bodega} · Lote {selected.lote || '—'} · OT/Contrato {selected.contract_code || '—'}</p></div>
          <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-900">{selected.quantity} {selected.unit || ''} según ERP</span>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="rounded-lg bg-slate-50 p-3"><span className="text-xs text-slate-500">Cliente encontrado</span><p className="font-semibold text-[#002855]">{selected.customer_name || 'No se encontró por OT/contrato/lote'}</p><small className="text-slate-500">{selected.customer_source === 'ERP/OT' ? 'Dato del ERP o la OT' : selected.customer_source === 'MANUAL' ? 'Registrado manualmente y auditado' : 'Si no aparece, ingrese el nombre para esta recepción'}</small></div>
          <div className="rounded-lg bg-slate-50 p-3"><span className="text-xs text-slate-500">Peso de origen</span><p className="font-semibold text-[#002855]">{selected.weight_kg === null ? 'Por registrar' : `${selected.weight_kg} kg`}</p><small className="text-slate-500">No se genera un peso estimado si el actualizable no lo trae.</small></div>
        </div>
        {selected.validation_status === 'STALE' && <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">El ingreso del ERP cambió después de la última validación. Revise el historial de etiquetas y coordine su anulación antes de validar otra vez.</p>}
        {selected.label_status === 'DIFFERENCE' && <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">La suma de etiquetas existentes no coincide con el conteo físico validado. No se generarán etiquetas adicionales.</p>}
        <div className="mt-4 border-t pt-4">
          <h3 className="font-bold text-[#002855]">3. Validación física de recepción</h3>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            <label className="text-sm font-semibold">Cantidad física recibida<input type="number" min="0" step="0.001" value={physicalQuantity} onChange={event => setPhysicalQuantity(event.target.value)} disabled={selected.validation_status === 'VALIDATED'} className="mt-1 w-full rounded-lg border px-3 py-2.5 font-normal disabled:bg-slate-100" /></label>
            {requiresVarianceReason && <label className="text-sm font-semibold sm:col-span-2">Motivo de diferencia<input value={varianceReason} onChange={event => setVarianceReason(event.target.value)} disabled={selected.validation_status === 'VALIDATED'} placeholder="Explique la diferencia con el ERP" className="mt-1 w-full rounded-lg border px-3 py-2.5 font-normal disabled:bg-slate-100" /></label>}
            {!selected.customer_name && <label className="text-sm font-semibold">Nombre del cliente<input value={manualCustomer} onChange={event => setManualCustomer(event.target.value)} disabled={selected.validation_status === 'VALIDATED'} placeholder="Cliente de esta recepción" className="mt-1 w-full rounded-lg border px-3 py-2.5 font-normal disabled:bg-slate-100" /></label>}
          </div>
          {selected.variance !== null && selected.validation_status === 'VALIDATED' && <p className="mt-2 text-sm text-slate-600">Diferencia registrada: {selected.variance} {selected.unit || ''}{selected.variance_reason ? ` · ${selected.variance_reason}` : ''}</p>}
          {selected.validation_status !== 'VALIDATED' && <button disabled={busy || !physicalQuantity || (requiresVarianceReason && !varianceReason.trim()) || (!selected.customer_name && !manualCustomer.trim())} onClick={() => void validateReceipt()} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50"><ClipboardCheck size={17} />{busy ? 'Validando…' : 'Confirmar recepción física'}</button>}
        </div>
      </section>

      {selected.validation_status === 'VALIDATED' && <section className="rounded-xl border border-slate-200 bg-white p-5">
        <h3 className="font-bold text-[#002855]">4. Distribución de bultos y generación de LPN</h3>
        <p className="mt-1 text-sm text-slate-600">La suma de los bultos debe ser igual a la cantidad física confirmada: <b>{selected.physical_quantity} {selected.unit || ''}</b>.</p>
        <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="text-sm font-semibold">Unidades por bulto (opcional)<input type="number" min="0.001" step="0.001" value={capacity} onChange={event => { setCapacity(event.target.value); if (event.target.value) setCount(String(Math.ceil(Number(selected.physical_quantity) / Number(event.target.value)))) }} placeholder={sizes[selected.product_code.toUpperCase()] ? String(sizes[selected.product_code.toUpperCase()].units_per_package) : 'Sin estándar'} className="mt-1 w-full rounded-lg border px-3 py-2.5 font-normal" /></label>
          <label className="text-sm font-semibold">Bultos a generar<input type="number" min="1" max="100" value={count} onChange={event => setCount(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2.5 font-normal" /><small className="mt-1 block font-normal text-slate-500">Embalaje estándar: {sizes[selected.product_code.toUpperCase()] ? `${sizes[selected.product_code.toUpperCase()].units_per_package} ${sizes[selected.product_code.toUpperCase()].unit || selected.unit || ''}` : 'no configurado'}</small></label>
          <div className="flex items-end"><button disabled={busy || !canGenerate || Number(count) < 1 || Number(count) > 100} onClick={() => void generate()} className="inline-flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2.5 font-bold text-white disabled:opacity-50">{busy ? <RotateCcw className="animate-spin" size={17} /> : <ScanLine size={17} />}Generar bultos y LPN</button></div>
        </div>
        {Number(selected.physical_quantity) === 0 ? <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">La recepción quedó registrada con cantidad cero; no hay bultos para etiquetar.</p> : <>
          <div className="mt-4 grid gap-2 sm:grid-cols-3"><div className="rounded-lg bg-blue-50 p-3 text-sm"><span className="text-slate-600">Etiquetas previstas</span><b className="block text-xl text-[#002855]">{planCount}</b></div><div className="rounded-lg bg-blue-50 p-3 text-sm"><span className="text-slate-600">Unidades físicas</span><b className="block text-xl text-[#002855]">{planQuantity} {selected.unit || ''}</b></div><div className="rounded-lg bg-blue-50 p-3 text-sm"><span className="text-slate-600">Saldo de distribución</span><b className="block text-xl text-[#002855]">{planRemaining} {selected.unit || ''}</b></div></div>
          {plannedPackages.length > 0 && <div className="mt-3 max-h-56 overflow-auto rounded-lg border"><table className="w-full text-left text-sm"><thead className="sticky top-0 bg-slate-50"><tr><th className="p-2">Bulto</th><th className="p-2">Cantidad</th><th className="p-2">Tipo</th></tr></thead><tbody>{plannedPackages.map(row => <tr key={row.sequence} className="border-t"><td className="p-2">{row.sequence}</td><td className="p-2">{row.quantity} {selected.unit || ''}</td><td className="p-2">{row.kind}</td></tr>)}</tbody></table></div>}
        </>}
      </section>}
        </div>
        <footer className="flex shrink-0 flex-col gap-2 border-t border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <p className="text-xs text-slate-500">Conteo físico → distribución → LPN → impresión</p>
          <div className="flex gap-2"><button type="button" onClick={() => setSelected(null)} className="min-h-10 flex-1 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 sm:flex-none">Cerrar</button><button type="button" disabled={!labels.length} onClick={() => void print()} className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none"><Printer size={16}/>{labelsPrinted ? 'Reimprimir lote' : 'Imprimir lote'}</button></div>
        </footer>
      </div>
    </div>}

    {labels.length > 0 && <section className="rounded-xl border border-slate-200 bg-white p-5"><div className="mb-4 flex flex-wrap items-center justify-between gap-2"><div><h2 className="font-bold text-[#002855]">Etiquetas generadas · {labels.length}</h2><p className="text-xs text-slate-500">100 × 50 mm · Code 128 · Zebra Browser Print/ZPL o PDF del navegador</p></div><button onClick={() => void print()} className="inline-flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2.5 text-sm font-bold text-white"><Printer size={16} />{labelsPrinted ? 'Reimprimir lote' : 'Imprimir lote'}</button></div><div className="grid gap-3 sm:grid-cols-2 print:grid-cols-1">{labels.filter(label => printTarget === null || label.package_code === printTarget).map(label => <article key={label.package_code} className="wh-label rounded border-2 border-dashed border-slate-300 bg-white p-4 text-black"><div className="mb-2 flex items-center justify-between gap-2"><b className="text-lg">{label.source_product_code}</b><button type="button" onClick={() => void print([label])} className="print:hidden rounded-md border border-slate-300 px-2.5 py-1.5 text-xs font-bold text-[#002855]">Imprimir etiqueta</button></div><span className="text-sm">{label.description}</span><Code128Barcode value={label.package_code} height={56} className="my-2 w-full" /><b className="block text-center font-mono text-base">{label.package_code}</b><div className="mt-1 text-xs">IPT {label.source_document_no} · OT {label.contract_code || '—'} · {label.customer_name}</div><div className="mt-1 flex justify-between text-xs"><span>Lote {label.source_lot || '—'} · {label.source_warehouse}</span><span>{label.sequence_no}/{label.sequence_total}</span></div><div className="mt-1 flex justify-between text-xs"><span>{label.source_date}</span><b>{label.quantity} {label.unit} · {label.weight_kg === null ? 'Peso por registrar' : `${label.weight_kg} kg`}</b></div></article>)}</div></section>}
    <style jsx global>{`@media print{@page{size:100mm 50mm;margin:2mm}body *{visibility:hidden}.wh-label,.wh-label *{visibility:visible}.wh-label{position:relative;break-after:page;width:96mm;height:46mm;border:0!important;padding:3mm!important;margin:0!important}.wh-label:last-child{break-after:auto}}`}</style>
  </div>
}
