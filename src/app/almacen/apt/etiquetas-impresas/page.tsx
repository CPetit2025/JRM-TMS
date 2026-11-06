'use client'

import { useCallback, useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import { PackageCheck, Printer, RefreshCw, Search } from 'lucide-react'
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
  label_print_count: number
  status: string
  created_at: string
}

const errorText = (error: { message: string }) => error.message
const statusLabel: Record<string, string> = {
  AVAILABLE: 'Recepcionado',
  RESERVED: 'Reservado',
  PICKED: 'Recolectado',
  PACKED: 'Empacado',
  LOADED: 'Despachado',
}

export default function AptReceiptControlPage() {
  const [rows, setRows] = useState<ReceiptPackage[]>([])
  const [query, setQuery] = useState('')
  const [loading, setLoading] = useState(true)
  const [refreshing, setRefreshing] = useState(false)
  const [error, setError] = useState('')
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null)
  const [printingCode, setPrintingCode] = useState<string | null>(null)
  const [printLabel, setPrintLabel] = useState<ReceiptPackage | null>(null)

  const load = useCallback(async (manual = false) => {
    if (manual) setRefreshing(true)
    setError('')
    const { data, error: queryError } = await createClient()
      .from('wh_packages')
      .select('package_code,source_document_no,source_contract_code,source_lot,source_product_code,source_warehouse,source_date,description,quantity,unit,weight_kg,sequence_no,sequence_total,label_print_count,status,created_at')
      .eq('source_system', 'ERP')
      .neq('status', 'VOID')
      .order('created_at', { ascending: false })
      .limit(2000)

    if (queryError) setError(errorText(queryError))
    else {
      setRows((data || []) as ReceiptPackage[])
      setLastUpdated(new Date())
    }
    setLoading(false)
    setRefreshing(false)
  }, [])

  useEffect(() => {
    void load()
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void load()
    }, 30000)
    const afterPrint = () => { setPrintLabel(null); setPrintingCode(null) }
    window.addEventListener('afterprint', afterPrint)
    return () => { window.clearInterval(timer); window.removeEventListener('afterprint', afterPrint) }
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLocaleLowerCase()
    if (!q) return rows
    return rows.filter(row => [
      row.package_code, row.source_document_no, row.source_contract_code, row.source_lot,
      row.source_product_code, row.source_warehouse, row.description,
    ].some(value => String(value || '').toLocaleLowerCase().includes(q)))
  }, [query, rows])

  const printExistingPackage = async (row: ReceiptPackage) => {
    if (printingCode) return
    let reason: string | null = null
    if (row.label_print_count > 0) {
      reason = window.prompt('Motivo de reimpresión de la etiqueta:')
      if (!reason?.trim()) return
    }
    setPrintingCode(row.package_code)
    setError('')
    const client = createClient()
    const result = row.label_print_count > 0
      ? await client.rpc('wh_reprint_label', { p_package_code: row.package_code, p_reason: reason!.trim() })
      : await client.rpc('wh_print_labels', { p_package_codes: [row.package_code] })
    if (result.error) {
      setError(errorText(result.error))
      setPrintingCode(null)
      return
    }
    setRows(current => current.map(item => item.package_code === row.package_code
      ? { ...item, label_print_count: item.label_print_count + 1 }
      : item))
    setPrintLabel(row)
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => window.print()))
  }

  const statusClass = (status: string) => status === 'AVAILABLE'
    ? 'bg-emerald-50 text-emerald-800'
    : status === 'VOID' ? 'bg-rose-50 text-rose-800' : 'bg-blue-50 text-blue-800'

  return <div className="w-full min-w-0 space-y-5">
    <header className="flex flex-wrap items-end justify-between gap-3">
      <div>
        <p className="text-xs font-bold uppercase tracking-widest text-blue-700">APT · Control de recepción</p>
        <h1 className="mt-1 text-3xl font-black text-[#002855]">Control de recepcionados</h1>
        <p className="mt-1 text-sm text-slate-600">Seguimiento de bultos recibidos desde el APT, sus cantidades, estado y etiquetas. Se actualiza cada 30 segundos.</p>
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
          <div><h2 className="font-bold text-[#002855]">Bultos recepcionados</h2><p className="text-xs text-slate-500">{filtered.length} de {rows.length} registros</p></div>
        </div>
        <p className="text-xs text-slate-400">{lastUpdated ? `Actualizado: ${lastUpdated.toLocaleTimeString('es-PE')}` : 'Consultando…'}</p>
      </div>

      <label className="relative mb-4 block">
        <Search size={16} className="absolute left-3 top-3 text-slate-400"/>
        <input value={query} onChange={event => setQuery(event.target.value)} placeholder="Buscar por código de bulto, IPT, contrato, lote o producto" className="w-full rounded-lg border border-slate-300 py-2.5 pl-9 pr-3 text-sm outline-none focus:border-blue-500"/>
      </label>

      <div className="w-full overflow-x-auto rounded-lg border border-slate-200">
        <table className="w-full min-w-[1180px] text-left text-sm">
          <thead className="bg-slate-50 text-xs font-semibold text-slate-600"><tr>
            <th className="p-3">Bulto / código de barras</th><th className="p-3">IPT · OT/Contrato</th><th className="p-3">Producto</th>
            <th className="p-3">Lote · Bodega</th><th className="p-3 text-right">Recepcionado</th><th className="p-3">Estado WMS</th><th className="p-3">Etiqueta</th><th className="p-3">Acciones</th>
          </tr></thead>
          <tbody className="divide-y divide-slate-200">
            {filtered.map(row => <tr key={row.package_code} className="hover:bg-blue-50/60">
              <td className="p-3"><span className="font-mono font-bold text-[#002855]">{row.package_code}</span><small className="block text-slate-500">Bulto {row.sequence_no}/{row.sequence_total}</small></td>
              <td className="p-3 font-medium">{row.source_document_no}<small className="block text-slate-500">{row.source_contract_code || 'Sin contrato'}</small></td>
              <td className="p-3">{row.source_product_code}<small className="block max-w-[260px] truncate text-slate-500" title={row.description}>{row.description}</small></td>
              <td className="p-3">{row.source_lot || '—'}<small className="block text-slate-500">{row.source_warehouse}</small></td>
              <td className="p-3 text-right tabular-nums">{row.quantity} {row.unit || ''}{row.weight_kg !== null && <small className="block text-slate-500">{row.weight_kg} kg</small>}</td>
              <td className="p-3"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${statusClass(row.status)}`}>{statusLabel[row.status] || row.status}</span></td>
              <td className="p-3"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${row.label_print_count > 0 ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}>{row.label_print_count > 0 ? 'Impresa' : 'Pendiente'}</span>{row.label_print_count > 1 && <small className="mt-1 block text-slate-500">{row.label_print_count - 1} reimpresión(es)</small>}</td>
              <td className="p-3"><button type="button" disabled={printingCode !== null} onClick={() => void printExistingPackage(row)} className="inline-flex min-h-9 items-center gap-2 whitespace-nowrap rounded-lg bg-[#002855] px-3 py-2 text-xs font-bold text-white disabled:opacity-50"><Printer size={14}/>{printingCode === row.package_code ? 'Preparando…' : row.label_print_count > 0 ? 'Reimprimir' : 'Imprimir etiqueta'}</button></td>
            </tr>)}
            {!loading && filtered.length === 0 && <tr><td colSpan={8} className="p-10 text-center text-sm text-slate-500">{query ? 'No hay recepciones que coincidan con la búsqueda.' : 'Todavía no hay bultos recepcionados en el APT.'}</td></tr>}
            {loading && <tr><td colSpan={8} className="p-10 text-center text-sm text-slate-500">Cargando recepciones…</td></tr>}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-xs text-slate-500">Cada acción utiliza el paquete existente y conserva su código de barras. Las reimpresiones requieren motivo y quedan auditadas.</p>
    </section>

    {printLabel && <div id="apt-reprint-root" aria-hidden="true">
      <article className="wh-label">
        <div className="wh-label-head">
          <div className="wh-logo"><img src="/logo-jrm.png" alt="JRM"/></div>
          <div className="wh-label-meta">
            <div><b>IPT:</b> {printLabel.source_document_no}</div>
            <div><b>OT/Contrato:</b> {printLabel.source_contract_code || '—'}</div>
            <div><b>Lote:</b> {printLabel.source_lot || '—'} · {printLabel.source_warehouse}</div>
          </div>
        </div>
        <b className="wh-sku">{printLabel.source_product_code}</b>
        <div className="wh-description">{printLabel.description}</div>
        <Code128Barcode value={printLabel.package_code} height={84} className="wh-barcode"/>
        <b className="wh-code">{printLabel.package_code}</b>
        <div className="wh-footer"><span><b>IPT:</b> {printLabel.source_document_no}<br/><b>Fecha:</b> {printLabel.source_date}</span><strong>{printLabel.quantity} {printLabel.unit || ''} · {printLabel.weight_kg === null ? 'Peso por registrar' : `${printLabel.weight_kg} kg`}</strong><span>{printLabel.sequence_no}/{printLabel.sequence_total}</span></div>
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
