'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { createClient } from '@/lib/supabase/client'
import { Printer, RotateCcw, ScanLine, ClipboardCheck, X, RefreshCw, UserRound, Weight, Package, PackagePlus, Download, Undo2 } from 'lucide-react'
import { loadReceiptLpn, type ReceiptLpn } from '@/lib/warehouse/receipt-lpn'
import { buildBultoContentPdf, contentSheetFormat, fmt } from '@/lib/warehouse/packing-list'
import { PackageLabelPreview } from '@/components/warehouse/PackageLabel'
import type { PackageLabelData as Label } from '@/lib/warehouse/package-label'
import { loadPackageLabels } from '@/lib/warehouse/load-package-label'
import { printPackageLabels, validatePackageLabelPrint } from '@/components/warehouse/print-package-labels'
import Link from 'next/link'
import { useLabelFormat } from '@/lib/warehouse/label-format'
import { DataTable } from '@/components/ui/data-table'
import { TablePagination } from '@/components/ui/table-pagination'
import { usePagination } from '@/lib/use-pagination'

type Receipt = {
  receipt_key: string; document_no: string; fecha: string; document_type: string | null; color: string | null; source_updated_at: string | null; bodega: string; lote: string | null
  product_code: string; description: string | null; unit: string | null; contract_code: string | null
  quantity: number; weight_kg: number | null; customer_name: string | null; customer_source: 'ERP/OT' | 'MANUAL' | null
  physical_quantity: number | null; variance: number | null; variance_reason: string | null
  validation_status: 'PENDING' | 'STALE' | 'VALIDATED'; label_count: number; labeled_qty: number; unprinted_count: number; pending_labels: (Label & { lpn_code?: string | null })[]; label_status: string
}
/** OT/contrato normalizada como en el servidor (sin símbolos ni prefijo OT). */
// Número de OT (16571 en «16571-S002-022»): cada línea del contrato trae su propio sufijo. Igual que en wh_receipt_consolidate_lpn.
const otKey = (value: string | null) => { const v = (value || '').toUpperCase(); return v.match(/[0-9]{5,6}/)?.[0] || v.replace(/[^A-Z0-9]/g, '') }
const sameText = (a: string | null, b: string | null) => (a || '').trim().toUpperCase() === (b || '').trim().toUpperCase()
const lpnOf = (receipt: Receipt) => receipt.pending_labels?.find(label => label.lpn_code)?.lpn_code || null


