'use client'
import { useEffect, useMemo, useState } from 'react'
import { Plus, Trash2, Undo2 } from 'lucide-react'
import { createClient } from '@/lib/supabase/client'

// Servicios especiales de la ruta (grúa, montacarga, estiba). Lo pedido en la solicitud se hereda; al programar se
// acuerda con el proveedor (modalidad, tarifa y cantidad) y se pueden agregar o retirar servicios con motivo.
// transport_unloading_costs sigue siendo la única línea por servicio: el monto acordado es su planned_pen.

export type InheritedLine = {
  id: string; transport_request_id: string; concept: string; description: string | null
  estimated_pen: number; planned_pen: number | null; status: string; origin: string | null
  tariff_missing: boolean | null; estimated_source: string | null
}
type Service = { id: string; request_number: string; unloading_required?: boolean | null }
type Supplier = { id: string; business_name: string; category: string }
type ForkliftRef = { enabled: boolean; transport_request_id: string; supplier_id: string; hourly_rate: string }

export type Agreement = { supplier_id: string; billing_unit: string; agreed_rate: string; agreed_qty: string; workers: string; min_billable_qty: string; fraction_minutes: string; reason: string }
export type AddedService = Agreement & { key: string; transport_request_id: string; concept: string; description: string; reason: string }
export type SpecialServicesState = { edits: Record<string, Agreement>; removed: Record<string, string>; added: AddedService[] }
export const EMPTY_SPECIAL_SERVICES: SpecialServicesState = { edits: {}, removed: {}, added: [] }
const EMPTY_AGREEMENT: Agreement = { supplier_id: '', billing_unit: 'SERVICIO', agreed_rate: '', agreed_qty: '', workers: '', min_billable_qty: '', fraction_minutes: '', reason: '' }

export const INHERITED_LINE_COLUMNS = 'id, transport_request_id, concept, description, estimated_pen, planned_pen, status, origin, tariff_missing, estimated_source'
export const CONCEPT_LABEL: Record<string, string> = { MONTACARGAS: 'Montacargas', GRUA: 'Grúa', ESTIBA: 'Estiba', OTROS: 'Otros' }
export const ORIGIN_LABEL: Record<string, string> = { SOLICITUD: 'Solicitado', PROGRAMACION: 'Programación', CAJA: 'Caja' }
export const BILLING_LABEL: Record<string, string> = { SERVICIO: 'Por servicio', HORA: 'Por hora', JORNADA: 'Por jornada', UNIDAD: 'Por unidad', TONELADA: 'Por tonelada' }
const QTY_LABEL: Record<string, string> = { SERVICIO: 'Servicios', HORA: 'Horas', JORNADA: 'Jornadas', UNIDAD: 'Unidades', TONELADA: 'Toneladas' }
/** Nombre de la cantidad según la modalidad de cobro (Horas, Jornadas, Unidades, Toneladas…). */
export const billingQtyLabel = (unit: string | null | undefined) => QTY_LABEL[unit || 'SERVICIO'] || 'Servicios'
// Por unidad o tonelada la tarifa no se multiplica por trabajadores (mismo criterio que el servidor).
const perWorker = (unit: string) => unit !== 'UNIDAD' && unit !== 'TONELADA'
const UNITS: Record<string, string[]> = { MONTACARGAS: ['HORA', 'SERVICIO'], GRUA: ['SERVICIO', 'HORA', 'TONELADA', 'UNIDAD'], ESTIBA: ['JORNADA', 'HORA', 'SERVICIO', 'TONELADA', 'UNIDAD'], OTROS: ['SERVICIO', 'HORA', 'JORNADA', 'TONELADA', 'UNIDAD'] }
const CATEGORIES: Record<string, string[]> = { MONTACARGAS: ['MONTACARGA', 'SERVICIOS'], GRUA: ['GRUA', 'SERVICIOS'], ESTIBA: ['ESTIBA', 'SERVICIOS'], OTROS: ['SERVICIOS', 'GRUA', 'ESTIBA', 'MONTACARGA', 'TRANSPORTE'] }
const money = (n: number) => n.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
const num = (v: string) => (v.trim() === '' ? null : Number(v))

export function unloadingAmountLabel(l: { estimated_pen: number; planned_pen?: number | null; tariff_missing?: boolean | null; estimated_source?: string | null }) {
  const amount = Number(l.planned_pen ?? l.estimated_pen ?? 0)
  if (l.estimated_source === 'MANUAL') return `S/ ${money(amount)} · manual (sin tarifa)`
  if (l.tariff_missing && amount === 0) return 'Sin tarifa'
  return `S/ ${money(amount)}`
}

