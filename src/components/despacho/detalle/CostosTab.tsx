'use client'
import { CircleDollarSign, Download, FileText, Fuel, Info, Paperclip, Pencil, Plus, Receipt, Truck, Wrench } from 'lucide-react'
import { money } from '@/lib/caja'
import type { DeliveryRow } from '@/lib/delivery'
import { ECON_STATUS, ITEM_LABEL, ITEM_STATUS, econKey, isZeroClosed } from '@/lib/economic-closure'
import { detailTime, downloadUrl, stopCosts, type DispatchCosts, type DispatchFiles } from '@/lib/dispatch-detail'
import { Callout, CellGrid, DetailCard, IconButton, MilestoneStepper, ServiceStrip } from './DetailParts'
import { modalityLabel } from './ResumenTab'

const pen = (v: number | null | undefined) => v == null ? '—' : money(Number(v))
const itemChip = (status: string) => { const s = ITEM_STATUS[status]; return <span className={`inline-flex whitespace-nowrap rounded-md px-2 py-1 text-xs font-semibold ${s?.cls || 'bg-slate-100 text-slate-600'}`}>{s?.label || status}</span> }
const UNIT: Record<string, string> = { HORA: 'h', JORNADA: 'jornada', SERVICIO: 'servicio', VIAJE: 'viaje' }
const title = (text: string) => text.replaceAll('_', ' ').toLowerCase().replace(/^./, c => c.toUpperCase())
const linkBtn = 'inline-flex min-h-10 items-center gap-2 rounded-lg border border-slate-300 px-4 text-sm font-semibold text-jrm-navy hover:bg-slate-50'

/**
 * Costos de la parada (se editan en el cierre económico, que se abre sobre este detalle). En una ruta con varios servicios,
 * el flete sin reparto por OT y los gastos de Caja son de la ruta: se muestran aparte y no se suman a esta solicitud.
 */
