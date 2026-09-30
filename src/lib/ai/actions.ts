import type { SupabaseClient } from '@supabase/supabase-js'

// Acciones de escritura del Copiloto (oficina). El modelo solo PREPARA la propuesta: se resuelven referencias
// (OT, solicitud, gasto) y se muestra un resumen; nada se guarda hasta que el usuario presiona Confirmar.
// La ejecución usa las mismas funciones de la base que las pantallas, con la sesión del usuario, así que aplican
// exactamente sus permisos (partida, OT asignada, rol).

export const OFFICE_ACTIONS = ['REGISTER_CONTRACT_EXPENSE', 'UPDATE_EXPENSE_AMOUNT', 'CREATE_CONTRACT', 'CHANGE_REQUEST_STATUS'] as const
export type OfficeActionKind = (typeof OFFICE_ACTIONS)[number]
export type OfficeProposal = { kind: OfficeActionKind; title: string; lines: Array<{ label: string; value: string }>; params: Record<string, unknown> }

const EXPENSE_TYPES = ['MONTACARGA', 'GRUA', 'ESTIBA', 'MANIOBRA', 'PEAJE', 'PENALIDAD', 'ERROR', 'OTROS']
const CONTRACT_TYPES = ['CONTRATO', 'OT_INDEPENDIENTE', 'SUBCONTRATO', 'ERROR']
const REQUEST_STATUSES = ['APROBADA', 'RECHAZADA', 'REPROGRAMADA', 'CANCELADA']
const UUID = /^[0-9a-f-]{36}$/i
const MAX_TONS = 99_999.99