/** Monto acordado = tarifa × max(cantidad, mínimo) × trabajadores (mismo cálculo que el servidor). */
export function agreedAmount(a: Agreement, concept: string): number | null {
  const rate = num(a.agreed_rate), qty = num(a.agreed_qty) ?? 1, min = a.billing_unit === 'SERVICIO' ? 0 : num(a.min_billable_qty) ?? 0
  const workers = concept === 'ESTIBA' && perWorker(a.billing_unit) ? num(a.workers) ?? 1 : 1
  if (rate == null || !(rate > 0) || !(qty > 0) || !(workers >= 1)) return null
  return Math.round(rate * Math.max(qty, min) * workers * 100) / 100
}

/** Referencial de la solicitud (con tarifa o costo manual); null = «sin tarifa», no exige motivo. */
function referentialOf(l: InheritedLine) {
  return l.tariff_missing && l.estimated_source !== 'MANUAL' ? null : Number(l.estimated_pen ?? 0)
}

/** El acordado de una línea heredada difiere de su referencial: se exige motivo (igual que el servidor). */
export function agreedDiffers(l: InheritedLine, amount: number | null) {
  const ref = referentialOf(l)
  return amount != null && ref != null && Math.round(amount * 100) !== Math.round(ref * 100)
}

type Row = { key: string; id?: string; transport_request_id: string; concept: string; agreement: Agreement; forklift: boolean }

// La línea de montacargas de la parada del montacarga programado toma su proveedor y tarifa por hora.
function forkliftRowKey(lines: InheritedLine[], state: SpecialServicesState, forklift: ForkliftRef) {
  if (!forklift.enabled || !forklift.transport_request_id) return null
  const line = lines.find(l => l.concept === 'MONTACARGAS' && l.transport_request_id === forklift.transport_request_id && !(l.id in state.removed))
  if (line) return line.id
  return state.added.find(a => a.concept === 'MONTACARGAS' && a.transport_request_id === forklift.transport_request_id)?.key ?? null
}

function withForklift(a: Agreement, forklift: ForkliftRef): Agreement {
  return { ...a, supplier_id: forklift.supplier_id, billing_unit: 'HORA', agreed_rate: forklift.hourly_rate }
}

/** Arma p.special_services de schedule_route_resources o devuelve el primer error a corregir. */
export function specialServicesPayload(state: SpecialServicesState, lines: InheritedLine[], forklift: ForkliftRef) {
  const fk = forkliftRowKey(lines, state, forklift)
  if (forklift.enabled && !fk) return { error: 'El montacarga programado no tiene costo acordado: use «Agregar costo del montacarga» en Servicios especiales.' }
  const items: Record<string, unknown>[] = []
  const removed: { id: string; reason: string }[] = []
  for (const [id, reason] of Object.entries(state.removed)) {
    const l = lines.find(x => x.id === id)
    if (!l) continue
    if (reason.trim().length < 5) return { error: `Indique el motivo para no programar ${CONCEPT_LABEL[l.concept]?.toLowerCase() || 'el servicio'} (mínimo 5 caracteres).` }
    removed.push({ id, reason: reason.trim() })
  }
  const agreement = (key: string, a: Agreement, concept: string) => {
    const isForklift = key === fk
    const value = isForklift ? withForklift(a, forklift) : a
    const label = CONCEPT_LABEL[concept]?.toLowerCase() || 'el servicio'
    if (isForklift && !(Number(value.agreed_qty) > 0)) return { error: 'Indique las horas estimadas del montacarga.' }
    if (!value.supplier_id) return { error: `Seleccione el proveedor de ${label}.` }
    const amount = agreedAmount(value, concept)
    if (amount == null) return { error: `Complete la tarifa y cantidad acordadas de ${label}.` }
    return {
      amount,
      value: {
        supplier_id: value.supplier_id, billing_unit: value.billing_unit, agreed_rate: num(value.agreed_rate), agreed_qty: num(value.agreed_qty) ?? 1,
        workers: concept === 'ESTIBA' && perWorker(value.billing_unit) ? num(value.workers) ?? 1 : null, min_billable_qty: value.billing_unit === 'SERVICIO' ? null : num(value.min_billable_qty),
        fraction_minutes: value.billing_unit === 'HORA' ? num(value.fraction_minutes) : null,
      },
    }
  }
  for (const l of lines) {
    if (l.id in state.removed) continue
    const a = state.edits[l.id]
    const touched = a && (a.supplier_id || a.agreed_rate.trim() || a.agreed_qty.trim())
    if (!touched && l.id !== fk) continue  // sin acuerdo: conserva el monto pedido
    const r = agreement(l.id, a ?? EMPTY_AGREEMENT, l.concept)
    if (r.error) return { error: r.error }
    const differs = agreedDiffers(l, r.amount ?? null), reason = (a?.reason ?? '').trim()
    if (differs && reason.length < 5) return { error: `Indique el motivo: el acordado de ${CONCEPT_LABEL[l.concept]?.toLowerCase() || 'el servicio'} difiere del referencial (mínimo 5 caracteres).` }
    items.push({ id: l.id, ...r.value, ...(differs ? { reason } : {}) })
  }
  for (const s of state.added) {
    if (s.reason.trim().length < 5) return { error: `Indique el motivo del servicio de ${CONCEPT_LABEL[s.concept]?.toLowerCase()} agregado en programación (mínimo 5 caracteres).` }
    const r = agreement(s.key, s, s.concept)
    if (r.error) return { error: r.error }
    items.push({ transport_request_id: s.transport_request_id, concept: s.concept, description: s.description.trim() || null, reason: s.reason.trim(), ...r.value })
  }
  return { value: items.length || removed.length ? { items, removed } : null }
}