export function CostosTab({ row, costs, files, urls, servicesCount, onEconomic }: {
  row: DeliveryRow; costs: DispatchCosts; files: DispatchFiles | null; urls: Record<string, string | null>; servicesCount: number; onEconomic?: () => void
}) {
  if (!costs.detail) return <div className="space-y-4"><ServiceStrip row={row} icon={<Truck />} />
    <p role="status" className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-600">{costs.error || 'Sin acceso al cierre económico de esta ruta.'}</p></div>
  const d = costs.detail, c = stopCosts(d, row), key = econKey({ status: d.route_status, state: d.state, items: d.items }), econ = ECON_STATUS[key]
  const routeOnly = servicesCount > 1, freight = c.freight, ref = Number(freight?.referential_pen || 0), agreed = Number(freight?.agreed_pen || 0)
  const diff = freight ? Math.round(((freight.final_pen ?? agreed) - ref) * 100) / 100 : 0
  const expensesTotal = Math.round(costs.expenses.reduce((s, e) => s + Number(e.amount || 0), 0) * 100) / 100
  const total = Math.round((c.total + (routeOnly ? 0 : expensesTotal)) * 100) / 100
  const supports = [...(files?.documents || []).filter(x => x.category === 'COMPROBANTE').map(x => ({ key: x.id, name: x.file_name || x.number || 'Comprobante', at: x.uploaded_at, url: urls[`dispatch_documents/${x.file_path}`] })),
    ...costs.expenses.filter(e => e.receipt_url).map(e => ({ key: e.id, name: `Comprobante · ${title(e.expense_type)}`, at: e.created_at, url: costs.receipts[e.id] }))]
  const steps = (['POR_CERRAR', 'POR_APROBAR', 'CERRADO'] as const).map((s, i, all) => { const at = all.indexOf(key as typeof all[number])
    return { key: s, label: ECON_STATUS[s].label, at: null, state: key === 'NO_APLICA' ? 'pending' as const : i < at || key === 'CERRADO' ? 'done' as const : i === at ? 'current' as const : 'pending' as const, value: <span /> } })
  return <div className="grid items-start gap-4 sm:gap-5 xl:grid-cols-[minmax(0,1.75fr)_minmax(22rem,1fr)]">
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <ServiceStrip row={row} icon={<Truck />} />
      <DetailCard title="1. Flete y transporte" icon={<Truck />} actions={onEconomic && <button type="button" onClick={onEconomic} className={linkBtn}><Pencil className="h-4 w-4" aria-hidden />Editar</button>}>
        <CellGrid cols="grid-cols-1 sm:grid-cols-3" items={[['Proveedor / modalidad', modalityLabel(row)], ['Unidad', row.plate || 'Sin placa'], ['Conductor', row.driver_name || 'Sin conductor']]} />
        {freight && isZeroClosed(freight) ? <p className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">Sin flete: operación interna con flota propia (no se valoriza).</p>
        : freight ? <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          {c.freightScope === 'RUTA' && <p className="mb-2 text-xs font-semibold text-amber-800">Flete de la ruta completa ({d.requests.length} servicios): no se reparte por solicitud y no se suma al costo de {row.request_number}.</p>}
          <dl className="grid grid-cols-2 gap-3 text-sm sm:grid-cols-4 sm:divide-x sm:divide-slate-200">
            <div><dt className="flex items-center gap-1 text-xs text-slate-500">Flete referencial<Info aria-hidden className="h-3.5 w-3.5" /></dt><dd className="mt-1 text-xl font-bold text-slate-900">{pen(ref)}</dd></div>
            <div className="sm:pl-3"><dt className="flex items-center gap-1 text-xs text-slate-500">Flete acordado<Info aria-hidden className="h-3.5 w-3.5" /></dt><dd className="mt-1 flex flex-wrap items-center gap-2 text-xl font-bold text-slate-900">{pen(agreed)}
              <span className={`rounded-md px-2 py-0.5 text-xs font-semibold ${agreed === ref ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-800'}`}>{agreed === ref ? 'Sin variación' : `${agreed > ref ? '+' : ''}${money(agreed - ref)}`}</span></dd></div>
            <div className="sm:pl-3"><dt className="text-xs text-slate-500">Diferencia{freight.final_pen != null ? ' (final)' : ''}</dt><dd className="mt-1 text-xl font-bold text-slate-900">{pen(diff)}</dd></div>
            <div className="sm:pl-3"><dt className="flex items-center gap-1 text-xs text-slate-500"><FileText aria-hidden className="h-3.5 w-3.5" />Sustento de variación</dt><dd className="mt-1 text-slate-600">{freight.reason || 'No aplica'}</dd></div>
          </dl>
          <p className="mt-2 flex items-center gap-2 text-xs text-slate-500">Estado {itemChip(freight.status)}{freight.final_pen != null && <>· Flete final {pen(freight.final_pen)}</>}</p>
        </div> : <p className="mt-3 text-sm text-slate-500">Sin flete registrado.</p>}
      </DetailCard>
      <DetailCard title="2. Servicios adicionales" icon={<Wrench />} actions={onEconomic && <button type="button" onClick={onEconomic} className={linkBtn}><Plus className="h-4 w-4" aria-hidden />Agregar servicio</button>}>
        {!c.services.length ? <p className="text-sm text-slate-500">Sin servicios adicionales para esta solicitud.</p> : <div className="overflow-x-auto rounded-lg border border-slate-200"><table className="w-full min-w-[44rem] text-left text-sm">
          <thead className="bg-slate-50 text-slate-600"><tr>{['Servicio', 'Proveedor', 'Parada / Servicio', 'Cantidad', 'Tarifa (S/)', 'Importe (S/)', 'Estado'].map(h => <th key={h} className="px-3 py-2.5 font-medium">{h}</th>)}</tr></thead>
          <tbody className="divide-y divide-slate-200">{c.services.map(s => { const svc = d.services?.find(x => x.id === s.id), qty = s.billable_qty ?? svc?.final_billable_qty ?? svc?.agreed_qty
            return <tr key={s.key}><td className="px-3 py-2.5 font-medium">{ITEM_LABEL[s.concept] || s.concept}</td><td className="px-3 py-2.5">{s.supplier || 'Por definir'}</td><td className="px-3 py-2.5">{s.request_number || row.request_number}</td>
              <td className="px-3 py-2.5">{qty != null ? `${qty} ${UNIT[s.billing_unit || svc?.billing_unit || ''] || ''}` : '—'}</td><td className="px-3 py-2.5 tabular-nums">{svc?.agreed_rate != null ? money(svc.agreed_rate).replace('S/ ', '') : '—'}</td>
              <td className="px-3 py-2.5 tabular-nums">{money(s.final_pen ?? s.agreed_pen).replace('S/ ', '')}</td><td className="px-3 py-2.5">{itemChip(s.status)}</td></tr> })}</tbody>
          <tfoot><tr className="bg-blue-50/60 font-semibold text-jrm-navy"><td colSpan={5} className="px-3 py-2.5 text-right">Total servicios adicionales</td><td colSpan={2} className="px-3 py-2.5 tabular-nums">{pen(c.servicesTotal)}</td></tr></tfoot>
        </table></div>}
      </DetailCard>
      <DetailCard title="3. Otros costos" icon={<Receipt />}>
        {costs.expensesError ? <p className="text-sm text-slate-500">{costs.expensesError}</p> : !costs.expenses.length ? <p className="text-sm text-slate-500">Sin gastos de Caja registrados en la ruta (combustible, peajes, viáticos).</p> : <>
          <div className="overflow-x-auto rounded-lg border border-slate-200"><table className="w-full min-w-[36rem] text-left text-sm">
            <thead className="bg-slate-50 text-slate-600"><tr>{['Concepto', 'Descripción', 'Fecha', 'Importe (S/)', 'Estado'].map(h => <th key={h} className="px-3 py-2.5 font-medium">{h}</th>)}</tr></thead>
            <tbody className="divide-y divide-slate-200">{costs.expenses.map(e => <tr key={e.id}><td className="px-3 py-2.5 font-medium"><span className="flex items-center gap-2"><Fuel aria-hidden className="h-4 w-4 text-jrm-navy" />{title(e.expense_type)}</span></td>
              <td className="px-3 py-2.5 text-slate-600">{e.description || '—'}</td><td className="px-3 py-2.5 tabular-nums text-slate-600">{e.created_at ? detailTime(e.created_at) : '—'}</td>
              <td className="px-3 py-2.5 tabular-nums">{money(e.amount).replace('S/ ', '')}</td>
              <td className="px-3 py-2.5">{e.status && <span className={`rounded-md px-2 py-1 text-xs font-semibold ${e.status === 'APROBADO' ? 'bg-emerald-50 text-emerald-700' : e.status === 'RECHAZADO' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-800'}`}>{title(e.status)}</span>}</td></tr>)}</tbody>
            <tfoot><tr className="bg-blue-50/60 font-semibold text-jrm-navy"><td colSpan={3} className="px-3 py-2.5 text-right">Total otros costos</td><td colSpan={2} className="px-3 py-2.5 tabular-nums">{pen(expensesTotal)}</td></tr></tfoot>
          </table></div>
          {routeOnly && <p className="mt-2 text-xs text-slate-500">Gastos de toda la ruta {row.dispatch_number}: no se atribuyen a una solicitud.</p>}
        </>}
      </DetailCard>
    </div>
    <div className="min-w-0 space-y-4 sm:space-y-5">
      <DetailCard title="Resumen de costos" icon={<Receipt />}>
        <dl className="divide-y divide-slate-100 text-sm">
          <div className="flex justify-between gap-2 py-2.5"><dt>Flete referencial{c.freightScope === 'RUTA' ? ' (ruta)' : ''}</dt><dd className="tabular-nums">{pen(freight ? ref : null)}</dd></div>
          <div className="flex justify-between gap-2 py-2.5"><dt>Flete acordado{c.freightScope === 'RUTA' ? ' (ruta, no se suma)' : ''}</dt><dd className="font-semibold tabular-nums">{pen(freight ? (freight.final_pen ?? agreed) : null)}</dd></div>
          <div className="flex justify-between gap-2 py-2.5"><dt>Servicios adicionales</dt><dd className="tabular-nums">{pen(c.servicesTotal)}</dd></div>
          <div className="flex justify-between gap-2 py-2.5"><dt>Otros costos{routeOnly ? ' (ruta, no se suman)' : ''}</dt><dd className="tabular-nums">{costs.expensesError ? '—' : pen(expensesTotal)}</dd></div>
        </dl>
        <div className="mt-2 flex items-center justify-between rounded-lg bg-blue-50 px-4 py-4 text-jrm-navy"><span className="font-semibold">Costo total {routeOnly ? 'de la solicitud' : 'del despacho'}</span><span className="text-2xl font-bold tabular-nums">{pen(total)}</span></div>
        <p className="mt-2 text-xs text-slate-500">Se usa el monto final validado; sin él, el acordado.</p>
      </DetailCard>
      <DetailCard title="Estado económico" icon={<CircleDollarSign />} actions={<span className={`rounded-full px-2.5 py-1 text-xs font-semibold ${econ?.cls || ''}`}>{econ?.label || key}</span>}>
        {key !== 'NO_APLICA' && <MilestoneStepper steps={steps} />}
        <Callout title={key === 'NO_APLICA' ? 'Ruta sin costos' : key === 'CERRADO' ? 'Cierre económico completo' : 'El despacho cuenta con costos registrados.'}>
          {key === 'CERRADO' ? 'Todos los ítems están aprobados.' : key === 'NO_APLICA' ? 'No hay montos que cerrar.' : 'La validación y el cierre se realizan en la bandeja del cierre económico. Es independiente del cierre operativo y del documentario.'}
        </Callout>
      </DetailCard>
      <DetailCard title={`Archivos de soporte (${supports.length})`} icon={<Paperclip />}>
        {!supports.length ? <p className="text-sm text-slate-500">Sin comprobantes registrados.</p> : <ul className="space-y-2">{supports.map(s => <li key={s.key} className="flex items-center gap-3 rounded-lg border border-slate-200 p-2.5">
          <FileText aria-hidden className="h-7 w-7 shrink-0 text-rose-500" /><div className="min-w-0 flex-1 text-sm"><p className="truncate font-medium text-slate-800">{s.name}</p><p className="text-xs text-slate-500">{s.at ? detailTime(s.at) : ''}</p></div>
          {s.url && <IconButton label={`Descargar ${s.name}`} href={downloadUrl(s.url)} download><Download className="h-4 w-4" /></IconButton>}
        </li>)}</ul>}
      </DetailCard>
    </div>
  </div>
}
