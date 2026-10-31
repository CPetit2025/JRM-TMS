'use client'
import Link from 'next/link'
import { CircleDollarSign, Receipt, Truck, Wrench } from 'lucide-react'
import { StatusBadge } from '@/components/ui/status-badge'
import { money } from '@/lib/caja'
import type { DeliveryRow } from '@/lib/delivery'
import { ECON_STATUS, ITEM_LABEL, ITEM_STATUS, ORIGIN_TEXT, econKey } from '@/lib/economic-closure'
import { stopCosts, type DispatchCosts } from '@/lib/dispatch-detail'
import { DetailCard, Fields } from './DetailParts'
import { modalityLabel } from './ResumenTab'

const ECON_STEPS = ['POR_CERRAR', 'POR_APROBAR', 'CERRADO'] as const
const pen = (v: number | null | undefined) => v == null ? '—' : money(Number(v))
const itemBadge = (status: string) => { const s = ITEM_STATUS[status]; return <span className={`inline-flex rounded-full px-2 py-0.5 text-xs font-semibold ${s?.cls || 'bg-slate-100 text-slate-600'}`}>{s?.label || status}</span> }

/**
 * Costos de la parada: solo lo atribuible a la solicitud. El flete de una ruta consolidada sin reparto por OT y los
 * gastos de Caja de la ruta se muestran aparte y nunca se suman al total de la solicitud. Solo lectura: el cierre
 * económico se gestiona en su bandeja.
 */