function AgreementFields({ concept, value, onChange, suppliers, forklift }: {
  concept: string; value: Agreement; onChange: (a: Agreement) => void; suppliers: Supplier[]; forklift: ForkliftRef | null
}) {
  const shown = forklift ? withForklift(value, forklift) : value
  const amount = agreedAmount(shown, concept)
  const input = 'w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-[#002855]'
  const options = suppliers.filter(s => (CATEGORIES[concept] || []).includes(s.category))
  const qtyLabel = billingQtyLabel(shown.billing_unit)
  return (
    <div className="mt-2 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
      {forklift ? (
        <p className="sm:col-span-2 text-xs text-slate-600 self-center">Proveedor y tarifa por hora del montacarga programado (S/ {shown.agreed_rate || '—'}/h).</p>
      ) : (<>
        <label className="sm:col-span-2"><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Proveedor</span>
          <select value={value.supplier_id} onChange={e => onChange({ ...value, supplier_id: e.target.value })} className={input}>
            <option value="">{options.length ? 'Seleccione…' : 'Sin proveedores de esta categoría'}</option>
            {options.map(s => <option key={s.id} value={s.id}>{s.business_name}</option>)}
          </select></label>
        <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Modalidad</span>
          <select value={value.billing_unit} onChange={e => onChange({ ...value, billing_unit: e.target.value })} className={input}>
            {(UNITS[concept] || ['SERVICIO']).map(u => <option key={u} value={u}>{BILLING_LABEL[u]}</option>)}
          </select></label>
        <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Tarifa S/</span>
          <input inputMode="decimal" value={value.agreed_rate} onChange={e => onChange({ ...value, agreed_rate: e.target.value })} placeholder="0.00" className={input} /></label>
      </>)}
      <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">{forklift ? 'Horas estimadas' : qtyLabel}</span>
        <input inputMode="decimal" value={value.agreed_qty} onChange={e => onChange({ ...value, agreed_qty: e.target.value })} placeholder="1" className={input} /></label>
      {concept === 'ESTIBA' && perWorker(shown.billing_unit) && <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Trabajadores</span>
        <input inputMode="numeric" value={value.workers} onChange={e => onChange({ ...value, workers: e.target.value })} placeholder="1" className={input} /></label>}
      {shown.billing_unit !== 'SERVICIO' && <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Mínimo facturable</span>
        <input inputMode="decimal" value={value.min_billable_qty} onChange={e => onChange({ ...value, min_billable_qty: e.target.value })} placeholder="—" className={input} /></label>}
      {shown.billing_unit === 'HORA' && <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Fracción</span>
        <select value={value.fraction_minutes} onChange={e => onChange({ ...value, fraction_minutes: e.target.value })} className={input}>
          <option value="">Hora completa</option><option value="15">15 min</option><option value="30">30 min</option><option value="60">60 min</option>
        </select></label>}
      <p className="self-end pb-1.5 text-sm"><span className="text-[11px] text-slate-500">Acordado </span>
        <b className="tabular-nums text-slate-900">{amount == null ? '—' : `S/ ${money(amount)}`}</b></p>
    </div>
  )
}

