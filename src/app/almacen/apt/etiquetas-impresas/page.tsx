'use client'

import { useCallback, useDeferredValue, useEffect, useMemo, useState } from 'react'
import Link from 'next/link'
import { createClient } from '@/lib/supabase/client'
import { DataTable } from '@/components/ui/data-table'
import { TablePagination } from '@/components/ui/table-pagination'
import { usePagination } from '@/lib/use-pagination'
import { readCache, writeCache } from '@/lib/use-cached'
import { ClipboardList, PackageCheck, Printer, RefreshCw, Search, X } from 'lucide-react'
import { printPackageLabels, validatePackageLabelPrint } from '@/components/warehouse/print-package-labels'
import { useLabelFormat } from '@/lib/warehouse/label-format'
import { loadPackageLabel } from '@/lib/warehouse/load-package-label'
import { Code128Barcode } from '@/components/warehouse/Code128Barcode'
import { itemOf } from '@/lib/warehouse/packing-list'

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
  lpn_id: string | null
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
  const labelFormat=useLabelFormat('PAQUETE')
  const [detail, setDetail] = useState<ReceiptGroup | null>(null)

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true)
    setError('')
    const client = createClient()
    const { data, error: queryError } = await client
      .from('wh_packages')
      .select('package_code,source_document_no,source_contract_code,source_lot,source_product_code,source_warehouse,source_date,description,quantity,unit,weight_kg,sequence_no,sequence_total,source_movement_key,label_print_count,lpn_id,status,created_at')
      .eq('source_system', 'ERP')
      // Las líneas de un LPN de recepción no imprimen etiqueta propia: se identifican con la del LPN.
      .or('label_print_count.gt.0,lpn_id.not.is.null')
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
    const customerMap = Object.fromEntries(customerRows.filter(row => row.customer_name?.trim()).map(row => [row.source_movement_key, row.customer_name!.trim()]))
    setCustomers(customerMap)
    const lookupError = [...validationChunks, ...customerChunks].find(result => result.error)?.error
    if (lookupError) setError(`No se pudieron cargar los datos de cliente/recepción: ${lookupError.message}`)

    const names: Record<string, string> = {}
    for (const row of operatorRows) {
      const fullName = [row.first_name, row.last_name].filter(Boolean).join(' ').trim()
      names[row.validated_by] = fullName || row.username || `Usuario ${row.validated_by.slice(0, 8)}`
    }
    setProfiles(names)
    if (!lookupError) void writeCache('apt-etiquetas-impresas', { rows: packages, validations: validationMap, customers: customerMap, profiles: names })
    setLastUpdated(new Date())
    setLoading(false)
    setRefreshing(false)
  }, [])

  useEffect(() => {
    void readCache<{ rows: ReceiptPackage[]; validations: Record<string, Validation>; customers: Record<string, string>; profiles: Record<string, string> }>('apt-etiquetas-impresas').then(c => {
      if (!c) return
      setRows(r => r.length ? r : c.rows); setValidations(v => Object.keys(v).length ? v : c.validations)
      setCustomers(v => Object.keys(v).length ? v : c.customers); setProfiles(v => Object.keys(v).length ? v : c.profiles); setLoading(false)
    })
    const initial=window.setTimeout(()=>void load(),0)
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 30000)
    const afterPrint = () => { setPrintingCode(null) }
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setDetail(null) }
    window.addEventListener('afterprint', afterPrint)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.clearTimeout(initial)
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

  // Filtrar no bloquea la escritura: el filtro corre sobre el valor diferido
  const deferredQuery = useDeferredValue(query)
  const filtered = useMemo(() => {
    const q = deferredQuery.trim().toLocaleLowerCase()
    if (!q) return groups
    return groups.filter(group => [
      group.documentNo, group.contractCode || '', itemOf(group.contractCode) || '', group.lot, group.productCode,
      group.customerName || '', ...group.packages.map(row => row.package_code),
    ].some(value => value.toLocaleLowerCase().includes(q)))
  }, [groups, deferredQuery])
  const pager = usePagination(filtered, 'apt-etiquetas-impresas')

  const receiverNames = (group: ReceiptGroup) => [...new Set(group.validations.map(row =>
    profiles[row.validated_by] || `Usuario ${row.validated_by.slice(0, 8)}`,
  ))]
  const printExistingPackage = async (row:ReceiptPackage) => {
    if(printingCode)return
    const reason=window.prompt('Motivo de reimpresión de la etiqueta:')
    if(!reason?.trim())return
    setPrintingCode(row.package_code);setError('')
    try{
      validatePackageLabelPrint(labelFormat)
      const db=createClient(),label=await loadPackageLabel(db,row.package_code)
      const {error}=await db.rpc('wh_reprint_label',{p_package_code:label.package_code,p_reason:reason.trim()})
      if(error)throw error
      setRows(current=>current.map(item=>item.package_code===row.package_code?{...item,label_print_count:item.label_print_count+1}:item))
      await printPackageLabels([label],labelFormat)
    }catch(e){setError(e instanceof Error?e.message:String(e))}finally{setPrintingCode(null)}
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
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar por lote, IPT, ítem, cliente o descripción" className="w-full rounded-lg border border-slate-300 py-2.5 pl-9 pr-3 text-sm outline-none focus:border-blue-500"/>
      </label>

      <div className="w-full overflow-x-auto rounded-lg border border-slate-200">
        <DataTable dense className="min-w-[980px] lg:min-w-0 w-full table-fixed text-left text-sm">
          <colgroup><col style={{ width: "9%" }}/><col style={{ width: "10%" }}/><col style={{ width: "6%" }}/><col style={{ width: "16%" }}/><col style={{ width: "24%" }}/><col style={{ width: "7%" }}/><col style={{ width: "10%" }}/><col style={{ width: "8%" }}/><col style={{ width: "10%" }}/></colgroup>
          <thead className="bg-slate-50 text-xs font-semibold text-slate-600"><tr>
            <th className="p-2">Lote</th><th className="p-2">IPT</th><th className="p-2">Ítem</th><th className="p-2">Cliente</th><th className="p-2">Descripción</th>
            <th className="p-2 text-right">UND</th><th className="p-2 text-right">Kg / TN</th><th className="p-2 text-right">Bultos</th>
            <th className="p-2">Acciones</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-200">
            {pager.pageRows.map(group => <tr key={group.sourceMovementKey} className="hover:bg-blue-50/60">
              <td className="break-words p-2">{group.lot || '—'}</td>
              <td className="whitespace-nowrap p-2 font-semibold text-[#002855]">{group.documentNo}</td>
              <td className="whitespace-nowrap p-2 font-semibold tabular-nums" title={group.contractCode || undefined}>{itemOf(group.contractCode) || '—'}</td>
              <td className="break-words p-2">{group.customerName || 'Por registrar'}</td>
              <td className="break-words p-2"><b className="block break-all text-[#002855]">{group.productCode}</b><span className="block text-xs text-slate-500">{group.description || '—'}</span></td>
              <td className="whitespace-nowrap p-2 text-right tabular-nums">{group.units ? numberFmt.format(group.units) : '—'}</td>
              <td className="whitespace-nowrap p-2 text-right tabular-nums">{group.weightKg ? weightText(group.weightKg) : '—'}</td>
              <td className="whitespace-nowrap p-2 text-right tabular-nums">{group.packages.length}</td>
              <td className="p-2"><button type="button" onClick={() => setDetail(group)} className="inline-flex min-h-9 items-center gap-2 whitespace-nowrap rounded-lg border border-[#002855] px-3 py-2 text-xs font-bold text-[#002855] hover:bg-blue-50"><ClipboardList size={14}/>Ver detalle</button></td>
            </tr>)}
            {!loading && filtered.length === 0 && <tr><td colSpan={9} className="p-10 text-center text-sm text-slate-500">{query ? 'No hay líneas recepcionadas que coincidan con la búsqueda.' : 'Todavía no hay ingresos recepcionados en el APT.'}</td></tr>}
            {loading && <tr><td colSpan={9} className="p-10 text-center text-sm text-slate-500">Cargando recepciones…</td></tr>}
          </tbody>
        </DataTable>
      </div>
      {filtered.length > 0 && <TablePagination total={pager.total} page={pager.page} pageSize={pager.pageSize} onPageChange={pager.setPage} onPageSizeChange={pager.setPageSize} itemLabel="líneas de ingreso" compact />}
      <p className="mt-3 text-xs text-slate-500">Cada fila representa un ítem ingresado en el IPT. Sus bultos pendientes de impresión permanecen en «02 · Recepción por IPT».</p>
    </section>

    {detail && <div className="fixed inset-0 z-[2147483000] flex items-start justify-center overflow-y-auto bg-slate-950/60 p-2 sm:items-center sm:p-3" onMouseDown={event => { if (event.target === event.currentTarget) setDetail(null) }}>
      <section role="dialog" aria-modal="true" aria-labelledby="apt-receipt-detail-title" className="flex max-h-[calc(100dvh-1rem)] w-full max-w-[96vw] flex-col overflow-hidden rounded-xl bg-white shadow-2xl sm:max-h-[calc(100dvh-1.5rem)] 2xl:max-w-[1440px]">
        <header className="flex shrink-0 items-center justify-between gap-2 border-b border-slate-200 bg-blue-50 px-3 py-2 sm:px-4 sm:py-2.5">
          <div><p className="text-xs font-bold uppercase tracking-wide text-blue-700">Detalle de recepción</p><h2 id="apt-receipt-detail-title" className="max-w-[75vw] truncate text-lg font-black text-[#002855] sm:max-w-none">{detail.lot || '—'} · IPT {detail.documentNo} · {detail.productCode}</h2></div>
          <button type="button" aria-label="Cerrar detalle" onClick={() => setDetail(null)} className="grid h-10 w-10 place-items-center rounded-lg text-slate-500 hover:bg-slate-100"><X size={20}/></button>
        </header>
        <div className="min-h-0 flex-1 space-y-2 overflow-auto p-2 sm:space-y-3 sm:p-3">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-7">
            <div className="rounded-lg bg-blue-50 p-3"><small className="block text-slate-500">Contrato</small><b className="text-sm text-[#002855]">{detail.contractCode || '—'}</b></div><div className="rounded-lg bg-blue-50 p-3"><small className="block text-slate-500">Cliente</small><b className="text-sm text-[#002855]">{detail.customerName || 'Por registrar'}</b></div>
            <div className="rounded-lg bg-blue-50 p-3"><small className="block text-slate-500">Recepcionado por</small><b className="text-sm text-[#002855]">{receiverNames(detail).join(', ') || 'Registro de validación no disponible'}</b></div>
            <div className="rounded-lg bg-blue-50 p-3"><small className="block text-slate-500">Fecha de recepción</small><b className="text-sm text-[#002855]">{detail.validations[0] ? new Date(detail.validations[0].validated_at).toLocaleString('es-PE') : '—'}</b></div>
            <div className="rounded-lg bg-blue-50 p-3"><small className="block text-slate-500">Bultos recepcionados</small><b className="text-sm text-[#002855]">{detail.packages.length}</b></div><div className="rounded-lg bg-amber-50 p-3"><small className="block text-amber-800">Reimpresiones totales</small><b className="text-sm text-[#002855]">{detail.reprints}</b></div>
            <div className="rounded-lg bg-blue-700 p-3 text-white"><small className="block text-blue-100">UND · Peso</small><b>{numberFmt.format(detail.units)} UND · {weightText(detail.weightKg)}</b></div>
          </div>

          <div className="max-h-[min(36dvh,420px)] overflow-auto rounded-lg border border-slate-200">
            <table className="min-w-[920px] lg:min-w-0 w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-slate-50 text-xs font-semibold text-slate-600"><tr><th className="p-2">Producto · descripción</th><th className="p-3">Lote</th><th className="p-3 text-right">UND</th><th className="p-3 text-right">Kg</th><th className="p-3">Código de barras</th><th className="p-3">Acción</th></tr></thead>
              <tbody className="divide-y divide-slate-200">{detail.packages.map(row => <tr key={row.package_code}>
                <td className="p-3">{row.source_product_code}<small className="block max-w-xs truncate text-slate-500" title={row.description}>{row.description}</small></td>
                <td className="p-3">{row.source_lot || '—'}</td><td className="p-3 text-right tabular-nums">{unitIsPiece(row.unit) ? numberFmt.format(row.quantity) : '—'}</td>
                <td className="p-3 text-right tabular-nums">{row.weight_kg === null ? '—' : numberFmt.format(row.weight_kg)}</td>
                <td className="p-3"><div className="w-48"><Code128Barcode value={row.package_code} height={48} className="h-9 w-full"/><span className="font-mono text-xs font-bold text-[#002855]">{row.package_code}</span></div></td>
                <td className="p-3">{row.lpn_id && row.label_print_count === 0 ? <Link href={`/almacen/paquetes/${encodeURIComponent(row.package_code)}`} className="inline-flex min-h-9 items-center whitespace-nowrap rounded-lg border border-slate-300 px-3 py-2 text-xs font-bold text-[#002855]">En LPN · ver etiqueta</Link> : <><button type="button" disabled={printingCode !== null} onClick={() => void printExistingPackage(row)} className="inline-flex min-h-9 items-center gap-2 whitespace-nowrap rounded-lg bg-[#002855] px-3 py-2 text-xs font-bold text-white disabled:opacity-50"><Printer size={14}/>{printingCode === row.package_code ? 'Preparando…' : 'Reimprimir'}</button><small className="mt-1 block text-slate-500">{Math.max(0, row.label_print_count - 1)} reimpresión(es)</small></>}</td>
              </tr>)}</tbody>
            </table>
          </div>
        </div>
        <footer className="flex shrink-0 justify-between border-t border-slate-200 bg-white px-3 py-2"><span className="self-center text-xs text-slate-500">La reimpresión conserva el código de barras original.</span><button type="button" onClick={() => setDetail(null)} className="rounded-lg border border-slate-300 px-4 py-2 text-sm font-semibold text-[#002855]">Cerrar</button></footer>
      </section>
    </div>}


  </div>
}
