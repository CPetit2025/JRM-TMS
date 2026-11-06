'use client'

import { useCallback, useEffect, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { Printer, RotateCcw, ScanLine, ClipboardCheck, X, RefreshCw } from 'lucide-react'
import { Code128Barcode } from '@/components/warehouse/Code128Barcode'

type Receipt = {
  receipt_key: string; document_no: string; fecha: string; document_type: string | null; color: string | null; source_updated_at: string | null; bodega: string; lote: string | null
  product_code: string; description: string | null; unit: string | null; contract_code: string | null
  quantity: number; weight_kg: number | null; customer_name: string | null; customer_source: 'ERP/OT' | 'MANUAL' | null
  physical_quantity: number | null; variance: number | null; variance_reason: string | null
  validation_status: 'PENDING' | 'STALE' | 'VALIDATED'; label_count: number; labeled_qty: number; unprinted_count: number; pending_labels: Label[]; label_status: string
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
  const [packageMode, setPackageMode] = useState<'TOTAL' | 'PACKAGES'>('PACKAGES')
  const [completePackages, setCompletePackages] = useState('0')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [showPreview, setShowPreview] = useState(false)
  const [varianceReason, setVarianceReason] = useState('')
  const [manualCustomer, setManualCustomer] = useState('')
  const [count, setCount] = useState('1')
  const [capacity, setCapacity] = useState('')
  const [labels, setLabels] = useState<Label[]>([])
  const [printedLabelCodes, setPrintedLabelCodes] = useState<string[]>([])
  const [printTarget, setPrintTarget] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [searching, setSearching] = useState(false)
  const [error, setError] = useState('')
  const [message, setMessage] = useState('')

  useEffect(() => {
    if (!selected && !showPreview) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (showPreview) setShowPreview(false)
        else setSelected(null)
      }
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    return () => { document.body.style.overflow = previousOverflow; window.removeEventListener('keydown', onKeyDown) }
  }, [selected, showPreview])

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
    if (query.trim() && query.trim().length < 2) { setError('Ingrese al menos dos caracteres para buscar.'); return }
    setSearching(true); setError(''); setMessage('')
    const { data, error: rpcError } = await createClient().rpc('wh_receipt_candidates', { p_query: query.trim() })
    if (rpcError) setError(rpcError.message)
    else {
      const rows = (data || []) as Receipt[]
      setReceipts(rows)
      setLastUpdated(new Date())
      if (selectKey) {
        const next = rows.find(row => row.receipt_key === selectKey)
        if (next) setSelected(next)
      }
    }
    setSearching(false)
  }, [query])

  useEffect(() => {
    if (query.trim()) return
    let live = true
    const refresh = async (showLoading: boolean) => {
      if (showLoading) setSearching(true)
      const { data, error: rpcError } = await createClient().rpc('wh_receipt_candidates', { p_query: '' })
      if (!live) return
      if (rpcError) {
        if (showLoading) setError(rpcError.message)
      } else {
        setReceipts((data || []) as Receipt[])
        setLastUpdated(new Date())
        if (showLoading) setError('')
      }
      if (showLoading) setSearching(false)
    }
    void refresh(true)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh(false)
    }, 30000)
    return () => { live = false; window.clearInterval(timer) }
  }, [query])


  const select = (receipt: Receipt) => {
    setSelected(receipt); setLabels(receipt.pending_labels || []); setPrintedLabelCodes([]); setShowPreview(false); setMessage(''); setError('')
    const physical = receipt.physical_quantity ?? Number(receipt.quantity)
    setPhysicalQuantity(String(physical))
    setVarianceReason(receipt.variance_reason || '')
    setManualCustomer(receipt.customer_source === 'MANUAL' ? receipt.customer_name || '' : '')
    const standard = sizes[receipt.product_code.toUpperCase()]
    if (standard) {
      const units = standard.units_per_package
      setCapacity(String(units)); setCount(String(Math.ceil(physical / units)))
      setPackageMode('PACKAGES')
      setCompletePackages(String(Math.floor(physical / units)))
    } else {
      setCapacity(''); setCount('1'); setPackageMode('PACKAGES'); setCompletePackages('0')
    }
  }

  const validateReceipt = async () => {
    if (!selected) return
    const verifiedQuantity = Number(physicalQuantity)
    setBusy(true); setError(''); setMessage('')
    const { data, error: rpcError } = await createClient().rpc('wh_validate_receipt', {
      p_receipt_key: selected.receipt_key,
      p_physical_quantity: verifiedQuantity,
      p_variance_reason: varianceReason.trim() || null,
      p_manual_customer_name: manualCustomer.trim() || null,
    })
    if (rpcError) { setError(rpcError.message); setBusy(false); return }
    const next: Receipt = {
      ...selected,
      physical_quantity: verifiedQuantity,
      variance: verifiedQuantity - Number(selected.quantity),
      variance_reason: varianceReason.trim() || null,
      validation_status: 'VALIDATED',
      customer_name: data?.customer_name || selected.customer_name || manualCustomer.trim() || null,
      customer_source: data?.customer_source || selected.customer_source || 'MANUAL',
    }
    setSelected(next)
    setReceipts(rows => rows.map(row => row.receipt_key === next.receipt_key ? next : row))
    setPhysicalQuantity(String(verifiedQuantity))
    setCount(capacity ? String(Math.ceil(verifiedQuantity / Number(capacity))) : count)
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
    setLabels(generated); setPrintedLabelCodes([]); setShowPreview(false)
    setMessage(`${codes.length} etiqueta(s) únicas generadas desde el conteo físico del IPT ${selected.document_no}.`)
    setBusy(false)
  }

  const print = async (targetLabels: Label[] = labels) => {
    setError('')
    if (!targetLabels.length) return
    const alreadyPrinted = targetLabels.filter(label => printedLabelCodes.includes(label.package_code))
    const newLabels = targetLabels.filter(label => !printedLabelCodes.includes(label.package_code))
    if (alreadyPrinted.length) {
      const reason = window.prompt('Motivo de reimpresión de etiquetas:')
      if (!reason?.trim()) return
      for (const label of alreadyPrinted) {
        const { error: rpcError } = await createClient().rpc('wh_reprint_label', { p_package_code: label.package_code, p_reason: reason.trim() })
        if (rpcError) { setError(rpcError.message); return }
      }
    }
    if (newLabels.length) {
      const { error: rpcError } = await createClient().rpc('wh_print_labels', { p_package_codes: newLabels.map(label => label.package_code) })
      if (rpcError) { setError(rpcError.message); return }
    }
    setPrintedLabelCodes(current => [...new Set([...current, ...targetLabels.map(label => label.package_code)])])
    const fallbackPrint = () => {
      setPrintTarget(targetLabels.length === 1 ? targetLabels[0].package_code : null)
      window.addEventListener('afterprint', () => setPrintTarget(null), { once: true })
      // Let React commit the selected label set before Chrome captures the print tree.
      window.requestAnimationFrame(() => window.requestAnimationFrame(() => window.print()))
    }
    const browser = (window as Window & { BrowserPrint?: BrowserPrintApi }).BrowserPrint
    if (browser?.getDefaultDevice) {
      browser.getDefaultDevice('printer', device => {
        const clean = (value: string) => value.replace(/[\^~]/g, ' ')
        const zpl = targetLabels.map(label => `^XA^PW1218^LL812^FO45,35^A0N,52,52^FD${clean(label.source_product_code)}^FS^FO45,105^A0N,38,38^FD${clean(label.description).slice(0, 62)}^FS^FO45,190^BY3,3,210^BCN,210,Y,N,N^FD${label.package_code}^FS^FO45,430^A0N,42,42^FD${label.package_code}^FS^FO45,505^A0N,32,32^FDIPT ${clean(label.source_document_no)}  Fecha ${clean(label.source_date)}^FS^FO45,565^A0N,32,32^FDOT ${clean(label.contract_code || '-')}  Lote ${clean(label.source_lot || '-')}^FS^FO45,625^A0N,30,30^FD${clean(label.customer_name).slice(0, 42)}  ${clean(label.source_warehouse)}^FS^FO45,700^A0N,48,48^FD${label.quantity} ${clean(label.unit || '')}  ${label.weight_kg === null ? 'Peso por registrar' : `${label.weight_kg} kg`}  ${label.sequence_no}/${label.sequence_total}^FS^XZ`).join('')
        device.send(zpl, () => setMessage('Etiquetas enviadas a Zebra.'), error => { setError(String(error?.message || error)); fallbackPrint() })
      }, () => { setError('No se detectó Zebra Browser Print; se abrirá la impresión PDF del navegador.'); fallbackPrint() })
    } else fallbackPrint()
  }

  const physicalToValidate = Number(physicalQuantity)
  const packageBalance = Number((physicalToValidate - Number(capacity) * Number(completePackages)).toFixed(3))
  const packageBreakdownValid = packageMode !== 'PACKAGES' || (Number.isInteger(Number(completePackages)) && Number(completePackages) >= 0 && Number(capacity) > 0 && packageBalance >= 0 && packageBalance < Number(capacity) && Number(completePackages) + (packageBalance > 0 ? 1 : 0) <= 100)
  const labelsPrinted = labels.length > 0 && labels.every(label => printedLabelCodes.includes(label.package_code))
  const hasPrintedLabels = labels.some(label => printedLabelCodes.includes(label.package_code))
  const selectedIptReceipts = selected ? receipts.filter(receipt => receipt.document_no === selected.document_no) : []
  const requiresVarianceReason = selected && physicalToValidate !== Number(selected.quantity)
  const canGenerate = selected?.validation_status === 'VALIDATED' && Number(selected.physical_quantity) > 0 && !['DIFFERENCE','MATCH','PENDING_PRINT'].includes(selected.label_status)
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
      <p className="mt-1 text-sm text-slate-600">Bandeja de ingresos pendientes de etiqueta. Busque por IPT, OT, contrato o lote; valide lo recibido y genere etiquetas por bulto.</p>
    </header>
    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
    {message && <p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">{message}</p>}

    <section className="rounded-xl border border-slate-200 bg-white p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div><h2 className="font-bold text-[#002855]">Ingresos sin etiqueta impresa</h2><p className="mt-1 text-xs text-slate-500">Incluye ingresos sin LPN y etiquetas generadas que siguen sin imprimirse; se actualiza automáticamente cada 30 segundos.</p><p className="mt-1 text-xs text-slate-400">{lastUpdated ? `Última actualización: ${lastUpdated.toLocaleTimeString('es-PE')}` : 'Consultando ingresos…'}</p></div>
        <button type="button" disabled={searching} onClick={() => void search()} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-[#002855] disabled:opacity-50"><RefreshCw size={15} className={searching ? 'animate-spin' : ''}/>Actualizar bandeja</button>
      </div>
      <div className="mt-3 flex gap-2">
        <input value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); void search() } }} placeholder="IPT (Nro_Documento), OT/contrato o lote…" className="min-w-0 flex-1 rounded-lg border border-slate-300 px-3 py-2.5 text-sm" />
        <button disabled={searching || query.trim().length < 2} onClick={() => void search()} className="rounded-lg bg-[#002855] px-4 text-sm font-bold text-white disabled:opacity-50">{searching ? 'Buscando…' : 'Buscar IPT'}</button>
      </div>
      <div className="mt-3 overflow-x-auto rounded-lg border">
        <table className="w-full min-w-[900px] text-left text-sm">
          <thead className="sticky top-0 bg-slate-50 text-xs text-slate-600"><tr>
            <th className="p-3">IPT · Fecha</th><th className="p-3">OT · Contrato</th><th className="p-3">Producto</th><th className="p-3">Lote</th>
            <th className="p-3 text-right">Cantidad ERP</th><th className="p-3">Cliente</th><th className="p-3">Estado</th><th className="p-3"></th>
          </tr></thead>
          <tbody className="divide-y">{receipts.map(receipt => <tr key={receipt.receipt_key} className="hover:bg-blue-50">
            <td className="p-3 font-semibold text-[#002855]">{receipt.document_no}<small className="block font-normal text-slate-500">{receipt.fecha} · {receipt.bodega}</small><small className="block font-normal text-slate-500">{receipt.document_type || '—'} · {receipt.color || '—'} · Actualizado {receipt.source_updated_at ? new Date(receipt.source_updated_at).toLocaleString('es-PE') : '—'}</small></td>
            <td className="p-3">{receipt.contract_code || '—'}</td><td className="p-3">{receipt.product_code}<small className="block text-slate-500">{receipt.description || '—'}</small></td>
            <td className="p-3">{receipt.lote || '—'}</td><td className="p-3 text-right tabular-nums">{receipt.quantity} {receipt.unit || ''}</td>
            <td className="p-3">{receipt.customer_name || 'Por ingresar'}</td><td className="p-3 text-xs">{receipt.validation_status === 'VALIDATED' ? 'Validado' : 'Pendiente'} · {receipt.label_status === 'NOT_LABELED' ? 'Sin etiqueta' : receipt.label_status === 'PENDING_PRINT' ? `${receipt.unprinted_count} por imprimir` : receipt.label_status}</td>
            <td className="p-3"><button type="button" onClick={() => select(receipt)} className="rounded-lg bg-[#002855] px-3 py-2 text-xs font-bold text-white">{receipt.label_status === 'PENDING_PRINT' ? 'Imprimir pendientes' : 'Recibir'}</button></td>
          </tr>)}
          {!searching && receipts.length===0 && <tr><td colSpan={8} className="p-8 text-center text-sm text-slate-500">{query.trim()?'No se encontraron ingresos para el criterio indicado.':'No hay ingresos pendientes de etiqueta en la última carga.'}</td></tr>}
          {searching && <tr><td colSpan={8} className="p-8 text-center text-sm text-slate-500">Cargando ingresos…</td></tr>}
          </tbody>
        </table>
      </div>
    </section>

    {selected && <div className="fixed inset-0 z-[80] flex items-end justify-center bg-slate-950/55 sm:items-center sm:p-4">
      <div role="dialog" aria-modal="true" aria-labelledby="wms-receipt-dialog-title" className="flex max-h-[100dvh] w-full max-w-7xl flex-col overflow-hidden bg-slate-50 shadow-2xl sm:max-h-[92dvh] sm:rounded-2xl">
        <header className="flex shrink-0 items-start justify-between gap-3 border-b border-slate-200 bg-white px-4 py-3 sm:px-6">
          <div className="min-w-0"><p className="text-[10px] font-extrabold uppercase tracking-[.16em] text-blue-700">Recepción APT · Validación y etiquetado</p><h2 id="wms-receipt-dialog-title" className="mt-1 truncate text-lg font-black text-[#002855] sm:text-xl">IPT {selected.document_no} · {selected.product_code}</h2><p className="mt-0.5 truncate text-xs text-slate-500 sm:text-sm">{selected.description || 'Producto'} · {selected.fecha} · Lote {selected.lote || '—'} · {selected.document_type || '—'} · Color {selected.color || '—'}</p></div>
          <button type="button" onClick={() => setSelected(null)} aria-label="Cerrar recepción" className="grid h-10 w-10 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-[#002855]"><X size={20}/></button>
        </header>
        {selectedIptReceipts.length > 1 && <nav aria-label={`Productos del IPT ${selected.document_no}`} className="shrink-0 border-b border-slate-200 bg-white px-3 py-2 sm:px-5"><div className="mb-1 text-[10px] font-bold uppercase tracking-wide text-slate-500">{selectedIptReceipts.length} líneas de producto en este IPT · seleccione una para validar y etiquetar</div><div className="flex gap-2 overflow-x-auto pb-1">{selectedIptReceipts.map((receipt, index) => <button key={receipt.receipt_key} type="button" onClick={() => select(receipt)} aria-current={receipt.receipt_key === selected.receipt_key ? 'true' : undefined} className={`min-w-48 shrink-0 rounded-lg border px-3 py-2 text-left text-xs ${receipt.receipt_key === selected.receipt_key ? 'border-[#002855] bg-blue-50 text-[#002855]' : 'border-slate-200 bg-white text-slate-700'}`}><span className="block font-bold">{index + 1}. {receipt.product_code}</span><span className="block truncate">{receipt.description || 'Producto'} · {receipt.contract_code || 'Sin OT'}</span><span className="mt-1 block font-semibold">{receipt.quantity} {receipt.unit || ''} · {receipt.label_status === 'NOT_LABELED' ? 'Sin etiqueta' : receipt.label_status}</span></button>)}</div></nav>}
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto overscroll-contain p-2 sm:p-4">
          {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
          {message && <p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">{message}</p>}
      <section className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
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
          <div className="mt-3 space-y-3">
            <div className="inline-flex rounded-lg bg-slate-100 p-1 text-xs font-semibold">
              <button type="button" disabled={selected.validation_status === 'VALIDATED'} onClick={() => setPackageMode('PACKAGES')} className={`rounded-md px-3 py-2 ${packageMode === 'PACKAGES' ? 'bg-white text-[#002855] shadow-sm' : 'text-slate-600'}`}>Paquetes completos + saldo</button>
              <button type="button" disabled={selected.validation_status === 'VALIDATED'} onClick={() => setPackageMode('TOTAL')} className={`rounded-md px-3 py-2 ${packageMode === 'TOTAL' ? 'bg-white text-[#002855] shadow-sm' : 'text-slate-600'}`}>Solo cantidad total</button>
            </div>
            {packageMode === 'PACKAGES' ? <div className="grid gap-3 rounded-lg border border-blue-100 bg-blue-50/50 p-3 sm:grid-cols-2 xl:grid-cols-4">
              <label className="text-sm font-semibold">Unidades por paquete/pallet<input type="number" min="0.001" step="0.001" value={capacity} onChange={event => setCapacity(event.target.value)} disabled={selected.validation_status === 'VALIDATED'} placeholder="Ej. 100" className="mt-1 w-full rounded-lg border px-3 py-2.5 font-normal disabled:bg-slate-100" /></label>
              <label className="text-sm font-semibold">Paquetes/pallets completos<input type="number" min="0" step="1" value={completePackages} onChange={event => setCompletePackages(event.target.value)} disabled={selected.validation_status === 'VALIDATED'} className="mt-1 w-full rounded-lg border px-3 py-2.5 font-normal disabled:bg-slate-100" /></label>
              <label className="text-sm font-semibold">Cantidad física total recibida<input type="number" min="0" step="0.001" value={physicalQuantity} onChange={event => setPhysicalQuantity(event.target.value)} disabled={selected.validation_status === 'VALIDATED'} className="mt-1 w-full rounded-lg border px-3 py-2.5 font-normal disabled:bg-slate-100" /></label>
              <div className="rounded-lg bg-white p-3 text-sm"><span className="text-slate-500">Unidades en el saldo · automático</span><b className="ml-2 text-lg text-[#002855]">{Number.isFinite(packageBalance) ? packageBalance : '—'} {selected.unit || ''}</b><small className="block text-slate-500">{Number(capacity) <= 0 ? 'Ingrese las unidades por paquete.' : packageBalance < 0 ? 'Los paquetes completos superan la cantidad física total.' : packageBalance >= Number(capacity) ? 'El saldo alcanza un paquete completo; aumente los paquetes completos.' : 'Total físico − (unidades por paquete × paquetes completos).'}</small></div>
              <div className="rounded-lg bg-white p-3 text-sm sm:col-span-2 xl:col-span-4"><span className="text-slate-500">Cantidad física que se registrará</span><b className="ml-2 text-lg text-[#002855]">{packageBreakdownValid ? physicalToValidate : 'Revise capacidad y paquetes completos'}</b> <span className="text-slate-500">{selected.unit || ''}</span><small className="block text-slate-500">El saldo se calcula automáticamente: cantidad física total − (unidades por paquete × paquetes completos).</small></div>
            </div> : <label className="block max-w-sm text-sm font-semibold">Cantidad física total recibida<input type="number" min="0" step="0.001" value={physicalQuantity} onChange={event => setPhysicalQuantity(event.target.value)} disabled={selected.validation_status === 'VALIDATED'} className="mt-1 w-full rounded-lg border px-3 py-2.5 font-normal disabled:bg-slate-100" /></label>}
            <div className="grid gap-3 sm:grid-cols-2">
              {requiresVarianceReason && <label className="text-sm font-semibold">Motivo de diferencia<input value={varianceReason} onChange={event => setVarianceReason(event.target.value)} disabled={selected.validation_status === 'VALIDATED'} placeholder="Explique la diferencia con el ERP" className="mt-1 w-full rounded-lg border px-3 py-2.5 font-normal disabled:bg-slate-100" /></label>}
              {!selected.customer_name && <label className="text-sm font-semibold">Nombre del cliente<input value={manualCustomer} onChange={event => setManualCustomer(event.target.value)} disabled={selected.validation_status === 'VALIDATED'} placeholder="Cliente de esta recepción" className="mt-1 w-full rounded-lg border px-3 py-2.5 font-normal disabled:bg-slate-100" /></label>}
            </div>
          </div>
          {selected.variance !== null && selected.validation_status === 'VALIDATED' && <p className="mt-2 text-sm text-slate-600">Diferencia registrada: {selected.variance} {selected.unit || ''}{selected.variance_reason ? ` · ${selected.variance_reason}` : ''}</p>}
          {selected.validation_status !== 'VALIDATED' && <button disabled={busy || !Number.isFinite(physicalToValidate) || physicalToValidate < 0 || !packageBreakdownValid || (packageMode === 'TOTAL' && !physicalQuantity) || (requiresVarianceReason && !varianceReason.trim()) || (!selected.customer_name && !manualCustomer.trim())} onClick={() => void validateReceipt()} className="mt-3 inline-flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2.5 text-sm font-bold text-white disabled:opacity-50"><ClipboardCheck size={17} />{busy ? 'Validando…' : 'Confirmar recepción física'}</button>}
        </div>
      </section>

      {selected.validation_status === 'VALIDATED' && <section className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
        <h3 className="font-bold text-[#002855]">4. Distribución de bultos y generación de LPN</h3>
        <p className="mt-1 text-sm text-slate-600">La suma de los bultos debe ser igual a la cantidad física confirmada: <b>{selected.physical_quantity} {selected.unit || ''}</b>.</p>
        {selected.label_status === 'PENDING_PRINT' ? <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">{labels.length} etiqueta(s) LPN ya generadas siguen pendientes de impresión. Use Vista previa para revisarlas y luego imprímalas; no se generarán códigos duplicados.</div> : selected.label_status === 'MATCH' ? <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950">Este ingreso ya tiene todas sus etiquetas impresas.</div> : <div className="mt-4 grid gap-3 sm:grid-cols-3">
          <label className="text-sm font-semibold">Unidades por bulto (opcional)<input type="number" min="0.001" step="0.001" value={capacity} onChange={event => { setCapacity(event.target.value); if (event.target.value) setCount(String(Math.ceil(Number(selected.physical_quantity) / Number(event.target.value)))) }} placeholder={sizes[selected.product_code.toUpperCase()] ? String(sizes[selected.product_code.toUpperCase()].units_per_package) : 'Sin estándar'} className="mt-1 w-full rounded-lg border px-3 py-2.5 font-normal" /></label>
          <label className="text-sm font-semibold">Bultos a generar<input type="number" min="1" max="100" value={count} onChange={event => setCount(event.target.value)} className="mt-1 w-full rounded-lg border px-3 py-2.5 font-normal" /><small className="mt-1 block font-normal text-slate-500">Embalaje estándar: {sizes[selected.product_code.toUpperCase()] ? `${sizes[selected.product_code.toUpperCase()].units_per_package} ${sizes[selected.product_code.toUpperCase()].unit || selected.unit || ''}` : 'no configurado'}</small></label>
          <div className="flex items-end"><button disabled={busy || !canGenerate || Number(count) < 1 || Number(count) > 100} onClick={() => void generate()} className="inline-flex items-center gap-2 rounded-lg bg-[#002855] px-4 py-2.5 font-bold text-white disabled:opacity-50">{busy ? <RotateCcw className="animate-spin" size={17} /> : <ScanLine size={17} />}Generar bultos y LPN</button></div>
        </div>}
        {Number(selected.physical_quantity) === 0 ? <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-900">La recepción quedó registrada con cantidad cero; no hay bultos para etiquetar.</p> : <>
          <div className="mt-4 grid gap-2 sm:grid-cols-3"><div className="rounded-lg bg-blue-50 p-3 text-sm"><span className="text-slate-600">Etiquetas previstas</span><b className="block text-xl text-[#002855]">{planCount}</b></div><div className="rounded-lg bg-blue-50 p-3 text-sm"><span className="text-slate-600">Unidades físicas</span><b className="block text-xl text-[#002855]">{planQuantity} {selected.unit || ''}</b></div><div className="rounded-lg bg-blue-50 p-3 text-sm"><span className="text-slate-600">Saldo de distribución</span><b className="block text-xl text-[#002855]">{planRemaining} {selected.unit || ''}</b></div></div>
          {plannedPackages.length > 0 && <div className="mt-3 max-h-56 overflow-auto rounded-lg border"><table className="w-full text-left text-sm"><thead className="sticky top-0 bg-slate-50"><tr><th className="p-2">Bulto</th><th className="p-2">Cantidad</th><th className="p-2">Tipo</th></tr></thead><tbody>{plannedPackages.map(row => <tr key={row.sequence} className="border-t"><td className="p-2">{row.sequence}</td><td className="p-2">{row.quantity} {selected.unit || ''}</td><td className="p-2">{row.kind}</td></tr>)}</tbody></table></div>}
        </>}
      </section>}
        </div>
        <footer className="flex shrink-0 flex-col gap-2 border-t border-slate-200 bg-white p-3 sm:flex-row sm:items-center sm:justify-between sm:px-5">
          <p className="text-xs text-slate-500">Conteo físico → distribución → LPN → impresión</p>
          <div className="flex gap-2">{labels.length > 0 && <button type="button" onClick={() => { setSelected(null); setShowPreview(true) }} className="min-h-10 flex-1 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-[#002855] sm:flex-none">Vista previa</button>}<button type="button" onClick={() => setSelected(null)} className="min-h-10 flex-1 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 sm:flex-none">Cerrar</button><button type="button" disabled={!labels.length} onClick={() => void print()} className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none"><Printer size={16}/>{labelsPrinted ? 'Reimprimir lote' : hasPrintedLabels ? 'Imprimir pendientes' : 'Imprimir lote'}</button></div>
        </footer>
      </div>
    </div>}

    {labels.length > 0 && showPreview && <div id="wms-label-preview" role="dialog" aria-modal="true" aria-labelledby="wms-label-preview-title" className="fixed inset-0 z-[70] flex items-center justify-center bg-slate-950/60 p-2 sm:p-5 print:static print:block print:bg-transparent print:p-0" onClick={() => setShowPreview(false)}>
      <section className="flex max-h-[96dvh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl print:contents" onClick={event => event.stopPropagation()}>
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-6">
          <div><h2 id="wms-label-preview-title" className="font-bold text-[#002855]">Vista previa de etiquetas · {labels.length}</h2><p className="text-xs text-slate-500">Revise cada bulto, cantidad y código LPN antes de imprimir.</p></div>
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setShowPreview(false)} className="min-h-10 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700">Cerrar vista previa</button>
            <button type="button" onClick={() => void print()} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-[#002855] px-4 py-2.5 text-sm font-bold text-white"><Printer size={16} />{labelsPrinted ? 'Reimprimir lote' : 'Imprimir lote'}</button>
            <button type="button" aria-label="Cerrar vista previa" onClick={() => setShowPreview(false)} className="grid h-10 w-10 place-items-center rounded-lg border border-slate-300 text-slate-600"><X size={18}/></button>
          </div>
        </header>
        <div className="wms-label-list min-h-0 flex-1 overflow-y-auto p-3 sm:p-6 print:overflow-visible print:p-0">
          <div className="grid gap-3 sm:grid-cols-2 print:block">{labels.filter(label => printTarget === null || label.package_code === printTarget).map(label => (
            <article key={label.package_code} className="wh-label flex aspect-[3/2] min-w-0 flex-col overflow-hidden rounded-lg border-2 border-dashed border-slate-500 bg-white p-2.5 text-black sm:p-3">
              <div className="wh-label-head flex min-h-0 items-center gap-2 border-b-4 border-[#002855] pb-1">
                <div className="flex h-full w-[22%] shrink-0 items-center justify-center border-r border-slate-400 bg-[#002855] p-1">
                  <img src="/logo-jrm.png" alt="JRM Soluciones Integrales de Almacenamiento" className="max-h-full max-w-full object-contain" />
                </div>
                <div className="grid min-w-0 flex-1 grid-cols-2 gap-x-2 gap-y-1 leading-tight">
                  <div className="col-span-2 truncate text-sm sm:text-lg"><b className="text-[#002855]">Cliente:</b> <span className="font-bold">{label.customer_name || 'Por registrar'}</span></div>
                  <div className="truncate text-xs sm:text-base"><b className="text-[#002855]">OT:</b> <span className="font-bold">{label.contract_code || '—'}</span></div>
                  <div className="truncate text-xs sm:text-base"><b className="text-[#002855]">Lote:</b> <span className="font-bold">{label.source_lot || '—'} · {label.source_warehouse}</span></div>
                </div>
              </div>
              <b className="wh-label-sku mt-1 max-w-[52%] truncate rounded-r-md bg-[#002855] px-2 py-1 text-base text-white sm:text-2xl">{label.source_product_code}</b>
              <div className="wh-label-description mt-1 line-clamp-2 min-h-0 flex-1 overflow-hidden text-xs leading-tight sm:text-base">{label.description}</div>
              <Code128Barcode value={label.package_code} height={84} className="wh-label-barcode mx-auto my-0.5 h-9 w-[92%] shrink-0" />
              <b className="wh-label-lpn block shrink-0 text-center font-mono text-sm sm:text-xl">{label.package_code}</b>
              <div className="wh-label-footer grid shrink-0 grid-cols-[1fr_auto_1fr] items-center gap-1 border-t border-slate-400 pt-1">
                <div className="min-w-0 text-[9px] leading-tight sm:text-xs"><div className="truncate"><b className="text-[#002855]">IPT:</b> {label.source_document_no}</div><div><b className="text-[#002855]">Fecha:</b> {label.source_date}</div></div>
                <div className="flex min-w-0 items-baseline justify-center gap-1 whitespace-nowrap"><b className="wh-label-quantity text-xl leading-none sm:text-3xl">{label.quantity} {label.unit || ''}</b><span className="text-[9px] sm:text-sm">· {label.weight_kg === null ? 'Peso por registrar' : label.weight_kg + ' kg'}</span></div>
                <div className="text-right text-[10px] sm:text-sm">{label.sequence_no}/{label.sequence_total}<button type="button" onClick={() => void print([label])} className="print:hidden mt-1 block rounded-md border border-slate-300 px-2 py-1 text-[10px] font-bold text-[#002855]">{printedLabelCodes.includes(label.package_code) ? 'Reimprimir etiqueta' : 'Imprimir etiqueta'}</button></div>
              </div>
            </article>
          ))}</div>
        </div>
      </section>
    </div>}
    <style jsx global>{`@media print{
      @page{size:152.4mm 101.6mm;margin:0}
      html,body{width:152.4mm!important;min-width:0!important;margin:0!important;padding:0!important}
      body *{visibility:hidden!important}
      #wms-label-preview,#wms-label-preview *{visibility:visible!important}
      #wms-label-preview{position:absolute!important;inset:0 auto auto 0!important;z-index:auto!important;display:block!important;width:152.4mm!important;height:auto!important;max-height:none!important;overflow:visible!important;margin:0!important;padding:0!important;background:#fff!important}
      #wms-label-preview>section{display:block!important;width:auto!important;max-width:none!important;height:auto!important;max-height:none!important;overflow:visible!important;border:0!important;border-radius:0!important;background:transparent!important;box-shadow:none!important}
      #wms-label-preview header{display:none!important}
      #wms-label-preview .wms-label-list{display:block!important;width:152.4mm!important;height:auto!important;max-height:none!important;overflow:visible!important;margin:0!important;padding:0!important}
      #wms-label-preview button{display:none!important}
      .wh-label{box-sizing:border-box;position:relative;display:flex!important;flex-direction:column;break-after:page;page-break-after:always;width:152.4mm!important;height:101.6mm!important;aspect-ratio:auto;border:1px dashed #6b8198!important;border-radius:0!important;padding:2mm!important;margin:0!important;overflow:hidden!important}
      .wh-label-head{height:18mm!important;min-height:18mm!important;flex:none!important}
      .wh-label-sku{height:9mm!important;max-height:9mm!important;margin-top:2mm!important;padding:0 2mm!important;font-size:7mm!important;line-height:9mm!important}
      .wh-label-description{height:19mm!important;max-height:19mm!important;margin-top:2mm!important;font-size:5mm!important;line-height:5.4mm!important}
      .wh-label-barcode{height:22mm!important;max-height:22mm!important;min-height:22mm!important;margin:0 auto!important}
      .wh-label-lpn{height:10mm!important;font-size:7.2mm!important;line-height:10mm!important}
      .wh-label-footer{height:13mm!important;min-height:13mm!important;margin-top:2mm!important;padding-top:2mm!important;border-top:0.3mm solid #7a8793!important}
      .wh-label-quantity{font-size:10mm!important;line-height:1!important}
      .wh-label:last-child{break-after:auto;page-break-after:auto}
    }`}</style>
  </div>
}
