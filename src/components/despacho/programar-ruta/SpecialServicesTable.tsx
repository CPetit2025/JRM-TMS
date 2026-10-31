'use client'
import { Fragment, useEffect, useMemo, useRef, useState } from 'react'
import { ChevronDown, ChevronUp, Plus, Trash2, Undo2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'
import { ForkliftFields, type Forklift, type ForkliftStop } from '@/components/despacho/ForkliftFields'
import {
  AgreementFields, agreedAmount, agreedDiffers, billingQtyLabel, CONCEPT_LABEL, EMPTY_AGREEMENT, forkliftRowKey, ORIGIN_LABEL,
  specialServicesTotal, UNITS, unloadingAmountLabel, withForklift, type AddedService, type Agreement, type InheritedLine,
  type SpecialServicesState, type Supplier,
} from '@/components/despacho/InheritedSpecialServices'

// Servicios adicionales de la ruta en una sola tabla: lo pedido en las solicitudes (heredado), lo agregado al programar y
// el montacarga (proveedor, montacarguista, tarifa y horas en la misma fila). Cada servicio queda en su parada.
// transport_unloading_costs sigue siendo la única línea por servicio: aquí solo se arma p.special_services y p.forklift.

type Service = { id: string; request_number: string; unloading_required?: boolean | null }
type Row = { key: string; id?: string; transport_request_id: string; concept: string; agreement: Agreement; isForklift: boolean; line?: InheritedLine; added?: AddedService }
const money = (n: number) => n.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const input = 'w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-[#002855]'
const ADDABLE = ['GRUA', 'ESTIBA', 'MONTACARGAS', 'OTROS'] as const

export function SpecialServicesTable({ services, stops, lines, value, onChange, forklift, onForkliftChange }: {
  services: Service[]; stops: ForkliftStop[]; lines: InheritedLine[]; value: SpecialServicesState; onChange: (s: SpecialServicesState) => void
  forklift: Forklift; onForkliftChange: (f: Forklift) => void
}) {
  const supabase = useMemo(() => createClient(), [])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  const [open, setOpen] = useState<string | null>(null)
  const seq = useRef(0)
  useEffect(() => {
    let alive = true
    void supabase.from('suppliers').select('id,business_name,category').eq('is_active', true)
      .in('category', ['GRUA', 'ESTIBA', 'MONTACARGA', 'SERVICIOS', 'TRANSPORTE']).order('business_name')
      .then(({ data }) => { if (alive) setSuppliers((data || []) as Supplier[]) })
    return () => { alive = false }
  }, [supabase])
  if (!services.length) return <p className="rounded-lg border border-dashed border-slate-300 p-6 text-center text-sm text-slate-500">Seleccione primero los servicios de la ruta.</p>

  const fk = forkliftRowKey(lines, value, forklift)
  const rows: Row[] = [
    ...lines.map(l => ({ key: l.id, id: l.id, transport_request_id: l.transport_request_id, concept: l.concept, agreement: value.edits[l.id] ?? EMPTY_AGREEMENT, isForklift: l.id === fk, line: l })),
    ...value.added.map(a => ({ key: a.key, transport_request_id: a.transport_request_id, concept: a.concept, agreement: a as Agreement, isForklift: a.key === fk, added: a })),
  ]
  const requestNumber = (id: string) => services.find(s => s.id === id)?.request_number || '—'
  const supplierName = (id: string) => suppliers.find(s => s.id === id)?.business_name
  const setEdit = (id: string, a: Agreement) => onChange({ ...value, edits: { ...value.edits, [id]: a } })
  const setAdded = (key: string, patch: Partial<AddedService>) => onChange({ ...value, added: value.added.map(a => (a.key === key ? { ...a, ...patch } : a)) })
  const add = (concept: string, transport_request_id = services[0].id) => {
    const key = `nuevo-${services.length}-${++seq.current}`
    onChange({ ...value, added: [...value.added, { ...EMPTY_AGREEMENT, key, transport_request_id, concept, billing_unit: UNITS[concept]?.[0] || 'SERVICIO', description: '', reason: '' }] })
    setOpen(key)
  }
  const addForklift = () => {
    const stop = forklift.enabled && forklift.transport_request_id ? forklift.transport_request_id : stops.length === 1 ? stops[0].id : services[0].id
    if (!forklift.enabled) onForkliftChange({ ...forklift, enabled: true, transport_request_id: stop })
    if (!fk) add('MONTACARGAS', stop)
  }
  const removeForklift = () => onForkliftChange({ ...forklift, enabled: false })
  const { total } = specialServicesTotal(lines, value, forklift)
  const missingForkliftCost = forklift.enabled && !!forklift.transport_request_id && !fk
  const none = rows.length === 0 && !forklift.enabled && services.every(s => s.unloading_required !== true)

  const shown = (r: Row) => (r.isForklift ? withForklift(r.agreement, forklift) : r.agreement)
  const agreedOf = (r: Row) => ((r.agreement.supplier_id || r.agreement.agreed_rate || r.isForklift) ? agreedAmount(shown(r), r.concept) : null)
  const status = (r: Row): [string, string] => {
    if (r.id && r.id in value.removed) return ['No se programa', 'bg-red-50 text-red-700 ring-red-200']
    const agreed = agreedOf(r)
    if (r.isForklift && (!forklift.supplier_id || forklift.operator_name.trim().length < 3 || !(Number(forklift.hourly_rate) > 0) || !(Number(r.agreement.agreed_qty) > 0))) return ['Incompleto', 'bg-amber-50 text-amber-800 ring-amber-200']
    if (r.added && (agreed == null || r.added.reason.trim().length < 5)) return ['Incompleto', 'bg-amber-50 text-amber-800 ring-amber-200']
    if (r.line && agreed != null && agreedDiffers(r.line, agreed) && r.agreement.reason.trim().length < 5) return ['Falta motivo', 'bg-amber-50 text-amber-800 ring-amber-200']
    if (agreed != null) return ['Acordado', 'bg-emerald-50 text-emerald-700 ring-emerald-200']
    return ['Referencial', 'bg-slate-100 text-slate-600 ring-slate-200']
  }

  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs text-slate-600">Referencial: lo pedido en la solicitud. Acordado: lo pactado con el proveedor, se reserva en la partida. Real: se registra en Cierre económico.</p>
        {rows.length > 0 && <p className="text-xs text-slate-600">Total de la ruta: <b className="tabular-nums text-slate-900">S/ {money(total)}</b></p>}
      </div>
      {services.filter(s => s.unloading_required && !rows.some(r => r.transport_request_id === s.id)).map(s => (
        <p key={s.id} className="rounded-lg bg-slate-50 px-3 py-2 text-xs text-slate-600">{s.request_number}: requiere descarga · sin recurso detallado</p>
      ))}
      {missingForkliftCost && <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        <span>Montacarga en {requestNumber(forklift.transport_request_id)} sin costo acordado.</span>
        <span className="flex gap-3">
          <button type="button" onClick={() => add('MONTACARGAS', forklift.transport_request_id)} className="font-semibold text-blue-700 hover:underline">Registrar costo</button>
          <button type="button" onClick={removeForklift} className="font-semibold text-red-700 hover:underline">No programar montacarga</button>
        </span>
      </div>}
      {none ? <p className="rounded-lg border border-dashed border-slate-300 p-4 text-center text-slate-500">La ruta no requiere servicios adicionales.</p>
        : rows.length > 0 && <div className="overflow-x-auto rounded-lg border border-slate-200">
          <table className="w-full min-w-[720px] text-left text-xs">
            <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
              <tr>{['Servicio', 'Parada', 'Proveedor', 'Cantidad', 'Referencial', 'Acordado', 'Estado', ''].map(h => <th key={h} className="px-2 py-2 font-semibold">{h}</th>)}</tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map(r => {
                const removed = !!r.id && r.id in value.removed
                const isOpen = open === r.key
                const [label, tone] = status(r)
                const agreed = agreedOf(r)
                const a = shown(r)
                const supplier = r.isForklift ? supplierName(forklift.supplier_id) : supplierName(r.agreement.supplier_id)
                return <Fragment key={r.key}>
                  <tr className={removed ? 'bg-red-50/40' : isOpen ? 'bg-blue-50/50' : ''}>
                    <td className="px-2 py-2 font-semibold text-slate-900">{CONCEPT_LABEL[r.concept] || r.concept}
                      <span className="mt-0.5 block text-[10px] font-normal text-slate-500">{r.added ? 'Agregado al programar' : ORIGIN_LABEL[r.line?.origin || 'SOLICITUD'] || 'Solicitado'}</span></td>
                    <td className="px-2 py-2 text-slate-700">{requestNumber(r.transport_request_id)}</td>
                    <td className="max-w-40 truncate px-2 py-2 text-slate-700" title={supplier}>{supplier || <span className="text-slate-400">—</span>}{r.isForklift && forklift.operator_name && <span className="block truncate text-[10px] text-slate-500">{forklift.operator_name}</span>}</td>
                    <td className="px-2 py-2 tabular-nums text-slate-700">{r.agreement.agreed_qty ? `${r.agreement.agreed_qty} ${billingQtyLabel(a.billing_unit).toLowerCase()}` : '—'}</td>
                    <td className="px-2 py-2 tabular-nums text-slate-600">{r.line ? unloadingAmountLabel(r.line) : '—'}</td>
                    <td className="px-2 py-2 font-semibold tabular-nums text-slate-900">{agreed == null ? '—' : `S/ ${money(agreed)}`}</td>
                    <td className="px-2 py-2"><span className={`rounded-full px-2 py-0.5 text-[11px] font-semibold ring-1 ${tone}`}>{label}</span></td>
                    <td className="whitespace-nowrap px-2 py-2 text-right">
                      {!removed && <button type="button" onClick={() => setOpen(isOpen ? null : r.key)} aria-expanded={isOpen} aria-label={`${isOpen ? 'Cerrar' : 'Editar'} ${CONCEPT_LABEL[r.concept] || r.concept} de ${requestNumber(r.transport_request_id)}`}
                        className="inline-flex items-center gap-0.5 rounded px-1.5 py-1 font-semibold text-blue-700 hover:bg-blue-50">{isOpen ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}{isOpen ? 'Cerrar' : 'Editar'}</button>}
                      {r.added ? <button type="button" onClick={() => { onChange({ ...value, added: value.added.filter(x => x.key !== r.key) }); if (r.isForklift) removeForklift() }} className="ml-1 rounded p-1 text-slate-400 hover:text-red-600" aria-label="Quitar servicio agregado"><Trash2 className="h-4 w-4" /></button>
                        : removed ? <button type="button" onClick={() => { const next = { ...value.removed }; delete next[r.id!]; onChange({ ...value, removed: next }) }} className="ml-1 inline-flex items-center gap-1 font-semibold text-slate-600 hover:underline"><Undo2 className="h-3.5 w-3.5" />Mantener</button>
                        : <button type="button" onClick={() => { onChange({ ...value, removed: { ...value.removed, [r.id!]: '' } }); if (r.isForklift) removeForklift(); setOpen(null) }} className="ml-1 font-semibold text-red-600 hover:underline">No programar</button>}
                    </td>
                  </tr>
                  {removed && <tr className="bg-red-50/40"><td colSpan={8} className="px-2 pb-2">
                    <label className="block"><span className="mb-0.5 block text-[11px] font-semibold text-red-700">Motivo para no programarlo *</span>
                      <input value={value.removed[r.id!]} onChange={e => onChange({ ...value, removed: { ...value.removed, [r.id!]: e.target.value } })} className={input} placeholder="Ej.: el cliente descarga con su personal" /></label>
                  </td></tr>}
                  {isOpen && !removed && <tr className="bg-blue-50/30"><td colSpan={8} className="space-y-3 px-3 pb-3 pt-1">
                    {r.added && <div className="grid gap-2 sm:grid-cols-2">
                      <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Servicio</span>
                        <select aria-label="Tipo de servicio" value={r.added.concept} disabled={r.isForklift} onChange={e => setAdded(r.key, { concept: e.target.value, billing_unit: UNITS[e.target.value][0], supplier_id: '' })} className={input}>
                          {Object.entries(CONCEPT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select></label>
                      <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Parada</span>
                        <select aria-label="Parada" value={r.added.transport_request_id} onChange={e => { setAdded(r.key, { transport_request_id: e.target.value }); if (r.isForklift) onForkliftChange({ ...forklift, transport_request_id: e.target.value }) }} className={input}>
                          {services.map(s => <option key={s.id} value={s.id}>{s.request_number}</option>)}
                        </select></label>
                    </div>}
                    {r.isForklift && <ForkliftFields embedded value={forklift} onChange={onForkliftChange} stops={r.added ? undefined : stops} />}
                    {r.concept === 'MONTACARGAS' && !r.isForklift && !forklift.enabled && r.line &&
                      <button type="button" onClick={() => onForkliftChange({ ...forklift, enabled: true, transport_request_id: r.transport_request_id })} className="text-xs font-semibold text-blue-700 hover:underline">Asignar proveedor y montacarguista en esta parada</button>}
                    <AgreementFields concept={r.concept} value={r.agreement} suppliers={suppliers} forklift={r.isForklift ? forklift : null}
                      onChange={next => (r.added ? setAdded(r.key, next) : setEdit(r.key, next))} />
                    {r.line && agreed != null && agreedDiffers(r.line, agreed) &&
                      <label className="block"><span className="mb-0.5 block text-[11px] font-semibold text-amber-800">Motivo (el acordado difiere del referencial) *</span>
                        <input value={r.agreement.reason} onChange={e => setEdit(r.key, { ...r.agreement, reason: e.target.value })} className={input} placeholder="Ej.: el proveedor cobra por tonelada" /></label>}
                    {r.added && <div className="grid gap-2 sm:grid-cols-2">
                      <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Detalle</span>
                        <input value={r.added.description} onChange={e => setAdded(r.key, { description: e.target.value })} className={input} placeholder="Opcional" /></label>
                      <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Motivo (no estaba en la solicitud) *</span>
                        <input value={r.added.reason} onChange={e => setAdded(r.key, { reason: e.target.value })} className={input} placeholder="Ej.: la obra no tiene montacarga" /></label>
                    </div>}
                  </td></tr>}
                </Fragment>
              })}
            </tbody>
          </table>
        </div>}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-slate-600">Agregar:</span>
        {ADDABLE.map(concept => <button key={concept} type="button" disabled={concept === 'MONTACARGAS' && !!fk}
          onClick={() => (concept === 'MONTACARGAS' ? addForklift() : add(concept))}
          className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50 disabled:opacity-40"><Plus className="h-3.5 w-3.5" />{CONCEPT_LABEL[concept]}</button>)}
      </div>
      {rows.length > 0 && <p className="text-[11px] text-slate-500">Sin proveedor ni tarifa, el servicio se programa con su monto referencial. Lo acordado se reserva una sola vez en la partida y queda en el historial de costos.</p>}
    </div>
  )
}