type Row = Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
const text = (v: unknown, max = 300) => (typeof v === 'string' ? v.trim().slice(0, max) : '')
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null)
const literal = (value: string) => value.replace(/[%_\\]/g, char => `\\${char}`)
const money = (n: number) => `S/ ${n.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/Lima' })
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v)

async function findContract(supabase: SupabaseClient, code: string) {
  if (!code) return null
  const { data } = await supabase.from('contracts').select('id, code, type, status, parent_contract_id, clients(business_name)')
    .ilike('code', literal(code)).limit(1).maybeSingle()
  return data as Row | null
}

async function partidaOf(supabase: SupabaseClient, contractId: string) {
  const { data: owner } = await supabase.rpc('contract_budget_owner', { p_contract_id: contractId })
  if (!owner) return null
  const { data } = await supabase.from('contract_budgets').select('balance_pen, contracts(code)')
    .eq('contract_id', owner as string).eq('concept', 'PARTIDA_TRANSPORTE').maybeSingle()
  return data as Row | null
}

export async function prepareOfficeAction(args: Record<string, unknown>, supabase: SupabaseClient):
  Promise<{ proposal: OfficeProposal } | { error: string }> {
  const kind = text(args.action) as OfficeActionKind
  if (!OFFICE_ACTIONS.includes(kind)) return { error: 'Acción no soportada.' }

  if (kind === 'REGISTER_CONTRACT_EXPENSE') {
    const contract = await findContract(supabase, text(args.contract_code, 80))
    if (!contract) return { error: 'Indique una OT, subcontrato o error existente (código).' }
    const type = text(args.service_type, 20).toUpperCase()
    if (!EXPENSE_TYPES.includes(type)) return { error: `Tipo de gasto inválido. Use: ${EXPENSE_TYPES.join(', ')}.` }
    const amount = num(args.amount)
    if (amount == null || amount <= 0) return { error: 'Indique el monto del gasto (S/).' }
    const hours = num(args.hours)
    if (type === 'MONTACARGA' && (hours == null || hours <= 0)) return { error: 'Para montacargas indique las horas.' }
    const date = text(args.service_date, 10) || today()
    if (!isDate(date)) return { error: 'La fecha debe tener el formato AAAA-MM-DD.' }
    const partida = await partidaOf(supabase, contract.id)
    const category = contract.type === 'SUBCONTRATO' ? 'Subcontrato' : contract.type === 'ERROR' ? 'Error' : 'Contrato'
    const params = {
      contract_id: contract.id, service_type: type, amount, service_date: date, hours: type === 'MONTACARGA' ? hours : null,
      description: text(args.description) || null, provider_name: text(args.provider_name, 150) || null,
      provider_ruc: text(args.provider_ruc, 11) || null, referral_guide: text(args.referral_guide, 200) || null, category,
    }
    return { proposal: { kind, title: 'Registrar gasto de OT', params, lines: [
      { label: 'Contrato', value: `${contract.code}${category !== 'Contrato' ? ` (${category})` : ''}` },
      { label: 'Gasto', value: `${type}${params.hours ? ` · ${params.hours} h` : ''}` },
      { label: 'Monto', value: money(amount) }, { label: 'Fecha', value: date },
      ...(params.provider_name ? [{ label: 'Proveedor', value: `${params.provider_name}${params.provider_ruc ? ` · RUC ${params.provider_ruc}` : ''}` }] : []),
      ...(params.referral_guide ? [{ label: 'Guía', value: params.referral_guide }] : []),
      ...(params.description ? [{ label: 'Detalle', value: params.description }] : []),
      { label: 'Partida', value: partida ? `${partida.contracts?.code || ''} · saldo ${money(Number(partida.balance_pen || 0))}` : 'Sin partida (no se podrá registrar)' },
    ] } }
  }

  if (kind === 'UPDATE_EXPENSE_AMOUNT') {
    const id = text(args.expense_id, 40)
    if (!UUID.test(id)) return { error: 'Primero consulte los gastos de la OT para identificar cuál editar.' }
    const amount = num(args.amount)
    if (amount == null || amount < 0) return { error: 'Indique el nuevo monto.' }
    const { data } = await supabase.from('contract_services').select('id, service_type, amount_pen, status, service_date, contracts!contract_id(code)').eq('id', id).maybeSingle()
    const row = data as Row | null
    if (!row) return { error: 'No encontré ese gasto.' }
    if (row.status === 'ANULADO') return { error: 'El gasto está anulado.' }
    return { proposal: { kind, title: 'Corregir monto de gasto', params: { service_id: id, amount }, lines: [
      { label: 'Contrato', value: row.contracts?.code || '—' }, { label: 'Gasto', value: `${row.service_type} · ${row.service_date || ''}` },
      { label: 'Monto actual', value: money(Number(row.amount_pen || 0)) }, { label: 'Nuevo monto', value: money(amount) },
    ] } }
  }

  if (kind === 'CREATE_CONTRACT') {
    const type = text(args.contract_type, 20).toUpperCase() || 'CONTRATO'
    if (!CONTRACT_TYPES.includes(type)) return { error: `Tipo inválido. Use: ${CONTRACT_TYPES.join(', ')}.` }
    const correlative = text(args.code, 60)
    if (!correlative) return { error: 'Indique el código o correlativo.' }
    let parent: Row | null = null
    if (type === 'SUBCONTRATO' || type === 'ERROR') {
      parent = await findContract(supabase, text(args.parent_code, 80))
      if (!parent) return { error: 'Indique el código del contrato madre.' }
    }
    const code = parent ? `${parent.code}-${correlative}` : correlative
    let client: Row | null = null
    const clientRef = text(args.client, 150)
    if (clientRef && !parent) {
      const byRuc = /^\d{11}$/.test(clientRef)
      const { data } = await supabase.from('clients').select('id, business_name, tax_id')
        [byRuc ? 'eq' : 'ilike'](byRuc ? 'tax_id' : 'business_name', byRuc ? clientRef : `%${literal(clientRef)}%`).limit(1).maybeSingle()
      client = data as Row | null
      if (!client) return { error: `No encontré el cliente "${clientRef}".` }
    }
    const tons = num(args.weight_tons) ?? 0
    if (tons < 0 || tons > MAX_TONS) return { error: 'El peso va en toneladas (máx. 99,999.99 t).' }
    const budget = num(args.budget) ?? 0
    if (budget < 0) return { error: 'La partida no puede ser negativa.' }
    const params = {
      payload: { code, type, parent_contract_id: parent?.id || null, client_id: client?.id || null,
        total_weight_kg: Math.round(tons * 1000 * 100) / 100, destination_district: text(args.destination_district, 80) || null,
        destination_address: text(args.destination_address, 200) || null },
      budget,
    }
    return { proposal: { kind, title: 'Registrar contrato / OT', params, lines: [
      { label: 'Código', value: code }, { label: 'Tipo', value: type.replace('_', ' ') },
      ...(parent ? [{ label: 'Contrato madre', value: parent.code }] : []),
      ...(client ? [{ label: 'Cliente', value: client.business_name }] : []),
      ...(budget ? [{ label: 'Partida', value: money(budget) }] : []),
      ...(tons ? [{ label: 'Peso', value: `${tons.toLocaleString('es-PE')} t` }] : []),
      ...(params.payload.destination_district ? [{ label: 'Destino', value: [params.payload.destination_district, params.payload.destination_address].filter(Boolean).join(' · ') }] : []),
    ] } }
  }

  // CHANGE_REQUEST_STATUS
  const number = text(args.request_number, 40)
  const status = text(args.new_status, 20).toUpperCase()
  if (!REQUEST_STATUSES.includes(status)) return { error: `Estado inválido. Use: ${REQUEST_STATUSES.join(', ')}.` }
  if (!number) return { error: 'Indique el número de la solicitud.' }
  const { data } = await supabase.from('transport_requests').select('id, request_number, status, required_date, delivery_district')
    .ilike('request_number', literal(number)).limit(1).maybeSingle()
  const request = data as Row | null
  if (!request) return { error: `No encontré la solicitud ${number}.` }
  const date = text(args.required_date, 10)
  if (status === 'REPROGRAMADA' && !isDate(date)) return { error: 'Para reprogramar indique la nueva fecha (AAAA-MM-DD).' }
  return { proposal: { kind, title: 'Cambiar estado de solicitud', params: { request_id: request.id, status, required_date: status === 'REPROGRAMADA' ? date : null }, lines: [
    { label: 'Solicitud', value: `${request.request_number}${request.delivery_district ? ` · ${request.delivery_district}` : ''}` },
    { label: 'Estado', value: `${request.status} → ${status}` },
    ...(status === 'REPROGRAMADA' ? [{ label: 'Nueva fecha', value: date }] : []),
  ] } }
}

export async function executeOfficeAction(payload: unknown, supabase: SupabaseClient): Promise<{ status: string }> {
  const p = (payload && typeof payload === 'object' ? payload : {}) as Partial<OfficeProposal>
  const params = (p.params && typeof p.params === 'object' ? p.params : {}) as Row
  if (!p.kind || !OFFICE_ACTIONS.includes(p.kind)) throw new Error('Acción no soportada.')

  if (p.kind === 'REGISTER_CONTRACT_EXPENSE') {
    if (!UUID.test(String(params.contract_id)) || !(Number(params.amount) > 0)) throw new Error('Datos del gasto inválidos.')
    const { error } = await supabase.rpc('register_contract_service', {
      p_contract_id: params.contract_id, p_service_type: String(params.service_type), p_description: params.description ?? null,
      p_amount_pen: Number(params.amount), p_service_date: params.service_date ?? null, p_plate: null, p_driver_name: null,
      p_hours: params.hours ?? null, p_provider_ruc: params.provider_ruc ?? null, p_provider_name: params.provider_name ?? null,
      p_category: params.category ?? 'Contrato', p_referral_guide: params.referral_guide ?? null,
    })
    if (error) throw new Error(error.message)
    return { status: 'Gasto registrado y descontado de la partida' }
  }
  if (p.kind === 'UPDATE_EXPENSE_AMOUNT') {
    if (!UUID.test(String(params.service_id)) || !(Number(params.amount) >= 0)) throw new Error('Datos inválidos.')
    const { error } = await supabase.rpc('update_contract_service_amount', { p_service_id: params.service_id, p_new_amount: Number(params.amount) })
    if (error) throw new Error(error.message)
    return { status: 'Monto actualizado; la partida se ajustó' }
  }
  if (p.kind === 'CREATE_CONTRACT') {
    const { data, error } = await supabase.rpc('create_contract', { p_payload: params.payload, p_budget_pen: Number(params.budget) || 0 })
    if (error) throw new Error(error.message)
    const result = data as { success?: boolean; error?: string; code?: string } | null
    if (!result?.success) throw new Error(result?.error || 'No se pudo registrar el contrato.')
    return { status: `Contrato ${result.code || ''} registrado` }
  }
  if (!UUID.test(String(params.request_id))) throw new Error('Solicitud inválida.')
  const { error } = await supabase.rpc('set_transport_request_status', {
    p_request_id: params.request_id, p_new_status: String(params.status), p_required_date: params.required_date ?? null,
  })
  if (error) throw new Error(error.message)
  return { status: `Solicitud ${String(params.status).toLowerCase()}` }
}