export function InheritedSpecialServices({ services, lines, value, onChange, forklift }: {
  services: Service[]; lines: InheritedLine[]; value: SpecialServicesState; onChange: (s: SpecialServicesState) => void; forklift: ForkliftRef
}) {
  const supabase = useMemo(() => createClient(), [])
  const [suppliers, setSuppliers] = useState<Supplier[]>([])
  useEffect(() => {
    let alive = true
    void supabase.from('suppliers').select('id,business_name,category').eq('is_active', true)
      .in('category', ['GRUA', 'ESTIBA', 'MONTACARGA', 'SERVICIOS', 'TRANSPORTE']).order('business_name')
      .then(({ data }) => { if (alive) setSuppliers((data || []) as Supplier[]) })
    return () => { alive = false }
  }, [supabase])
  if (!services.length) return null

  const fk = forkliftRowKey(lines, value, forklift)
  const rows: Row[] = [
    ...lines.map(l => ({ key: l.id, id: l.id, transport_request_id: l.transport_request_id, concept: l.concept, agreement: value.edits[l.id] ?? EMPTY_AGREEMENT, forklift: l.id === fk })),
    ...value.added.map(a => ({ key: a.key, transport_request_id: a.transport_request_id, concept: a.concept, agreement: a, forklift: a.key === fk })),
  ]
  const requestNumber = (id: string) => services.find(s => s.id === id)?.request_number || '—'
  const setEdit = (id: string, a: Agreement) => onChange({ ...value, edits: { ...value.edits, [id]: a } })
  const setAdded = (key: string, patch: Partial<AddedService>) => onChange({ ...value, added: value.added.map(a => (a.key === key ? { ...a, ...patch } : a)) })
  const add = (patch: Partial<AddedService> = {}) => onChange({ ...value, added: [...value.added, {
    ...EMPTY_AGREEMENT, key: `nuevo-${Date.now()}`, transport_request_id: services[0].id, concept: 'GRUA', description: '', reason: '', ...patch,
  }] })
  const total = rows.reduce((sum, r) => {
    if (r.id && r.id in value.removed) return sum
    const a = r.forklift ? withForklift(r.agreement, forklift) : r.agreement
    const agreed = (r.agreement.supplier_id || r.agreement.agreed_rate || r.forklift) ? agreedAmount(a, r.concept) : null
    const line = lines.find(l => l.id === r.id)
    return sum + (agreed ?? (line ? Number(line.planned_pen ?? line.estimated_pen ?? 0) : 0))
  }, 0)
  const none = rows.length === 0 && services.every(s => s.unloading_required !== true)
  const input = 'w-full rounded-lg border border-slate-300 bg-white px-2 py-1.5 text-sm text-slate-900 outline-none focus:ring-2 focus:ring-[#002855]'

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Servicios especiales</p>
        {rows.length > 0 && <p className="text-xs text-slate-600">Total de la ruta: <b className="tabular-nums text-slate-900">S/ {money(total)}</b></p>}
      </div>
      {none && <p className="mt-1 text-slate-600">No requiere</p>}
      {services.filter(s => s.unloading_required && !rows.some(r => r.transport_request_id === s.id)).map(s => (
        <p key={s.id} className="mt-1 text-slate-500">{s.request_number}: requiere descarga · sin recurso detallado</p>
      ))}
      <ul className="mt-2 space-y-2">
        {rows.map(r => {
          const line = lines.find(l => l.id === r.id)
          const removed = !!r.id && r.id in value.removed
          const addedRow = value.added.find(a => a.key === r.key)
          return (
            <li key={r.key} className={`rounded-lg border p-2 ${removed ? 'border-red-200 bg-red-50/50' : 'border-slate-200 bg-slate-50'}`}>
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                {addedRow ? (<>
                  <select aria-label="Tipo de servicio" value={addedRow.concept} onChange={e => setAdded(r.key, { concept: e.target.value, billing_unit: UNITS[e.target.value][0], supplier_id: '' })} className="rounded border border-slate-300 bg-white px-1 py-0.5">
                    {Object.entries(CONCEPT_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                  {services.length > 1 ? <select aria-label="Parada" value={addedRow.transport_request_id} onChange={e => setAdded(r.key, { transport_request_id: e.target.value })} className="rounded border border-slate-300 bg-white px-1 py-0.5">
                    {services.map(s => <option key={s.id} value={s.id}>{s.request_number}</option>)}
                  </select> : <span className="font-semibold text-slate-800">{requestNumber(r.transport_request_id)}</span>}
                </>) : (<>
                  <span className="font-semibold text-slate-800">{CONCEPT_LABEL[r.concept] || r.concept}</span>
                  <span className="text-slate-500">{requestNumber(r.transport_request_id)}</span>
                </>)}
                <span className="rounded bg-blue-100 px-1.5 text-[11px] font-semibold text-blue-800">{addedRow ? 'Agregado en programación' : ORIGIN_LABEL[line?.origin || 'SOLICITUD'] || 'Solicitado'}</span>
                {line && <span className={`text-xs tabular-nums ${line.tariff_missing ? 'text-amber-700' : 'text-slate-600'}`}>Referencial {unloadingAmountLabel(line)}</span>}
                {line?.description && <span className="text-xs text-slate-500">{line.description}</span>}
                <span className="ml-auto">
                  {addedRow ? <button type="button" onClick={() => onChange({ ...value, added: value.added.filter(a => a.key !== r.key) })} className="text-slate-400 hover:text-red-600" aria-label="Quitar servicio agregado"><Trash2 className="h-4 w-4" /></button>
                    : removed ? <button type="button" onClick={() => { const next = { ...value.removed }; delete next[r.id!]; onChange({ ...value, removed: next }) }} className="inline-flex items-center gap-1 text-xs font-semibold text-slate-600 hover:underline"><Undo2 className="h-3.5 w-3.5" />Mantener</button>
                    : <button type="button" onClick={() => onChange({ ...value, removed: { ...value.removed, [r.id!]: '' } })} className="text-xs font-semibold text-red-600 hover:underline">No programar</button>}
                </span>
              </div>
              {removed ? (
                <label className="mt-2 block"><span className="mb-0.5 block text-[11px] font-semibold text-red-700">Motivo para no programarlo *</span>
                  <input value={value.removed[r.id!]} onChange={e => onChange({ ...value, removed: { ...value.removed, [r.id!]: e.target.value } })} className={input} placeholder="Ej.: el cliente descarga con su personal" /></label>
              ) : (<>
                <AgreementFields concept={r.concept} value={r.agreement} suppliers={suppliers} forklift={r.forklift ? forklift : null}
                  onChange={a => (addedRow ? setAdded(r.key, a) : setEdit(r.key, a))} />
                {line && (r.agreement.supplier_id || r.agreement.agreed_rate || r.forklift)
                  && agreedDiffers(line, agreedAmount(r.forklift ? withForklift(r.agreement, forklift) : r.agreement, r.concept)) &&
                  <label className="mt-2 block"><span className="mb-0.5 block text-[11px] font-semibold text-amber-800">Motivo (el acordado difiere del referencial) *</span>
                    <input value={r.agreement.reason} onChange={e => setEdit(r.key, { ...r.agreement, reason: e.target.value })} className={input} placeholder="Ej.: el proveedor cobra por tonelada" /></label>}
                {addedRow && <div className="mt-2 grid gap-2 sm:grid-cols-2">
                  <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Detalle</span>
                    <input value={addedRow.description} onChange={e => setAdded(r.key, { description: e.target.value })} className={input} placeholder="Opcional" /></label>
                  <label><span className="mb-0.5 block text-[11px] font-semibold text-slate-600">Motivo (no estaba en la solicitud) *</span>
                    <input value={addedRow.reason} onChange={e => setAdded(r.key, { reason: e.target.value })} className={input} placeholder="Ej.: la obra no tiene montacarga" /></label>
                </div>}
              </>)}
            </li>
          )
        })}
      </ul>
      <div className="mt-2 flex flex-wrap gap-2">
        <button type="button" onClick={() => add()} className="inline-flex items-center gap-1 rounded-lg border border-slate-300 px-2.5 py-1 text-xs font-semibold text-slate-700 hover:bg-slate-50"><Plus className="h-3.5 w-3.5" />Agregar servicio</button>
        {forklift.enabled && forklift.transport_request_id && !fk && <button type="button" onClick={() => add({ concept: 'MONTACARGAS', billing_unit: 'HORA', transport_request_id: forklift.transport_request_id })}
          className="inline-flex items-center gap-1 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-semibold text-amber-800 hover:bg-amber-100"><Plus className="h-3.5 w-3.5" />Agregar costo del montacarga</button>}
      </div>
      {rows.length > 0 && <p className="mt-2 text-[11px] text-slate-500">Sin proveedor ni tarifa, el servicio se programa con su monto referencial. Lo acordado se reserva en la partida y queda en el historial de costos.</p>}
    </div>
  )
}