export function CostosTab({ row, costs, economicHref }: { row: DeliveryRow; costs: DispatchCosts; economicHref?: string }) {
  if (!costs.detail) return <p role="status" className="rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">{costs.error || 'Sin acceso al cierre económico de esta ruta.'}</p>
  const d = costs.detail, c = stopCosts(d, row), key = econKey({ status: d.route_status, state: d.state, items: d.items }), econ = ECON_STATUS[key]
  const step = key === 'NO_APLICA' ? -1 : ECON_STEPS.indexOf(key as typeof ECON_STEPS[number])
  return <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(20rem,1fr)]">
    <div className="min-w-0 space-y-4">
      <DetailCard title="1. Flete y transporte" icon={<Truck className="h-5 w-5" aria-hidden />}>
        <Fields items={[['Proveedor / modalidad', modalityLabel(row)], ['Unidad', row.plate || 'Sin placa'], ['Conductor', row.driver_name || 'Sin conductor']]} />
        {c.freight ? <div className="mt-3 rounded-lg border border-slate-200 bg-slate-50 p-3">
          {c.freightScope === 'RUTA' && <p className="mb-2 text-xs font-semibold text-amber-800">Flete de la ruta completa ({d.requests.length} servicios): no se reparte por solicitud y no se suma al costo de {row.request_number}.</p>}
          <Fields cols="grid-cols-2 sm:grid-cols-4" items={[['Flete referencial', pen(c.freight.referential_pen)], ['Flete acordado', pen(c.freight.agreed_pen)], ['Flete final', pen(c.freight.final_pen)],
            ['Estado', itemBadge(c.freight.status)]]} />
          {c.freight.reason && <p className="mt-2 text-xs text-slate-600">Sustento: {c.freight.reason}</p>}
        </div> : <p className="mt-3 text-sm text-slate-500">Sin flete registrado.</p>}
      </DetailCard>
      <DetailCard title="2. Servicios adicionales" icon={<Wrench className="h-5 w-5" aria-hidden />}>
        {!c.services.length ? <p className="text-sm text-slate-500">Sin servicios adicionales para esta solicitud.</p> : <div className="overflow-x-auto"><table className="w-full min-w-[34rem] text-left text-sm">
          <thead className="bg-slate-50 text-xs text-slate-600"><tr>{['Servicio', 'Proveedor', 'Origen', 'Acordado', 'Final', 'Estado'].map(h => <th key={h} className="p-2 font-semibold">{h}</th>)}</tr></thead>
          <tbody className="divide-y">{c.services.map(s => <tr key={s.key}><td className="p-2 font-medium">{ITEM_LABEL[s.concept] || s.concept}</td><td className="p-2">{s.supplier || 'Por definir'}</td>
            <td className="p-2 text-slate-600">{s.origin ? ORIGIN_TEXT[s.origin] || s.origin : '—'}</td><td className="p-2 tabular-nums">{pen(s.agreed_pen)}</td><td className="p-2 tabular-nums">{pen(s.final_pen)}</td><td className="p-2">{itemBadge(s.status)}</td></tr>)}</tbody>
          <tfoot><tr className="bg-slate-50 font-semibold"><td colSpan={4} className="p-2 text-right">Total servicios adicionales</td><td colSpan={2} className="p-2 tabular-nums">{pen(c.servicesTotal)}</td></tr></tfoot>
        </table></div>}
      </DetailCard>
      <DetailCard title="3. Gastos de la ruta (Caja)" icon={<Receipt className="h-5 w-5" aria-hidden />}>
        {costs.expensesError ? <p className="text-sm text-slate-500">{costs.expensesError}</p> : !costs.expenses.length ? <p className="text-sm text-slate-500">Sin gastos registrados en la ruta.</p> : <>
          <ul className="divide-y rounded-lg border border-slate-200">{costs.expenses.map(e => <li key={e.id} className="flex flex-wrap items-center justify-between gap-2 p-3 text-sm">
            <div className="min-w-0"><p className="font-medium text-slate-800">{e.expense_type.replaceAll('_', ' ').toLowerCase().replace(/^./, x => x.toUpperCase())}</p>{e.description && <p className="text-xs text-slate-500">{e.description}</p>}</div>
            <span className="flex items-center gap-2"><span className="tabular-nums">{pen(e.amount)}</span>{e.status && <StatusBadge tone={e.status === 'APROBADO' ? 'success' : e.status === 'RECHAZADO' ? 'danger' : 'warning'}>{e.status.toLowerCase().replace(/^./, x => x.toUpperCase())}</StatusBadge>}</span>
          </li>)}</ul>
          <p className="mt-2 text-xs text-slate-500">Gastos de toda la ruta {row.dispatch_number}: no se atribuyen a una solicitud.</p>
        </>}
      </DetailCard>
    </div>
    <div className="min-w-0 space-y-4">
      <DetailCard title="Resumen de costos" icon={<CircleDollarSign className="h-5 w-5" aria-hidden />}>
        <dl className="divide-y text-sm">
          <div className="flex justify-between py-2"><dt>Flete {c.freightScope === 'RUTA' ? 'de la ruta (no se suma)' : 'de la solicitud'}</dt><dd className="tabular-nums">{pen(c.freight ? c.freight.final_pen ?? c.freight.agreed_pen : null)}</dd></div>
          <div className="flex justify-between py-2"><dt>Servicios adicionales</dt><dd className="tabular-nums">{pen(c.servicesTotal)}</dd></div>
          <div className="flex justify-between rounded-lg bg-blue-50 px-2 py-3 text-base font-bold text-jrm-navy"><dt>Costo de la solicitud</dt><dd className="tabular-nums">{pen(c.total)}</dd></div>
        </dl>
        <p className="mt-2 text-xs text-slate-500">Se usa el monto final validado; sin él, el acordado.</p>
      </DetailCard>
      <DetailCard title="Estado económico de la ruta" actions={<span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-semibold ${econ?.cls || ''}`}>{econ?.label || key}</span>}>
        {step >= 0 && <ol className="flex">{ECON_STEPS.map((s, i) => <li key={s} className="flex flex-1 flex-col items-center text-center text-xs">
          <span aria-hidden className={`grid h-7 w-7 place-items-center rounded-full ${i < step || key === 'CERRADO' ? 'bg-emerald-600 text-white' : i === step ? 'bg-blue-600 text-white' : 'bg-slate-200 text-slate-500'}`}>{i + 1}</span>
          <span className="mt-1 font-semibold text-slate-700">{ECON_STATUS[s].label}</span></li>)}</ol>}
        <p className="mt-3 text-xs text-slate-500">El cierre económico es independiente del operativo y del documentario.</p>
        {economicHref && <Link href={economicHref} className="mt-3 inline-flex min-h-10 items-center rounded-lg border border-slate-300 px-3 text-sm font-semibold text-jrm-navy">Gestionar cierre económico</Link>}
      </DetailCard>
    </div>
  </div>
}
