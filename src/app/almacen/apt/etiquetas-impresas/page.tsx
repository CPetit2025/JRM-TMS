'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { ClipboardList, PackageCheck, Printer, RefreshCw, Search, X } from 'lucide-react'
import { Code128Barcode } from '@/components/warehouse/Code128Barcode'

type ReceiptPackage = {
  package_code: string
  source_document_no: string
  source_contract_code: string | null
  source_lot: string
  source_product_code: string
  source_warehouse: string
  source_date: string
  description: string
  quantity: number
  unit: string | null
  weight_kg: number | null
  sequence_no: number
  sequence_total: number
  source_movement_key: string
  label_print_count: number
  status: string
  created_at: string
}

type Validation = {
  source_movement_key: string
  validated_by: string
  validated_at: string
  customer_name: string | null
  first_name: string | null
  last_name: string | null
  username: string | null
}
type OperatorValidation = Validation
type ReceiptGroup = {
  sourceMovementKey: string
  documentNo: string
  contractCode: string | null
  lot: string
  customerName: string | null
  productCode: string
  description: string
  unit: string | null
  packages: ReceiptPackage[]
  units: number
  weightKg: number
  reprints: number
  validations: Validation[]
}
const errorText = (error: { message: string }) => error.message
const numberFmt = new Intl.NumberFormat('es-PE', { maximumFractionDigits: 3 })
const weightText = (kg: number) => kg >= 1000
  ? `${numberFmt.format(kg / 1000)} TN`
  : `${numberFmt.format(kg)} kg`
const unitIsPiece = (unit: string | null) => !unit || /^(UND|UNID|UNIDAD|UNIDADES|PZA|PCS)\.?$/i.test(unit.trim())

