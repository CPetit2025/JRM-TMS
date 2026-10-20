import { createClient } from '@/lib/supabase/client'

// HHEE simple: Personal → Solicitud → Aprobación (informe PDF + correo) → Panel gerencial (funciones hhee_flow_*)

export type Caps = { request: boolean; approve: boolean; people: boolean; costs: boolean; remuneration: boolean; config: boolean; admin: boolean }
export type Area = { id: string; name: string; site_name: string | null; can_request: boolean; can_approve: boolean }
export type Concept = { name: string; amount: number; computable: boolean }
export type Person = {
  id: string; code: string; name: string; document_number: string | null; position: string | null; area_id: string; area_name: string | null
  active: boolean; daily_hours: number; monthly_hours: number; divisor_confirmed: boolean; effective_from: string | null; rate_ready: boolean
  updated_at: string; base_hour_cost?: number | null; remuneration_concepts?: Concept[]
  // Enlace por DNI: nombre y DNI vienen de Flota (conductor) o de Maestros (trabajador)
  driver_id?: string | null; master?: 'FLOTA' | 'MAESTROS' | null
}
export type FlowContext = {
  user_id: string; caps: Caps; areas: Area[]; causes: Array<{ id: string; name: string }>; people: Person[]
  settings: { recurrence_days: number; recurrence_events: number; report_to: string; report_cc: string }
}
export type Totals = { workers: number; minutes: number; minutes_25: number; minutes_35: number; minutes_100: number; cost?: number; pending_cost: number }
export type Approval = 'PENDIENTE' | 'APROBADA' | 'OBSERVADA' | 'RECHAZADA'
export type RequestRow = Totals & {
  id: string; sequence: number; version: number; work_date: string; area_id: string; area: string; cause_id: string; cause: string; activity: string
  state: string; approval: Approval; created_by: string; requester: string; approver: string | null; approved_at: string | null; submitted_at: string | null
  created_at: string; approval_reason: string | null; revisions: number; can_edit: boolean; can_decide: boolean
}
export type Line = {
  id?: string; person_id: string; name: string; code: string; position: string | null; start: string; end: string; break_minutes: number; minutes: number
  minutes_25: number | null; minutes_35: number | null; minutes_100: number | null; approved_minutes?: number | null; rate_ready?: boolean; cost?: number | null
  document_number?: string | null; rest_day?: boolean
  // Conductor: placa de su ruta asignada (RUTA) o indicada a mano con motivo (MANUAL)
  dispatch_id?: string | null; dispatch_number?: string | null; vehicle_plate?: string | null; plate_source?: 'RUTA' | 'MANUAL' | null; plate_reason?: string | null
}
export type Snapshot = {
  revision: number; area: string; site: string | null; cause: string; requester: string; approver: string
  request: { id: string; sequence: number; work_date: string; activity: string; justification: string; alternatives: string; expected_result: string
    reference_type: string; reference_code: string | null; created_at: string; submitted_at: string | null; approved_at: string; approval_reason: string }
  lines: Line[]; totals: Totals; holiday?: string | null
}
export type Authorization = { id: string; revision: number; approved_at: string; approver: string; snapshot: Snapshot }
export type Detail = {
  cost_visible: boolean; holiday?: string | null
  request: RequestRow & { justification: string; alternatives: string; expected_result: string; reference_type: string; reference_code: string | null }
  lines: Line[]; authorizations: Authorization[]; events: Array<{ at: string; event: string; reason: string | null; by: string }>
}
export type Dashboard = {
  from: string; to: string; cost_visible: boolean; recurrence_days: number; recurrence_events: number
  metrics: { requests: number; approved: number; pending: number; observed: number; rejected: number; hours: number; hours_25: number; hours_35: number
    hours_100: number; hours_unclassified: number; workers: number; cost: number | null; cost_pending_lines: number; approval_hours_avg: number | null; recurrent_workers: number }
  trend: Array<{ day: string; hours: number; requests: number; cost: number | null }>
  causes: Array<{ id: string; name: string; hours: number; requests: number; workers: number; cost: number | null }>
  supervisors: Array<{ id: string; name: string; hours: number; requests: number; cost: number | null }>
  people: Array<{ id: string; name: string; code: string; hours: number; days: number; recent_days: number; recurrent: boolean; cost: number | null }>
  weekdays: Array<{ dow: number; hours: number }>
  causes_by_month: Array<{ month: string; cause: string; hours: number }>
}

// Cálculo legal del servidor (hhee_flow_preview): primeras 2 h del día al 25 %, resto al 35 %; descanso o feriado al 100 %
export type Route = { id: string; number: string | null; plate: string; status: string | null; departure: string | null }
export type PreviewLine = { person_id: string; minutes?: number; m25?: number; m35?: number; m100?: number; prior?: number; error?: string; driver?: boolean; routes?: Route[] | null }
export type UnifyIssue = { kind: 'COINCIDE_SIN_ENLACE' | 'NOMBRE_DISTINTO' | 'SIN_DNI' | 'CONDUCTOR_SIN_FICHA' | 'DNI_REPETIDO_FLOTA'; doc: string | null
  person_id: string | null; code: string | null; name: string | null; area: string | null; driver_id: string | null; driver_name: string | null }
