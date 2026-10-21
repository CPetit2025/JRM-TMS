'use client'

import { useEffect, useMemo, useState } from 'react'
import { Download, Loader2, RefreshCw } from 'lucide-react'
import { toast } from 'sonner'
import { createClient } from '@/lib/supabase/client'

type ServiceRow = {
  id: string; type: 'TRANSPORTE' | 'MONTACARGA'; dispatch: string; date: string | null; status: string
  supplierId: string; supplier: string; ruc: string; plate: string; operator: string; document: string
  rate: number | null; hours: number | null; amount: number; start: string | null; end: string | null
}
type CarrierRecord = { id: string; dispatch_number: string; scheduled_departure: string | null; status: string; vehicle_plate: string | null; freight_cost: number | null; carrier_id: string; tercero_conductor: string | null; tercero_doc: string | null }
type ForkliftRecord = { dispatch_id: string; supplier_id: string; operator_name: string; document_number: string | null; hourly_rate: number | null; final_hours: number | null; final_amount: number | null; service_started_at: string | null; service_ended_at: string | null; suppliers: { business_name: string; tax_id: string } | null; dispatches: { dispatch_number: string; scheduled_departure: string | null; status: string; vehicle_plate: string | null } | null }
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date())
const money = (n: number) => `S/ ${n.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const dateLabel = (s: string | null) => s ? new Date(s).toLocaleString('es-PE', { timeZone: 'America/Lima' }) : '—'

export function SupplierServiceReport() {
  const supabase = useMemo(() => createClient(), [])
  const [rows, setRows] = useState<ServiceRow[]>([]), [loading, setLoading] = useState(true), [error, setError] = useState('')
  const [kind, setKind] = useState<'TODOS' | ServiceRow['type']>('TODOS')
  const [supplier, setSupplier] = useState(''), [from, setFrom] = useState(`${today().slice(0, 7)}-01`), [to, setTo] = useState(today())
  const [busy, setBusy] = useState(false)
  const load = async () => {
    setLoading(true); setError('')
    try {
      const [carriers, forklifts] = await Promise.all([
        supabase.from('dispatches').select('id,dispatch_number,scheduled_departure,status,vehicle_plate,freight_cost,carrier_id,tercero_conductor,tercero_doc').eq('modalidad', 'TERCERO').gte('scheduled_departure', `${from}T00:00:00-05:00`).lte('scheduled_departure', `${to}T23:59:59.999-05:00`).order('scheduled_departure', { ascending: false }).limit(1000),
        supabase.from('route_forklifts').select('dispatch_id,supplier_id,operator_name,document_number,hourly_rate,final_hours,final_amount,service_started_at,service_ended_at,suppliers(business_name,tax_id),dispatches(dispatch_number,scheduled_departure,status,vehicle_plate)').gte('dispatches.scheduled_departure', `${from}T00:00:00-05:00`).lte('dispatches.scheduled_departure', `${to}T23:59:59.999-05:00`).order('dispatch_id').limit(1000),
      ])
      if (carriers.error) throw carriers.error
      if (forklifts.error) throw forklifts.error
      const carrierRecords = (carriers.data || []) as unknown as CarrierRecord[]
      const carrierIds = [...new Set(carrierRecords.map(x => x.carrier_id).filter(Boolean))]
      const directory = carrierIds.length ? await supabase.from('carriers').select('id,business_name,ruc').in('id', carrierIds) : { data: [], error: null }
      if (directory.error) throw directory.error
      const carrierMap = new Map((directory.data || []).map(x => [x.id, x]))
      const transport: ServiceRow[] = carrierRecords.map(x => {
        const carrier = carrierMap.get(x.carrier_id)
        return { id: x.id, type: 'TRANSPORTE', dispatch: x.dispatch_number, date: x.scheduled_departure, status: x.status, supplierId: x.carrier_id, supplier: carrier?.business_name || 'Transportista', ruc: carrier?.ruc || '', plate: x.vehicle_plate || '', operator: x.tercero_conductor || '', document: x.tercero_doc || '', rate: null, hours: null, amount: Number(x.freight_cost || 0), start: null, end: null }
      })
      const forkliftRows: ServiceRow[] = ((forklifts.data || []) as unknown as ForkliftRecord[]).flatMap(x => {
        const d = x.dispatches
        const s = x.suppliers
        return d ? [{ id: x.dispatch_id, type: 'MONTACARGA' as const, dispatch: d.dispatch_number, date: d.scheduled_departure, status: d.status, supplierId: x.supplier_id, supplier: s?.business_name || 'Proveedor montacarga', ruc: s?.tax_id || '', plate: d.vehicle_plate || '', operator: x.operator_name, document: x.document_number || '', rate: x.hourly_rate == null ? null : Number(x.hourly_rate), hours: x.final_hours == null ? null : Number(x.final_hours), amount: Number(x.final_amount || 0), start: x.service_started_at, end: x.service_ended_at }] : []
      })
      setRows([...transport, ...forkliftRows].sort((a, b) => (b.date || '').localeCompare(a.date || '')))
    } catch (e) { setError(e instanceof Error ? e.message : 'No se pudieron cargar los servicios.') }
    finally { setLoading(false) }
  }
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load() // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const options = useMemo(() => [...new Map(rows.filter(r => kind === 'TODOS' || r.type === kind).map(r => [r.supplierId, { id: r.supplierId, label: r.supplier }])).values()], [rows, kind])
  const filtered = rows.filter(r => (kind === 'TODOS' || r.type === kind) && (!supplier || r.supplierId === supplier))
  const makePdf = async () => {
    if (!filtered.length) return
    setBusy(true)
    try {
      const { jsPDF } = await import('jspdf'), pdf = new jsPDF({ unit: 'mm', format: 'a4' })
      const vendor = supplier ? options.find(x => x.id === supplier)?.label : 'Todos los proveedores'
      pdf.setFontSize(16); pdf.text('NOTA DE SERVICIOS PARA FACTURACIÓN', 15, 20)
      pdf.setFontSize(10); pdf.text(`Proveedor: ${vendor || 'Todos'} · Período: ${from} al ${to}`, 15, 29)
      let y = 40
      for (const r of filtered) {
        const lines = [`${r.type} · ${r.dispatch} · ${r.date ? dateLabel(r.date) : '—'}`, `${r.supplier} · RUC ${r.ruc || '—'}`, `Placa ${r.plate || '—'} · Responsable ${r.operator || '—'}${r.document ? ` · DNI ${r.document}` : ''}`, r.type === 'MONTACARGA' ? `Servicio ${dateLabel(r.start)} a ${dateLabel(r.end)} · ${r.hours ?? 'Pendiente'} h × ${money(r.rate || 0)} = ${money(r.amount)}` : `Flete contratado: ${money(r.amount)}`]
        if (y > 250) { pdf.addPage(); y = 20 }
        pdf.setFontSize(9); lines.forEach(line => { pdf.text(line.slice(0, 150), 15, y); y += 5 }); pdf.setDrawColor(210); pdf.line(15, y, 195, y); y += 5
      }
      pdf.setFontSize(8); pdf.text('Sustento de servicios prestados para revisión y facturación del proveedor.', 15, 282)
      pdf.save(`Nota_servicios_${from}_${to}.pdf`)
    } catch (e) { toast.error(e instanceof Error ? e.message : 'No se pudo generar el PDF') }
    finally { setBusy(false) }
  }
  return <section className="space-y-4 rounded-xl border border-slate-200 bg-white p-4">
    <div><h2 className="text-lg font-bold text-[#002855]">Servicios de proveedores logísticos</h2><p className="text-sm text-slate-500">Consulta fletes de transportistas y servicios de montacarga, y genera la nota de servicio para sustentar la factura.</p></div>
    <div className="flex flex-wrap items-end gap-3 rounded-lg bg-slate-50 p-3">
      <label className="text-xs font-semibold">Servicio<select className="mt-1 block min-h-10 rounded-lg border bg-white px-3" value={kind} onChange={e => { setKind(e.target.value as typeof kind); setSupplier('') }}><option value="TODOS">Todos</option><option value="TRANSPORTE">Transportista</option><option value="MONTACARGA">Montacarga</option></select></label>
      <label className="text-xs font-semibold">Proveedor<select className="mt-1 block min-h-10 max-w-64 rounded-lg border bg-white px-3" value={supplier} onChange={e => setSupplier(e.target.value)}><option value="">Todos los proveedores</option>{options.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}</select></label>
      <label className="text-xs font-semibold">Desde<input type="date" className="mt-1 block min-h-10 rounded-lg border bg-white px-3" value={from} max={to} onChange={e => setFrom(e.target.value)} /></label>
      <label className="text-xs font-semibold">Hasta<input type="date" className="mt-1 block min-h-10 rounded-lg border bg-white px-3" value={to} min={from} onChange={e => setTo(e.target.value)} /></label>
      <button type="button" onClick={() => void load()} className="inline-flex min-h-10 items-center gap-2 rounded-lg border bg-white px-3 text-sm font-semibold"><RefreshCw className="h-4 w-4" />Actualizar</button>
      <button type="button" onClick={() => void makePdf()} disabled={!filtered.length || busy} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-[#002855] px-3 text-sm font-semibold text-white disabled:opacity-50"><Download className="h-4 w-4" />{busy ? 'Generando…' : 'Generar nota PDF'}</button>
    </div>
    {error && <p role="alert" className="rounded-lg bg-red-50 p-3 text-sm text-red-800">{error}</p>}
    {loading ? <div className="flex justify-center p-8"><Loader2 className="h-6 w-6 animate-spin" /></div> : <div className="overflow-x-auto"><table className="w-full min-w-[850px] text-left text-sm"><thead className="bg-slate-50 text-xs text-slate-600"><tr>{['Servicio', 'Fecha / ruta', 'Proveedor', 'Placa / operador', 'Horas × tarifa', 'Monto'].map(x => <th key={x} className="p-3">{x}</th>)}</tr></thead><tbody className="divide-y">{filtered.map(r => <tr key={`${r.type}-${r.id}`}><td className="p-3">{r.type === 'TRANSPORTE' ? 'Transportista' : 'Montacarga'}</td><td className="p-3">{r.date ? `${dateLabel(r.date)} · ${r.dispatch}` : r.dispatch}</td><td className="p-3">{r.supplier}<small className="block text-slate-500">RUC {r.ruc || '—'}</small></td><td className="p-3">{r.plate || '—'}<small className="block text-slate-500">{r.operator || '—'}</small></td><td className="p-3">{r.type === 'MONTACARGA' ? `${r.hours ?? 'Pendiente'} h × ${money(r.rate || 0)}${r.start ? ` · ${dateLabel(r.start)} – ${dateLabel(r.end)}` : ''}` : 'Flete'}</td><td className="p-3 font-semibold">{money(r.amount)}</td></tr>)}{!filtered.length && <tr><td colSpan={6} className="p-8 text-center text-slate-500">No hay servicios para los filtros seleccionados.</td></tr>}</tbody></table></div>}
  </section>
}