export default function AptReceiptControlPage() {
  const [rows, setRows] = useState<ReceiptPackage[]>([])
  const [validations, setValidations] = useState<Record<string, Validation>>({})
  const [customers, setCustomers] = useState<Record<string, string>>({})
  const [profiles, setProfiles] = useState<Record<string, string>>({})
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [printingCode, setPrintingCode] = useState<string | null>(null)
  const [printLabel, setPrintLabel] = useState<ReceiptPackage | null>(null)
  const [detail, setDetail] = useState<ReceiptGroup | null>(null)

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true)
    setError('')
    const client = createClient()
    const { data, error: queryError } = await client
      .from('wh_packages')
      .select('package_code,source_document_no,source_contract_code,source_lot,source_product_code,source_warehouse,source_date,description,quantity,unit,weight_kg,sequence_no,sequence_total,source_movement_key,label_print_count,status,created_at')
      .eq('source_system', 'ERP')
      .gt('label_print_count', 0)
      .neq('status', 'VOID')
      .order('created_at', { ascending: false })
      .limit(2000)

    if (queryError) {
      setError(errorText(queryError))
      setLoading(false)
      setRefreshing(false)
      return
    }

    const packages = (data || []) as ReceiptPackage[]
    setRows(packages)
    const movementKeys = [...new Set(packages.map(row => row.source_movement_key))]
    const chunks = Array.from({ length: Math.ceil(movementKeys.length / 100) }, (_, i) => movementKeys.slice(i * 100, (i + 1) * 100))
    const [validationChunks, customerChunks] = await Promise.all([
      Promise.all(chunks.map(p_source_movement_keys => client.rpc('wh_receipt_control_operators', { p_source_movement_keys }))),
      Promise.all(chunks.map(p_source_movement_keys => client.rpc('wh_receipt_control_customers', { p_source_movement_keys }))),
    ])
    const latestByMovement = new Map<string, Validation>()
    const operatorRows = validationChunks.flatMap(result => {
      if (result.error) return []
      return (result.data || []) as OperatorValidation[]
    })
    const validationRows = operatorRows as Validation[]
    validationRows.sort((a, b) => new Date(b.validated_at).getTime() - new Date(a.validated_at).getTime())
    for (const row of validationRows) if (!latestByMovement.has(row.source_movement_key)) latestByMovement.set(row.source_movement_key, row)
    const validationMap = Object.fromEntries(latestByMovement)
    setValidations(validationMap)
    const customerRows = customerChunks.flatMap(result => result.error ? [] : (result.data || []) as { source_movement_key: string; customer_name: string | null }[])
    setCustomers(Object.fromEntries(customerRows.filter(row => row.customer_name?.trim()).map(row => [row.source_movement_key, row.customer_name!.trim()])))
    const lookupError = [...validationChunks, ...customerChunks].find(result => result.error)?.error
    if (lookupError) setError(`No se pudieron cargar los datos de cliente/recepción: ${lookupError.message}`)

    const names: Record<string, string> = {}
    for (const row of operatorRows) {
      const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim()
      names[row.validated_by] = fullName || row.username || `Usuario ${row.validated_by.slice(0, 8)}`
    }
    setProfiles(names)
    setLastUpdated(new Date())
    setLoading(false)
    setRefreshing(false)
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 30000)
    const afterPrint = () => { setPrintLabel(null); setPrintingCode(null) }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setDetail(null) }
    window.addEventListener('afterprint', afterPrint)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearInterval(timer)
      window.removeEventListener('afterprint', afterPrint)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [load])

  const groups = useMemo(() => {
    const byItem = new Map<string, ReceiptGroup>()
    for (const row of rows) {
      const key = row.source_movement_key
      let group = byItem.get(key)
      if (!group) {
        group = {
          sourceMovementKey: key,
          documentNo: row.source_document_no,
          contractCode: row.source_contract_code,
          lot: row.source_lot,
          customerName: customers[key] || validations[key]?.customer_name || null,
          productCode: row.source_product_code,
          description: row.description,
          unit: row.unit,
          packages: [],
          units: 0,
          weightKg: 0,
          reprints: 0,
          validations: [],
        }
        byItem.set(key, group)
      }
      group.packages.push(row)
      if (unitIsPiece(row.unit)) group.units += Number(row.quantity || 0)
      group.weightKg += Number(row.weight_kg || 0)
      group.reprints += Math.max(0, Number(row.label_print_count || 0) - 1)
    }
    for (const group of byItem.values()) {
      const validation = validations[group.sourceMovementKey]
      group.validations = validation ? [validation] : []
      group.customerName = customers[group.sourceMovementKey] || validation?.customer_name || group.customerName
    }
    return [...byItem.values()].sort((a, b) =>
      a.documentNo.localeCompare(b.documentNo, 'es', { numeric: true }) ||
      a.productCode.localeCompare(b.productCode, 'es', { numeric: true }) ||
      a.lot.localeCompare(b.lot, 'es', { numeric: true }),
    )
  }, [rows, validations, customers])

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    if (!q) return groups
    return groups.filter(group => [
      group.documentNo, group.contractCode || '', group.lot, group.productCode,
      group.customerName || '', ...group.packages.map(row => row.package_code),
    ].some(value => value.toLocaleLowerCase().includes(q)))
  }, [groups, query])

  const receiverNames = (group: ReceiptGroup) => [...new Set(group.validations.map(row =>
    profiles[row.validated_by] || `Usuario ${row.validated_by.slice(0, 8)}`,
  ))]
  const printExistingPackage = async (row: ReceiptPackage) => {
    if (printingCode) return
    const reason = window.prompt('Motivo de reimpresión de la etiqueta:')
    if (!reason?.trim()) return
    setPrintingCode(row.package_code)
    setError('')
    const { error: rpcError } = await createClient().rpc('wh_reprint_label', {
      p_package_code: row.package_code,
      p_reason: reason.trim(),
    })
    if (rpcError) {
      setError(errorText(rpcError))
      setPrintingCode(null)
      return
    }
    setRows(current => current.map(item => item.package_code === row.package_code
      ? { ...item, label_print_count: item.label_print_count + 1 }
      : item))
    setPrintLabel(row)
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => window.print()))
  }

  return <div className="w-full min-w-0 space-y-5">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-blue-700">APT · Control de recepción</p>
        <h1 className="mt-1 text-3xl font-black text-[#002855]">Control de recepcionados</h1>
        <p className="mt-1 text-sm text-slate-600">Una fila por línea de producto ingresada. Cada fila consolida sus bultos y conserva el IPT de origen.</p>
      </div>
      <button type="button" disabled={refreshing} onClick={() => void load(true)} className="inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 bg-white px-3 py-2 text-sm font-semibold text-[#002855] disabled:opacity-50">
        <RefreshCw size={15} className={refreshing ? 'animate-spin' : ''}/>Actualizar control
      </button>
    </header>

    {error && <p role="alert" className="rounded-lg border border-rose-300 bg-rose-50 p-3 text-sm text-rose-900">{error}</p>}

    <section className="w-full rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <span className="grid h-11 w-11 place-items-center rounded-xl bg-blue-50 text-blue-800"><PackageCheck size={22}/></span>
          <div><h2 className="font-bold text-[#002855]">Ingresos recepcionados</h2><p className="text-xs text-slate-500">{filtered.length} de {groups.length} líneas de ingreso</p></div>
        </div>
        <p className="text-xs text-slate-400">{lastUpdated ? `Actualizado: ${lastUpdated.toLocaleTimeString('es-PE')}` : 'Consultando…'}</p>
      </div>

      <label className="relative mb-4 block">
        <Search size={16} className="absolute left-3 top-3 text-slate-400"/>
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar por lote, IPT, cliente o descripción" className="w-full rounded-lg border border-slate-300 py-2.5 pl-9 pr-3 text-sm outline-none focus:border-blue-500"/>
      </label>

      <div className="w-full overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[1280px] text-left text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-600"><tr>
            <th className="p-3">Lote</th><th className="p-3">IPT</th><th className="p-3">Cliente</th><th className="p-3">Descripción</th>
            <th className="p-3 text-right">UND</th><th className="p-3 text-right">Kg / TN</th><th className="p-3 text-right">Bultos</th>
            <th className="p-3">Acciones</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-200">
            {filtered.map(group => <tr key={group.sourceMovementKey} className="hover:bg-blue-50/60">
              <td className="p-3">{group.lot || '—'}</td>
              <td className="p-3 font-semibold text-[#002855]">{group.documentNo}</td>
              <td className="max-w-56 p-3">{group.customerName || 'Por registrar'}</td>
              <td className="max-w-[420px] p-3"><b className="block text-[#002855]">{group.productCode}</b><span className="block text-xs text-slate-500">{group.description || '—'}</span></td>
              <td className="p-3 text-right tabular-nums">{group.units ? numberFmt.format(group.units) : '—'}</td>
              <td className="p-3 text-right tabular-nums">{group.weightKg ? weightText(group.weightKg) : '—'}</td>
              <td className="p-3 text-right tabular-nums">{group.packages.length}</td>
              <td className="p-3"><button type="button" onClick={() => setDetail(group)} className="inline-flex min-h-9 items-center gap-2 whitespace-nowrap rounded-lg border border-[#002855] px-3 py-2 text-xs font-bold text-[#002855] hover:bg-blue-50"><ClipboardList size={14}/>Ver detalle</button></td>
            </tr>)}
            {!loading && filtered.length === 0 && <tr><td colSpan={8} className="p-10 text-center text-sm text-slate-500">{query ? 'No hay líneas recepcionadas que coincidan con la búsqueda.' : 'Todavía no hay ingresos recepcionados en el APT.'}</td></tr>}
            {loading && <tr><td colSpan={8} className="p-10 text-center text-sm text-slate-500">Cargando recepciones…</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-slate-500">Cada fila representa un ítem ingresado en el IPT. Sus bultos pendientes de impresión permanecen en «02 · Recepción por IPT».</p>
    </section>

    {detail && <div className="fixed inset-0 z-[2147483000] flex items-center justify-center bg-slate-950/60 p-2 sm:p-4" onMouseDown={event => { if (event.target === event.currentTarget) setDetail(null) }}>
      <section role="dialog" aria-modal="true" aria-labelledby="apt-receipt-detail-title" className="flex max-h-[96dvh] w-full max-w-7xl flex-col overflow-hidden rounded-xl bg-white shadow-2xl">
        <header className="flex shrink-0 items-center justify-between gap-3 border-b border-slate-200 bg-blue-50 px-4 py-3 sm:px-6">
          <div><p className="text-xs font-bold uppercase tracking-wide text-blue-700">Detalle de recepción</p><h2 id="apt-receipt-detail-title" className="text-xl font-black text-[#002855]">{detail.lot || '—'} · IPT {detail.documentNo} · {detail.productCode}</h2></div>
          <button type="button" aria-label="Cerrar detalle" onClick={() => setDetail(null)} className="grid h-10 w-10 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"><X size={20}/></button>
        </header>
        <div className="min-h-0 flex-1 space-y-4 overflow-auto p-4 sm:p-5">
          <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-7">
            <div className="rounded-lg bg-blue-50 p-3"><small className="block text-slate-500">Contrato</small><b className="text-sm text-[#002855]">{detail.contractCode || '—'}</b></div><div className="rounded-lg bg-blue-50 p-3"><small className="block text-slate-500">Cliente</small><b className="text-sm text-[#002855]">{detail.customerName || 'Por registrar'}</b></div>
            <div className="rounded-lg bg-blue-50 p-3"><small className="block text-slate-500">Recepcionado por</small><b className="text-sm text-[#002855]">{receiverNames(detail).join(', ') || 'Registro de validación no disponible'}</b></div>
            <div className="rounded-lg bg-blue-50 p-3"><small className="block text-slate-500">Fecha de recepción</small><b className="text-sm text-[#002855]">{detail.validations[0] ? new Date(detail.validations[0].validated_at).toLocaleString('es-PE') : '—'}</b></div>
            <div className="rounded-lg bg-blue-50 p-3"><small className="block text-slate-500">Bultos recepcionados</small><b className="text-sm text-[#002855]">{detail.packages.length}</b></div><div className="rounded-lg bg-amber-50 p-3"><small className="block text-amber-800">Reimpresiones totales</small><b className="text-sm text-[#002855]">{detail.reprints}</b></div>
            <div className="rounded-lg bg-blue-700 p-3 text-white"><small className="block text-blue-100">UND · Peso</small><b>{numberFmt.format(detail.units)} UND · {weightText(detail.weightKg)}</b></div>
          </div>

          <div className="overflow-x-auto rounded-lg border border-slate-200">
            <table className="w-full min-w-[1080px] text-left text-sm">
              <thead className="bg-slate-50 text-xs font-semibold text-slate-600"><tr><th className="p-3">Producto · descripción</th><th className="p-3">Lote</th><th className="p-3 text-right">UND</th><th className="p-3 text-right">Kg</th><th className="p-3">Código de barras</th><th className="p-3">Acción</th></tr></thead>
              <tbody className="divide-y divide-slate-200">{detail.packages.map(row => <tr key={row.package_code}>
                <td className="p-3">{row.source_product_code}<small className="block max-w-xs truncate text-slate-500" title={row.description}>{row.description}</small></td>
                <td className="p-3">{row.source_lot || '—'}</td><td className="p-3 text-right tabular-nums">{unitIsPiece(row.unit) ? numberFmt.format(row.quantity) : '—'}</td>
                <td className="p-3 text-right tabular-nums">{row.weight_kg === null ? '—' : numberFmt.format(row.weight_kg)}</td>
                <td className="p-3"><div className="w-48"><Code128Barcode value={row.package_code} height={48} className="h-9 w-full"/><span className="font-mono text-xs font-bold text-[#002855]">{row.package_code}</span></div></td>
                <td className="p-3"><button type="button" disabled={printingCode !== null} onClick={() => void printExistingPackage(row)} className="inline-flex min-h-9 items-center gap-2 whitespace-nowrap rounded-lg bg-[#002855] px-3 py-2 text-xs font-bold text-white disabled:opacity-50"><Printer size={14}/>{printingCode === row.package_code ? 'Preparando…' : 'Reimprimir'}</button><small className="mt-1 block text-slate-500">{Math.max(0, row.label_print_count - 1)} reimpresión(es)</small></td>
              </tr>)}</tbody>
            </table>
          </div>
        </div>
        <footer className="flex shrink-0 justify-between border-t border-slate-200 bg-white px-4 py-3"><span className="self-center text-xs text-slate-500">La reimpresión conserva el código de barras original.</span><button type="button" onClick={() => setDetail(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-[#002855]">Cerrar</button></footer>
      </section>
    </div>}

    {printLabel && <div id="apt-reprint-root" aria-hidden="true">
      <article className="wh-label">
        <div className="wh-label-head">
          <div className="wh-logo"><img src="/logo-jrm.png" alt="JRM"/></div>
          <div className="wh-label-meta"><div><b>IPT:</b> {printLabel.source_document_no}</div><div><b>OT/Contrato:</b> {printLabel.source_contract_code || '—'}</div><div><b>Lote:</b> {printLabel.source_lot || '—'} · {printLabel.source_warehouse}</div></div>
        </div>
        <b className="wh-sku">{printLabel.source_product_code}</b>
        <div className="wh-description">{printLabel.description}</div>
        <Code128Barcode value={printLabel.package_code} height={84} className="wh-barcode"/>
        <b className="wh-code">{printLabel.package_code}</b>
        <div className="wh-footer"><span><b>IPT:</b> {printLabel.source_document_no}<br/><b>Fecha:</b> {printLabel.source_date}</span><strong>{numberFmt.format(printLabel.quantity)} {printLabel.unit || ''} · {printLabel.weight_kg === null ? 'Peso por registrar' : `${numberFmt.format(printLabel.weight_kg)} kg`}</strong><span>{printLabel.sequence_no}/{printLabel.sequence_total}</span></div>
      </article>
    </div>}

    <style jsx global>{`
      #apt-reprint-root{display:none}
      @page{size:152.4mm 101.6mm;margin:0}
      @media print{
        html,body{width:152.4mm!important;min-width:0!important;margin:0!important;padding:0!important}
        body *{visibility:hidden!important}
        #apt-reprint-root,#apt-reprint-root *{visibility:visible!important}
        #apt-reprint-root{display:block!important;position:absolute!important;inset:0 auto auto 0!important;width:152.4mm!important;height:101.6mm!important;margin:0!important;padding:0!important;background:#fff!important}
        .wh-label{box-sizing:border-box;display:flex!important;width:152.4mm!important;height:101.6mm!important;flex-direction:column;overflow:hidden!important;padding:2mm!important;border:1px dashed #6b8198!important;background:white!important;color:black!important}
        .wh-label-head{display:flex;height:18mm;min-height:18mm;gap:2mm;border-bottom:1mm solid #002855;padding-bottom:1mm}
        .wh-logo{display:flex;width:27mm;flex:none;align-items:center;justify-content:center;background:#002855;padding:1mm}
        .wh-logo img{max-width:100%;max-height:100%;object-fit:contain}
        .wh-label-meta{display:grid;min-width:0;flex:1;grid-template-columns:1fr 1fr;align-content:center;gap:1mm;font-size:4mm;font-weight:700}
        .wh-label-meta div:first-child{grid-column:span 2}
        .wh-sku{max-width:80%;overflow:hidden;margin-top:2mm;border-radius:1mm;background:#002855;padding:1mm 2mm;color:white;font-size:7mm}
        .wh-description{height:18mm;max-height:18mm;overflow:hidden;margin-top:1mm;font-size:4.5mm;line-height:1.1}
        .wh-barcode{display:block;width:90%;height:23mm;margin:0 auto;flex:none}
        .wh-code{height:8mm;text-align:center;font-family:monospace;font-size:6mm}
        .wh-footer{display:grid;height:14mm;grid-template-columns:1fr auto 1fr;align-items:center;gap:2mm;border-top:.3mm solid #788696;padding-top:1mm;font-size:3.3mm}
        .wh-footer strong{font-size:8mm;font-weight:800;white-space:nowrap}
        .wh-footer span:last-child{text-align:right}
      }
    `}</style>
  </div>
}