export default function WarehouseLabelingPage() {
  const selectionRequest = useRef(0)
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
  // LPN de recepción en pantalla: se imprime solo su etiqueta (y su hoja de contenido), no las de sus líneas.
  const [lpn, setLpn] = useState<ReceiptLpn | null>(null)
  // Líneas marcadas para consolidar, en el orden en que se marcaron (la primera define el lote del número del LPN).
  const [checked, setChecked] = useState<string[]>([])
  const labelFormat = useLabelFormat('PAQUETE')
  // Período de la bandeja (por defecto solo hoy) y orden del ingreso más reciente al más antiguo. Una búsqueda ignora el período.
  const [period, setPeriod] = useState<Period>('HOY')
  const [from, setFrom] = useState(() => limaDay(0))
  const [to, setTo] = useState(() => limaDay(0))
  const visible = filterAndSort(receipts, query.trim() ? null : periodRange(period, from, to))
  const pager = usePagination(visible, 'wms-etiquetado')
  const [printedLabelCodes, setPrintedLabelCodes] = useState<string[]>([])
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


  const select = async (receipt: Receipt) => {
    const request = ++selectionRequest.current
    if (selected?.document_no !== receipt.document_no) setChecked([])
    setSelected(receipt); setLabels([]); setLpn(null); setPrintedLabelCodes([]); setShowPreview(false); setMessage(''); setError('')
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
    const codes = (receipt.pending_labels || []).map(label => label.package_code)
    const lpnCode = lpnOf(receipt)
    setBusy(codes.length > 0)
    if (lpnCode) {
      try { const loaded = await loadReceiptLpn(createClient(), lpnCode); if (request === selectionRequest.current && loaded) { setLpn(loaded.lpn); setLabels([loaded.label]) } }
      catch(e) { if (request === selectionRequest.current) setError(e instanceof Error ? e.message : String(e)) }
      finally { if (request === selectionRequest.current) setBusy(false) }
    } else if (codes.length) {
      try { const pending = await loadPackageLabels(createClient(), codes); if (request === selectionRequest.current) setLabels(pending) }
      catch(e) { if (request === selectionRequest.current) setError(e instanceof Error ? e.message : String(e)) }
      finally { if (request === selectionRequest.current) setBusy(false) }
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
    const { data, error: rpcError } = await createClient().rpc('wh_label_package', {
      p_receipt_key: selected.receipt_key,
      p_package_count: packageCount,
      p_units_per_package: per,
    })
    if (rpcError) { setError(rpcError.message); setBusy(false); return }
    const codes = (data?.package_codes || []) as string[]
    let generated:Label[]
    try{generated=await loadPackageLabels(createClient(),codes)}catch(e){setError(e instanceof Error?e.message:String(e));setBusy(false);return}
    setLabels(generated); setPrintedLabelCodes([]); setShowPreview(false)
    setMessage(`${codes.length} etiqueta(s) únicas generadas desde el conteo físico del IPT ${selected.document_no}.`)
    setBusy(false)
  }

  const print = async (targetLabels: Label[] = labels) => {
    if(busy||!targetLabels.length)return
    setBusy(true);setError('')
    try {
    validatePackageLabelPrint(labelFormat)
    if (lpn) {
      const db = createClient()
      if (lpn.print_count > 0) {
        const reason = window.prompt('Motivo de reimpresión de la etiqueta del LPN:')
        if (!reason?.trim()) return
        const { error: rpcError } = await db.rpc('wh_reprint_lpn_label', { p_lpn_code: lpn.lpn_code, p_reason: reason.trim() })
        if (rpcError) { setError(rpcError.message); return }
      } else {
        const { error: rpcError } = await db.rpc('wh_print_lpn_label', { p_lpn_id: lpn.id })
        if (rpcError) { setError(rpcError.message); return }
        void search()
      }
      setLpn({ ...lpn, print_count: lpn.print_count + 1 }); setPrintedLabelCodes([lpn.lpn_code])
      const method = await printPackageLabels(targetLabels, labelFormat)
      setMessage(`${method === 'ZEBRA' ? 'Etiqueta del LPN enviada a Zebra.' : 'Impresión de la etiqueta del LPN preparada.'} Imprima también su hoja de contenido y péguela en el pallet.`)
      return
    }
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
      // Una recepción ya impresa sale de la bandeja (solo pendientes): se recarga sin esperar los 30 s
      void search()
    }
    setPrintedLabelCodes(current => [...new Set([...current, ...targetLabels.map(label => label.package_code)])])
      const method=await printPackageLabels(targetLabels,labelFormat)
      setMessage(method==='ZEBRA'?'Etiquetas enviadas a Zebra con el mismo diseño de la vista previa.':'Impresión preparada con el mismo diseño de la vista previa.')
    } catch(e) {setError(e instanceof Error?e.message:String(e))}finally{setBusy(false)}
  }

  // Varias líneas validadas (mismo cliente y OT) en un solo LPN: el servidor vuelve a comprobar todas las reglas.
  const consolidate = async () => {
    if (busy || checked.length < 2) return
    setBusy(true); setError(''); setMessage('')
    try {
      const db = createClient()
      const { data, error: rpcError } = await db.rpc('wh_receipt_consolidate_lpn', { p_receipt_keys: checked, p_client_event_id: crypto.randomUUID() })
      if (rpcError) { setError(rpcError.message); return }
      const loaded = await loadReceiptLpn(db, (data as ReceiptLpn).lpn_code)
      if (!loaded) throw new Error('El LPN se creó, pero no se pudo recuperar su contenido. Actualice la bandeja y ábralo desde una de sus líneas.')
      setLpn(loaded.lpn); setLabels([loaded.label]); setPrintedLabelCodes([]); setChecked([])
      setMessage(`LPN ${loaded.lpn.lpn_code} creado con ${loaded.lpn.packages.length} líneas. Imprima solo la etiqueta del LPN y su hoja de contenido.`)
      void search()
      setSelected(null); setShowPreview(true)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const downloadContent = async () => {
    if (!lpn) return
    try {
      const { pdf } = await buildBultoContentPdf(lpn, { client_name: labels[0]?.customer_name || null, contract_code: labels[0]?.contract_code || null, request_number: null }, { reception: true })
      pdf.save(`contenido-${lpn.lpn_code}.pdf`)
    } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
  }
  const undoLpn = async () => {
    if (!lpn || busy) return
    const reason = window.prompt(`Motivo para deshacer el LPN ${lpn.lpn_code} (sus líneas vuelven a la bandeja para etiquetarse por separado):`)
    if (!reason?.trim()) return
    setBusy(true); setError('')
    const { error: rpcError } = await createClient().rpc('wh_lpn_undo', { p_lpn_id: lpn.id, p_reason: reason.trim() })
    setBusy(false)
    if (rpcError) { setError(rpcError.message); return }
    setMessage(`LPN ${lpn.lpn_code} deshecho. Sus líneas vuelven a la bandeja para imprimir sus etiquetas individuales.`)
    setLpn(null); setLabels([]); setShowPreview(false); setSelected(null)
    void search()
  }

  const physicalToValidate = Number(physicalQuantity)
  const packageBalance = Number((physicalToValidate - Number(capacity) * Number(completePackages)).toFixed(3))
  const packageBreakdownValid = packageMode !== 'PACKAGES' || (Number.isInteger(Number(completePackages)) && Number(completePackages) >= 0 && Number(capacity) > 0 && packageBalance >= 0 && packageBalance < Number(capacity) && Number(completePackages) + (packageBalance > 0 ? 1 : 0) <= 100)
  const labelsPrinted = labels.length > 0 && labels.every(label => printedLabelCodes.includes(label.package_code))
  const hasPrintedLabels = labels.some(label => printedLabelCodes.includes(label.package_code))
  const selectedIptReceipts = selected ? receipts.filter(receipt => receipt.document_no === selected.document_no) : []
  const iptErpTotal = selectedIptReceipts.reduce((sum, receipt) => sum + Number(receipt.quantity || 0), 0)
  const iptPendingCount = selectedIptReceipts.filter(receipt => receipt.validation_status !== 'VALIDATED').length
  const firstChecked = receipts.find(receipt => receipt.receipt_key === checked[0])
  const canCheck = (receipt: Receipt) => receipt.validation_status === 'VALIDATED' && receipt.label_status === 'NOT_LABELED' && Number(receipt.physical_quantity) > 0 &&
    (!firstChecked || (otKey(receipt.contract_code) === otKey(firstChecked.contract_code) && sameText(receipt.customer_name, firstChecked.customer_name)))
  // «Marcar todas»: las líneas consolidables del IPT del mismo cliente y OT que la primera marcada (o la primera disponible).
  const lpnAnchor = firstChecked || selectedIptReceipts.find(r => r.validation_status === 'VALIDATED' && r.label_status === 'NOT_LABELED' && Number(r.physical_quantity) > 0)
  const lpnCandidates = lpnAnchor ? selectedIptReceipts.filter(r => r.validation_status === 'VALIDATED' && r.label_status === 'NOT_LABELED' && Number(r.physical_quantity) > 0 &&
    otKey(r.contract_code) === otKey(lpnAnchor.contract_code) && sameText(r.customer_name, lpnAnchor.customer_name)) : []
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

  return <div className="w-full space-y-5">
    <header>
      <p className="text-xs font-bold uppercase tracking-widest text-blue-700">WMS · Recepción APT</p>
      <h1 className="mt-1 text-3xl font-black text-[#002855]">Recepción, validación y etiquetado</h1>
      <p className="mt-1 text-sm text-slate-600">Bandeja de ingresos pendientes de etiqueta. Busque por IPT, OT, contrato o lote; valide lo recibido y genere etiquetas por bulto.</p>
      <Link href="/almacen/maestros/etiquetas" className="mt-2 inline-flex text-sm font-semibold text-[#002855] underline underline-offset-2">Configuración de etiquetas</Link>
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
      <div className="mt-3 flex flex-wrap items-center gap-2 text-sm" role="group" aria-label="Período">
        {PERIODS.map(([value, label]) => <button key={value} type="button" aria-pressed={period === value} onClick={() => setPeriod(value)}
          className={`rounded-lg border px-3 py-1.5 font-semibold ${period === value ? 'border-[#002855] bg-[#002855] text-white' : 'border-slate-300 text-[#002855] hover:bg-slate-50'}`}>{label}</button>)}
        {period === 'RANGO' && <>
          <label className="flex items-center gap-1 text-xs text-slate-600">Desde<input type="date" value={from} max={to} onChange={e => setFrom(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1 text-sm" /></label>
          <label className="flex items-center gap-1 text-xs text-slate-600">Hasta<input type="date" value={to} min={from} onChange={e => setTo(e.target.value)} className="rounded-lg border border-slate-300 px-2 py-1 text-sm" /></label>
        </>}
        {query.trim() && <span className="text-xs text-slate-500">La búsqueda incluye todas las fechas.</span>}
      </div>
      <div className="mt-3 overflow-x-auto rounded-lg border">
        <DataTable dense className="min-w-[900px] lg:min-w-0 w-full text-left text-sm">
          <thead className="sticky top-0 bg-slate-50 text-xs text-slate-600"><tr>
            <th className="p-3">IPT · Fecha</th><th className="p-3">OT · Contrato</th><th className="p-3">Producto</th><th className="p-3">Lote</th>
            <th className="p-3 text-right">Cantidad ERP</th><th className="p-3">Cliente</th><th className="p-3">Estado</th><th className="p-3"></th>
          </tr></thead>
          <tbody className="divide-y">{pager.pageRows.map(receipt => <tr key={receipt.receipt_key} className="hover:bg-blue-50">
            <td className="p-3 font-semibold text-[#002855]">{receipt.document_no}<small className="block font-normal text-slate-500">{receipt.fecha} · {receipt.bodega}</small><small className="block font-normal text-slate-500">{receipt.document_type || '—'} · {receipt.color || '—'} · Actualizado {receipt.source_updated_at ? new Date(receipt.source_updated_at).toLocaleString('es-PE') : '—'}</small></td>
            <td className="p-3">{receipt.contract_code || '—'}</td><td className="p-3">{receipt.product_code}<small className="block text-slate-500">{receipt.description || '—'}</small></td>
            <td className="p-3">{receipt.lote || '—'}</td><td className="p-3 text-right tabular-nums">{receipt.quantity} {receipt.unit || ''}</td>
            <td className="p-3">{receipt.customer_name || 'Por ingresar'}</td><td className="p-3 text-xs">{receipt.validation_status === 'VALIDATED' ? 'Validado' : 'Pendiente'} · {receipt.label_status === 'NOT_LABELED' ? 'Sin etiqueta' : receipt.label_status === 'PENDING_PRINT' ? `${receipt.unprinted_count} por imprimir` : receipt.label_status}</td>
            <td className="p-3"><button type="button" onClick={() => select(receipt)} className="rounded-lg bg-[#002855] px-3 py-2 text-xs font-bold text-white">{receipt.label_status === 'PENDING_PRINT' ? 'Imprimir pendientes' : 'Recibir'}</button></td>
          </tr>)}
          {!searching && visible.length===0 && <tr><td colSpan={8} className="p-8 text-center text-sm text-slate-500">{query.trim()?'No hay ingresos pendientes de etiqueta para ese criterio. Las recepciones ya etiquetadas se consultan en «03 · Control de recepción».':'No hay ingresos pendientes de etiqueta en el período elegido. Prueba con Semana, Mes o Personalizado.'}</td></tr>}
          {searching && <tr><td colSpan={8} className="p-8 text-center text-sm text-slate-500">Cargando ingresos…</td></tr>}
          </tbody>
        </DataTable>
      </div>
      {pager.total > 0 && <TablePagination total={pager.total} page={pager.page} pageSize={pager.pageSize} onPageChange={pager.setPage} onPageSizeChange={pager.setPageSize} itemLabel="ingresos" compact />}
    </section>

    {selected && typeof document !== 'undefined' && createPortal(<div className="fixed inset-0 z-[2147483000] flex items-center justify-center bg-slate-950/60 p-2 sm:p-3">
      <div role="dialog" aria-modal="true" aria-labelledby="wms-receipt-dialog-title" className="flex h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)] w-full max-w-[1600px] flex-col overflow-hidden rounded-xl bg-slate-50 shadow-2xl sm:h-[calc(100dvh-1.5rem)] sm:max-h-[calc(100dvh-1.5rem)] sm:rounded-2xl">
        <header className="flex h-11 shrink-0 items-center justify-between border-b border-blue-100 bg-gradient-to-r from-blue-50 to-white px-4 sm:px-6">
          <h2 id="wms-receipt-dialog-title" className="flex items-center gap-2 text-sm font-black uppercase tracking-wide text-[#002855]"><span className="grid h-7 w-7 place-items-center rounded-md bg-blue-100 text-blue-800"><ClipboardCheck size={17}/></span>WMS · Recepción APT</h2>
          <button type="button" onClick={() => setSelected(null)} aria-label="Cerrar recepción" className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-slate-500 hover:bg-slate-100 hover:text-[#002855]"><X size={20}/></button>
        </header>
        <div className="min-h-0 flex-1 space-y-2 overflow-y-auto overscroll-contain p-2 sm:space-y-3 sm:p-4">
          <section aria-label="Datos principales del ingreso" className="grid gap-2 sm:grid-cols-3">
            <div className="flex min-h-16 items-center gap-3 rounded-xl border border-blue-100 bg-blue-50/70 px-3 py-2"><span className="text-blue-700"><UserRound size={23}/></span><div className="min-w-0"><span className="block text-[11px] text-slate-600">Cliente</span><b className="block truncate text-sm leading-tight text-[#002855]">{selected.customer_name || manualCustomer || 'Por registrar'}</b></div></div>
            <div className="flex min-h-16 items-center gap-3 rounded-xl border border-blue-100 bg-blue-50/70 px-3 py-2"><span className="text-blue-700"><Weight size={23}/></span><div><span className="block text-[11px] text-slate-600">Peso de origen</span><b className="block text-lg leading-tight text-[#002855]">{selected.weight_kg === null ? 'Por registrar' : selected.weight_kg + ' kg'}</b></div></div>
            <div className="flex min-h-16 items-center gap-3 rounded-xl bg-gradient-to-r from-blue-700 to-blue-900 px-3 py-2 text-white"><span><Package size={23}/></span><div><span className="block text-[11px] text-blue-100">Total ERP (ítem seleccionado)</span><b className="block text-lg leading-tight">{selected.quantity} {selected.unit || 'UND'}</b></div></div>
          </section>
          <section className="rounded-xl border border-slate-200 bg-white px-3 py-2 sm:px-4">
            <p className="text-[10px] font-extrabold uppercase tracking-wide text-blue-700">Recepción APT · Validación y etiquetado</p>
            <h3 className="truncate text-lg font-black leading-tight text-[#002855] sm:text-xl">IPT {selected.document_no} · {selected.product_code}</h3>
            <p className="truncate text-xs text-slate-600">{selected.description || 'Producto'}</p>
            <div className="mt-2 grid grid-cols-2 gap-1.5 text-[11px] sm:grid-cols-4">
              <span className="truncate rounded-lg bg-blue-50 px-2 py-1.5"><b>Fecha:</b> {selected.fecha}</span>
              <span className="truncate rounded-lg bg-blue-50 px-2 py-1.5"><b>Lote:</b> {selected.lote || '—'}</span>
              <span className="truncate rounded-lg bg-blue-50 px-2 py-1.5"><b>Bodega:</b> {selected.bodega}</span>
              <span className="truncate rounded-lg bg-blue-50 px-2 py-1.5"><b>OT/Contrato:</b> {selected.contract_code || '—'}</span>
            </div>
          </section>
          {selectedIptReceipts.length > 1 && <section aria-label={'Ítems recibidos del IPT ' + selected.document_no} className="rounded-xl border border-blue-100 bg-white p-3 sm:p-4">
            <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
              <h3 className="font-bold text-[#002855]">2. Ítems recibidos</h3>
              <div className="flex flex-wrap gap-2 text-xs">
                <span className="rounded-lg bg-blue-50 px-3 py-2 font-semibold text-blue-900">{selectedIptReceipts.length} ítems recibidos</span>
                <span className="rounded-lg bg-blue-50 px-3 py-2 font-semibold text-blue-900">Total ERP: {iptErpTotal} {selected.unit || 'UND'}</span>
                <span className="rounded-lg bg-amber-50 px-3 py-2 font-semibold text-amber-950">{iptPendingCount} pendiente(s) de validar</span>
                <button type="button" disabled={busy || checked.length < 2} onClick={() => void consolidate()} title="Marque dos o más líneas validadas sin etiqueta, del mismo cliente y OT" className="inline-flex items-center gap-1.5 rounded-lg bg-[#002855] px-3 py-2 font-bold text-white disabled:opacity-40"><PackagePlus size={15}/>Consolidar en LPN ({checked.length})</button>
              </div>
            </div>
            <div className="max-h-56 overflow-auto rounded-lg border border-slate-200">
              <table className="min-w-[900px] lg:min-w-0 w-full text-left text-xs">
                <thead className="sticky top-0 bg-slate-50 text-slate-600"><tr><th className="w-10 p-2"></th><th className="w-12 p-2"><label className="flex items-center gap-1">LPN<input type="checkbox" className="h-4 w-4" aria-label="Marcar todas las líneas que se pueden consolidar"
                  checked={lpnCandidates.length > 1 && lpnCandidates.every(r => checked.includes(r.receipt_key))} disabled={lpnCandidates.length < 2}
                  onChange={event => setChecked(event.target.checked ? lpnCandidates.map(r => r.receipt_key) : [])}/></label></th><th className="p-2">#</th><th className="p-2">IPT / Código</th><th className="p-2">Descripción</th><th className="p-2">Lote</th><th className="p-2">Cliente</th><th className="p-2 text-right">ERP</th><th className="p-2">Estado</th></tr></thead>
                <tbody>{selectedIptReceipts.map((receipt, index) => <tr key={receipt.receipt_key} className={receipt.receipt_key === selected.receipt_key ? 'border-t border-blue-200 bg-blue-50' : 'border-t border-slate-200'}>
                  <td className="p-2"><button type="button" onClick={() => select(receipt)} aria-label={'Seleccionar ' + receipt.product_code} aria-pressed={receipt.receipt_key === selected.receipt_key} className={receipt.receipt_key === selected.receipt_key ? 'grid h-6 w-6 place-items-center rounded-full border border-blue-700 bg-blue-700 text-white' : 'grid h-6 w-6 place-items-center rounded-full border border-slate-400 bg-white text-transparent'}>●</button></td>
                  <td className="p-2"><input type="checkbox" className="h-4 w-4" aria-label={'Consolidar ' + receipt.product_code + ' en el LPN'} checked={checked.includes(receipt.receipt_key)} disabled={busy || (!checked.includes(receipt.receipt_key) && !canCheck(receipt))}
                    title={canCheck(receipt) || checked.includes(receipt.receipt_key) ? 'Incluir en el LPN' : 'Solo líneas validadas sin etiqueta, del mismo cliente y OT que la primera marcada'}
                    onChange={event => { const key = receipt.receipt_key; setChecked(current => event.target.checked ? [...current, key] : current.filter(k => k !== key)) }}/></td>
                  <td className="p-2">{index + 1}</td>
                  <td className="p-2 font-semibold text-[#002855]">{receipt.document_no}<span className="block font-normal">{receipt.product_code} · {receipt.contract_code || '—'}</span></td>
                  <td className="max-w-72 p-2">{receipt.description || receipt.product_code}</td>
                  <td className="p-2">{receipt.lote || '—'}</td>
                  <td className="max-w-52 p-2">{receipt.customer_name || 'Por ingresar'}</td>
                  <td className="p-2 text-right font-bold text-blue-800">{receipt.quantity} {receipt.unit || ''}</td>
                  <td className="p-2"><span className={receipt.validation_status === 'VALIDATED' ? 'whitespace-nowrap rounded-full bg-emerald-100 px-2 py-1 text-emerald-900' : 'whitespace-nowrap rounded-full bg-amber-100 px-2 py-1 text-amber-950'}>{receipt.validation_status === 'VALIDATED' ? 'Validado' : 'Pendiente'}</span>{lpnOf(receipt) && <span className="ml-1 whitespace-nowrap rounded-full bg-blue-100 px-2 py-1 text-blue-900">LPN {lpnOf(receipt)}</span>}</td>
                </tr>)}</tbody>
              </table>
            </div>
            <p className="mt-2 text-[11px] text-slate-500">Seleccione un ítem para validar su conteo físico y emitir sus etiquetas por separado. Para armar un solo pallet, marque en «LPN» dos o más líneas validadas sin etiqueta, del mismo cliente y OT, y use «Consolidar en LPN»: se imprime solo la etiqueta del LPN y su hoja de contenido.</p>
          </section>}
          {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}
          {message && <p role="status" className="rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-900">{message}</p>}
      <section className="rounded-xl border border-slate-200 bg-white p-3 sm:p-4">
{selected.validation_status === 'STALE' && <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">El ingreso del ERP cambió después de la última validación. Revise el historial de etiquetas y coordine su anulación antes de validar otra vez.</p>}
        {selected.label_status === 'DIFFERENCE' && <p className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">La suma de etiquetas existentes no coincide con el conteo físico validado. No se generarán etiquetas adicionales.</p>}
        <div className="mt-2 border-t pt-2">
          <h3 className="font-bold text-[#002855]">3. Validación física de recepción</h3>
<div className="mt-3 space-y-3">
            {physicalQuantity !== '' && Number(physicalQuantity) !== Number(selected.quantity) && <p role="alert" className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950"><b>Revisión de cantidad física:</b> el ERP conserva su cantidad original. Si el conteo recibido difiere, indique el motivo; el ajuste quedará auditado en esta recepción.</p>}
            <div className="inline-flex rounded-lg bg-slate-100 p-1 text-xs font-semibold">
              <button type="button" disabled={selected.validation_status === 'VALIDATED'} onClick={() => setPackageMode('PACKAGES')} className={`rounded-md px-3 py-2 ${packageMode === 'PACKAGES' ? 'bg-white text-[#002855] shadow-sm' : 'text-slate-600'}`}>Paquetes completos + saldo</button>
              <button type="button" disabled={selected.validation_status === 'VALIDATED'} onClick={() => setPackageMode('TOTAL')} className={`rounded-md px-3 py-2 ${packageMode === 'TOTAL' ? 'bg-white text-[#002855] shadow-sm' : 'text-slate-600'}`}>Solo cantidad total</button>
            </div>
            {packageMode === 'PACKAGES' ? <div className="grid gap-2 rounded-lg border border-blue-100 bg-blue-50/50 p-2 sm:grid-cols-2 xl:grid-cols-4">
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
        {lpn ? <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-950">Esta línea está consolidada en el LPN <b>{lpn.lpn_code}</b> con {lpn.packages.length} líneas ({fmt(lpn.quantity, 3)} und · {fmt(lpn.weight_kg)} kg). Se imprime solo la etiqueta del LPN y su hoja de contenido; para etiquetarla por separado, deshaga el LPN desde la Vista previa.</div> : selected.label_status === 'PENDING_PRINT' ? <div className="mt-3 rounded-lg border border-amber-300 bg-amber-50 p-3 text-sm text-amber-950">{labels.length} etiqueta(s) LPN ya generadas siguen pendientes de impresión. Use Vista previa para revisarlas y luego imprímalas; no se generarán códigos duplicados.</div> : selected.label_status === 'MATCH' ? <div className="mt-3 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm text-emerald-950">Este ingreso ya tiene todas sus etiquetas impresas.</div> : <div className="mt-4 grid gap-3 sm:grid-cols-3">
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
        <footer className="flex shrink-0 flex-col gap-1.5 border-t border-slate-200 bg-white p-2 sm:flex-row sm:items-center sm:justify-between sm:px-4">
          <p className="hidden text-xs text-slate-500 sm:block">Conteo físico → distribución → LPN → impresión</p>
          <div className="flex gap-2">{labels.length > 0 && <button type="button" onClick={() => { setSelected(null); setShowPreview(true) }} className="min-h-10 flex-1 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-[#002855] sm:flex-none">Vista previa</button>}<button type="button" onClick={() => setSelected(null)} className="min-h-10 flex-1 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-slate-700 sm:flex-none">Cerrar</button><button type="button" disabled={busy||!labels.length} onClick={() => void print()} className="inline-flex min-h-10 flex-1 items-center justify-center gap-2 rounded-lg bg-[#002855] px-4 text-sm font-bold text-white disabled:cursor-not-allowed disabled:opacity-40 sm:flex-none"><Printer size={16}/>{lpn ? (labelsPrinted ? 'Reimprimir etiqueta LPN' : 'Imprimir etiqueta LPN') : labelsPrinted ? 'Reimprimir lote' : hasPrintedLabels ? 'Imprimir pendientes' : 'Imprimir lote'}</button></div>
        </footer>
      </div>
    </div>, document.body)}

    {labels.length > 0 && showPreview && typeof document !== 'undefined' && createPortal(<div id="wms-label-preview" role="dialog" aria-modal="true" aria-labelledby="wms-label-preview-title" className="fixed inset-0 z-[2147483001] flex items-center justify-center bg-slate-950/60 p-2 sm:p-5 print:static print:block print:bg-transparent print:p-0" onClick={() => setShowPreview(false)}>
      <section className="flex max-h-[96dvh] w-full max-w-6xl flex-col overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-2xl print:contents" onClick={event => event.stopPropagation()}>
        <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-6">
          {lpn ? <div><h2 id="wms-label-preview-title" className="font-bold text-[#002855]">Vista previa · LPN {lpn.lpn_code}</h2><p className="text-xs text-slate-500">Una sola etiqueta para el pallet y su hoja de contenido ({lpn.packages.length} líneas, {contentSheetFormat(lpn.packages.length).toUpperCase()}).</p></div>
            : <div><h2 id="wms-label-preview-title" className="font-bold text-[#002855]">Vista previa de etiquetas · {labels.length}</h2><p className="text-xs text-slate-500">Revise cada bulto, cantidad y código LPN antes de imprimir.</p></div>}
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => setShowPreview(false)} className="min-h-10 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700">Cerrar vista previa</button>
            {lpn && <button type="button" disabled={busy} onClick={() => void downloadContent()} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-[#002855]"><Download size={16}/>Hoja de contenido</button>}
            {lpn && lpn.status === 'CLOSED' && !lpn.task_id && <button type="button" disabled={busy} onClick={() => void undoLpn()} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 px-3 py-2 text-sm font-semibold text-slate-700"><Undo2 size={16}/>Deshacer LPN</button>}
            <button type="button" disabled={busy} onClick={() => void print()} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-[#002855] px-4 py-2.5 text-sm font-bold text-white"><Printer size={16} />{lpn ? (labelsPrinted ? 'Reimprimir etiqueta LPN' : 'Imprimir etiqueta LPN') : labelsPrinted ? 'Reimprimir lote' : 'Imprimir lote'}</button>
            <button type="button" aria-label="Cerrar vista previa" onClick={() => setShowPreview(false)} className="grid h-10 w-10 place-items-center rounded-lg border border-slate-300 text-slate-600"><X size={18}/></button>
          </div>
        </header>
        <div className="wms-label-list min-h-0 flex-1 overflow-y-auto p-3 sm:p-6 print:overflow-visible print:p-0">
          <div className="grid gap-3 sm:grid-cols-2">{labels.map(label=><div key={label.package_code}>
            <PackageLabelPreview label={label} format={labelFormat}/>
            {!lpn && <button type="button" disabled={busy} onClick={()=>void print([label])} className="mt-2 rounded-md border border-slate-300 px-3 py-2 text-xs font-bold text-[#002855]">{printedLabelCodes.includes(label.package_code)?'Reimprimir etiqueta':'Imprimir etiqueta'}</button>}
          </div>)}
          {lpn && <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full text-left text-xs">
              <caption className="bg-slate-50 p-2 text-left font-bold text-[#002855]">Hoja de contenido · {lpn.lpn_code}</caption>
              <thead className="bg-slate-50 text-slate-600"><tr><th className="p-2">IPT</th><th className="p-2">Código</th><th className="p-2">Descripción</th><th className="p-2">Lote</th><th className="p-2 text-right">Cantidad</th><th className="p-2 text-right">Peso kg</th></tr></thead>
              <tbody>{lpn.packages.map(row => <tr key={row.package_code} className="border-t border-slate-200"><td className="p-2">{row.document || '—'}</td><td className="p-2 font-semibold">{row.product_code}</td><td className="p-2">{row.description}</td><td className="p-2">{row.lot || '—'}</td><td className="p-2 text-right tabular-nums">{fmt(row.quantity, 3)} {row.unit || ''}</td><td className="p-2 text-right tabular-nums">{row.weight_kg == null ? '—' : fmt(row.weight_kg)}</td></tr>)}</tbody>
              <tfoot><tr className="border-t border-slate-300 font-bold"><td className="p-2" colSpan={4}>Total · {lpn.packages.length} líneas</td><td className="p-2 text-right tabular-nums">{fmt(lpn.quantity, 3)}</td><td className="p-2 text-right tabular-nums">{fmt(lpn.weight_kg)}</td></tr></tfoot>
            </table>
          </div>}</div>
        </div>
      </section>
    </div>, document.body)}

  </div>
}

type Period = 'HOY' | 'SEMANA' | 'MES' | 'RANGO'
const PERIODS: [Period, string][] = [['HOY', 'Hoy'], ['SEMANA', 'Semana'], ['MES', 'Mes'], ['RANGO', 'Personalizado']]
/** Fecha de Lima (YYYY-MM-DD) desplazada `days` días. */
function limaDay(days: number) { return new Date(Date.now() + days * 86_400_000).toLocaleDateString('en-CA', { timeZone: 'America/Lima' }) }
function periodRange(period: Period, from: string, to: string): [string, string] {
  const today = limaDay(0)
  if (period === 'HOY') return [today, today]
  if (period === 'SEMANA') return [limaDay(-6), today]
  if (period === 'MES') return [today.slice(0, 8) + '01', today]
  return [from || '0000-01-01', to || '9999-12-31']
}
function filterAndSort<T extends { fecha: string; document_no: string }>(rows: T[], range: [string, string] | null) {
  return rows.filter(r => !range || (r.fecha >= range[0] && r.fecha <= range[1]))
    .sort((a, b) => b.fecha.localeCompare(a.fecha) || b.document_no.localeCompare(a.document_no))
}
