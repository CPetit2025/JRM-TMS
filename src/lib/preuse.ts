import format from './preuse-format.json'

export const PREUSE_FORMAT = format
export type PreuseResponse = 'B' | 'M' | 'R' | 'N/A'
export type PreuseAnswer = { code: string; response: PreuseResponse | ''; comment: string }
export type SignaturePoint = { x: number; y: number }
export type PreuseInspection = {
  operation_id: string; inspection_id: string | null; driver_id: string; vehicle_plate: string
  unit_revision: string; operation_date: string; captured_at: string; created_at: string
  driver_name: string; license: string; soat_expiration: string; technical_review_expiration: string
  answers: PreuseAnswer[]; vehicle_operational: boolean; can_operate: boolean
  observation: string; inspector_name: string; signature: SignaturePoint[][]
}
export type PreuseUnit = { plate: string; soat_expiration: string | null; technical_review_expiration: string | null }
export type PreuseContext = {
  operation_date: string; driver: { id: string; profile_id: string; name: string; license: string } | null
  vehicles: PreuseUnit[]; unit: { vehicle_plate: string; revision: string; operation_date: string } | null
  assigned_unit?: PreuseUnit | null
  latest: PreuseInspection | null; pending: boolean; route_plate: string | null
}
export const limaDay = (at = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Lima', year: 'numeric', month: '2-digit', day: '2-digit' }).format(at)
export const blankPreuseAnswers = (): PreuseAnswer[] => format.items.map(item => ({ code: item.code, response: '', comment: '' }))
export function validatePreuseAnswers(answers: PreuseAnswer[]) {
  return answers.length === format.items.length && new Set(answers.map(a => a.code)).size === format.items.length &&
    format.items.every(item => answers.some(a => a.code === item.code && ['B','M','R','N/A'].includes(a.response) && typeof a.comment === 'string' && a.comment.length <= 120))
}
export function validPreuseSignature(strokes: SignaturePoint[][]) {
  return Array.isArray(strokes) && strokes.length > 0 && strokes.length <= 100 && strokes.flat().length >= 4 && strokes.flat().length <= 2000 &&
    strokes.every(stroke => Array.isArray(stroke) && stroke.length >= 2 && stroke.every(p => Number.isFinite(p.x) && Number.isFinite(p.y) && p.x >= 0 && p.x <= 1 && p.y >= 0 && p.y <= 1))
}
