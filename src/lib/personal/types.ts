export type Shift = { kind: 'TRABAJO' | 'DESCANSO' | 'SIN_HORARIO'; start?: string; end?: string; break_minutes?: number; minutes: number | null; next_day?: boolean }
export type Balance = { earned: number; taken: number; reserved: number; balance: number; legacy_unvalidated: number }
export type DayRow = { person_id: string; name: string; code: string; shift: Shift; status: string; note: string | null; permit_minutes: number }
export type Day = { day: { id: string; revision: number; confirmed_at: string } | null; rows: DayRow[]; can_confirm: boolean; can_correct: boolean }
export type Permit = { id: string; person_id: string; person: string; code: string; work_date: string; minutes: number; kind: string; compensation: boolean; status: string; reason: string; revision: number; can_approve: boolean }
export type Overview = {
 permits: Permit[]; balances: { person_id: string; person: string; code: string; area_id: string; balance: Balance }[]
 schedules: { id: string; person_id: string; person: string; mode: string; valid_from: string; valid_to: string | null; week: Shift[] }[]
 attendance: { work_date: string; area_id: string; area: string; status: string; people: number }[]
 overtime: { area: string; cause: string; source: string; authorized_minutes: number; executed_minutes: number | null; validated_minutes: number | null; compensation_minutes: number | null; open_lines: number; awaiting_validation: number }[]
 events: { event: string; detail: unknown; created_at: string; actor: string }[]
}