export type UnifyReport = { summary: { people: number; linked_driver: number; linked_profile: number; drivers_active: number; by_kind: Partial<Record<UnifyIssue['kind'], number>> }; rows: UnifyIssue[] }
export const plateLabel = (l: Pick<Line, 'vehicle_plate' | 'dispatch_number' | 'plate_source' | 'plate_reason'>) =>
  !l.plate_source ? '' : l.plate_source === 'RUTA' ? `Placa ${l.vehicle_plate}${l.dispatch_number ? ` · ruta ${l.dispatch_number}` : ''}`
    : `${l.vehicle_plate ? `Placa ${l.vehicle_plate}` : 'Sin unidad'} (indicada: ${l.plate_reason ?? ''})`
export type Preview = { holiday: string | null; isodow: number; lines: PreviewLine[] }
export type Consolidated = { cost_visible: boolean; skipped: number; items: Array<{ request_id: string; revision: number; snapshot: Snapshot }> }
export const LEGAL_BASIS = 'D.S. 007-2002-TR (TUO Ley de Jornada) art. 10: primeras 2 h extra del día con 25 % y las siguientes con 35 %. D. Leg. 713: trabajo en día de descanso o feriado con 100 %.'

export async function call<T>(fn: string, args: Record<string, unknown> = {}): Promise<T> {
  const { data, error } = await createClient().rpc(fn, args)
  if (error) throw new Error(error.message.includes('statement timeout') ? 'La consulta tardó demasiado. Acote el período e inténtelo otra vez.' : error.message)
  if (!data?.success) throw Object.assign(new Error(data?.error || 'No se pudo completar la operación'), { data })
  return data as T
}

// Cálculo de la ficha (mismo criterio que hhee_base_rate): conceptos computables ÷ divisor mensual
export const RECARGOS = [{ key: 'minutes_25', label: '25 %', factor: 1.25 }, { key: 'minutes_35', label: '35 %', factor: 1.35 }, { key: 'minutes_100', label: '100 %', factor: 2 }] as const
export function baseRate(concepts: Concept[], divisor: number): number | null {
  const computable = concepts.filter(c => c.computable && Number.isFinite(c.amount))
  if (!computable.length || !(divisor > 0)) return null
  return Math.round((computable.reduce((t, c) => t + c.amount, 0) / divisor) * 10000) / 10000
}
export const lineCost = (rate: number | null | undefined, m25: number, m35: number, m100: number) =>
  rate == null ? null : Math.round(rate * (m25 * 1.25 + m35 * 1.35 + m100 * 2) / 60 * 100) / 100

const money = new Intl.NumberFormat('es-PE', { style: 'currency', currency: 'PEN', minimumFractionDigits: 2, maximumFractionDigits: 2 })
export const fmtMoney = (v: number | null | undefined) => (v == null ? '—' : money.format(v))
export const fmtHours = (minutes: number | null | undefined) => {
  if (minutes == null) return '—'
  const h = Math.floor(minutes / 60), m = Math.round(minutes % 60)
  return m ? `${h} h ${m} min` : `${h} h`
}
export const fmtNum = (v: number | null | undefined, d = 1) => (v == null ? '—' : new Intl.NumberFormat('es-PE', { maximumFractionDigits: d }).format(v))
export const fmtDate = (v: string | null | undefined) => (v ? new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(v.length === 10 ? `${v}T12:00:00-05:00` : v)) : '—')
export const fmtDateTime = (v: string | null | undefined) => (v ? new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' }).format(new Date(v)) : '—')
export const fmtTime = (v: string | null | undefined) => (v ? new Intl.DateTimeFormat('es-PE', { timeZone: 'America/Lima', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date(v)) : '—')
// «2026-10-19T18:00» en hora de Lima, para el formulario
export function limaLocal(v: string | null | undefined): string {
  if (!v) return ''
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })
    .formatToParts(new Date(v)).map(x => [x.type, x.value]))
  return `${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}`
}
export const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima' }).format(new Date())

export const STATUS: Record<string, { label: string; tone: string }> = {
  BORRADOR: { label: 'Borrador', tone: 'bg-slate-100 text-slate-700' },
  PENDIENTE: { label: 'Pendiente de aprobación', tone: 'bg-amber-50 text-amber-900' },
  APROBADA: { label: 'Aprobada', tone: 'bg-emerald-50 text-emerald-800' },
  OBSERVADA: { label: 'Observada', tone: 'bg-orange-50 text-orange-800' },
  RECHAZADA: { label: 'Rechazada', tone: 'bg-red-50 text-red-800' },
  CANCELADA: { label: 'Anulada', tone: 'bg-slate-100 text-slate-500' },
  EJECUTADA: { label: 'Ejecutada (flujo anterior)', tone: 'bg-blue-50 text-blue-800' },
  VALIDADA: { label: 'Validada (flujo anterior)', tone: 'bg-blue-50 text-blue-800' },
}
export function statusOf(r: Pick<RequestRow, 'state' | 'approval'>): keyof typeof STATUS {
  if (r.state === 'CANCELADA') return 'CANCELADA'
  if (r.state === 'EJECUTADA' || r.state === 'VALIDADA') return r.state
  if (r.approval === 'APROBADA' || r.approval === 'RECHAZADA' || r.approval === 'OBSERVADA') return r.approval
  return r.state === 'SOLICITADA' ? 'PENDIENTE' : 'BORRADOR'
}
export const REFERENCES = [['SIN_REFERENCIA', 'Sin referencia'], ['OT', 'OT'], ['OC', 'OC'], ['OS', 'OS'], ['RQ', 'RQ'], ['MANTENIMIENTO', 'Mantenimiento']] as const
