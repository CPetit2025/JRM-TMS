import type { SupabaseClient } from '@supabase/supabase-js'
import type { StatusTone } from '@/components/ui/status-badge'
import { compressPhoto } from '@/lib/delivery'

// Hallazgos de auditoría de despacho: valores y reglas de la interfaz (el contrato lo valida de nuevo la base).
export const FINDINGS_BUCKET = 'audit_findings'
export type Severity = 'MENOR' | 'MAYOR' | 'CRITICO'
export type FindingStatus = 'ABIERTO' | 'EN_CORRECCION' | 'PENDIENTE_VALIDACION' | 'CERRADO'
export type Phase = 'ANTES' | 'DESPUES'

export const SEVERITY: Record<Severity, { label: string; tone: StatusTone }> = {
  MENOR: { label: 'Menor', tone: 'info' }, MAYOR: { label: 'Mayor', tone: 'warning' }, CRITICO: { label: 'Crítico', tone: 'danger' },
}
export const STATUS: Record<FindingStatus, { label: string; tone: StatusTone }> = {
  ABIERTO: { label: 'Abierto', tone: 'warning' }, EN_CORRECCION: { label: 'En corrección', tone: 'special' },
  PENDIENTE_VALIDACION: { label: 'Pend. validación', tone: 'info' }, CERRADO: { label: 'Cerrado', tone: 'success' },
}

export type FindingRow = {
  id: string; number: string; registered_at: string; ot_code: string | null; client_name: string | null; contract_id: string; client_id: string | null
  categories: string[] | null; severity: Severity; status: FindingStatus; responsible_id: string | null; responsible_name: string | null
  auditor_id: string | null; auditor_name: string | null; due_date: string | null; overdue: boolean
}
export type Kpis = { abiertos: number; vencidos: number; pendientes_validacion: number; cerrados: number }
export type Evidence = {
  id: string; finding_id: string; correction_id: string | null; phase: Phase; file_path: string; description: string | null
  mime_type: string | null; uploaded_by: string | null; uploaded_by_name?: string | null; uploaded_at: string; voided_at: string | null; void_reason?: string | null
}
export type Correction = {
  id: string; round: number; action_executed: string | null; executed_at: string | null; corrected_by: string | null; corrected_by_name?: string | null
  observations: string | null; submitted_by: string | null; submitted_at: string | null; validated_by: string | null; validated_by_name?: string | null
  validated_at: string | null; result: 'CONFORME' | 'RECHAZADO' | null; validation_comment: string | null; no_photo_reason: string | null
}
export type FindingEvent = { id: number; event_type: string; from_status: string | null; to_status: string | null; actor: string | null; actor_name?: string | null; at: string; detail: Record<string, unknown> | null }
export type Finding = FindingRow & {
  dispatch_id: string | null; transport_request_id: string | null; site_id: string | null; destination: string | null; process_area: string | null
  description: string | null; material_code: string | null; material_description: string | null; quantity: number | null; unit: string | null
  location: string | null; observations: string | null; required_action: string | null; responsible_area: string | null; attended_at: string | null; closed_at: string | null
}
export type Category = { id: string; code?: string; name: string; is_safety?: boolean }
export type Detail = { finding: Finding; categories: Category[]; evidence: Evidence[]; corrections: Correction[]; events: FindingEvent[] }
export type OtOption = {
  contract_id: string; ot_code: string; client_id: string | null; client_name: string | null; site_id: string | null
  dispatches: { dispatch_id: string | null; dispatch_number: string | null; status: string | null; transport_request_id: string | null; request_number: string | null; destination: string | null }[]
}

/** La base devuelve `{success, error?, ...}`: un `success:false` se trata como error. */
export async function callRpc<T = Record<string, unknown>>(supabase: SupabaseClient, name: string, args: Record<string, unknown>): Promise<T> {
  const { data, error } = await supabase.rpc(name, args)
  if (error) throw error
  if (data && typeof data === 'object' && !Array.isArray(data) && (data as { success?: boolean }).success === false)
    throw new Error((data as { error?: string }).error || 'Operación rechazada')
  return data as T
}

/** Ronda vigente: la última corrección registrada. */
export const currentRound = (d: Pick<Detail, 'corrections'>) => [...d.corrections].sort((a, b) => b.round - a.round)[0] || null

/** Fotos DESPUÉS vigentes de la ronda en curso (las sin ronda aún se asignan a la que se envía). */
export const afterPhotos = (d: Pick<Detail, 'corrections' | 'evidence'>) => {
  const round = currentRound(d)
  return d.evidence.filter(e => e.phase === 'DESPUES' && !e.voided_at && (!e.correction_id || e.correction_id === round?.id))
}

/** Cerrar como Conforme exige foto DESPUÉS de la ronda o un motivo de «no requiere foto». */
export const canCloseConforme = (d: Pick<Detail, 'corrections' | 'evidence'>, noPhotoReason: string) =>
  afterPhotos(d).length > 0 || noPhotoReason.trim().length > 0

export type Abilities = { write: boolean; validate: boolean; admin: boolean; userId: string | null }
/** Acciones visibles según permiso y estado (separación de funciones: quien corrigió no valida). */
export function findingActions(f: Pick<Finding, 'status' | 'responsible_id'>, can: Abilities, lastCorrectorId: string | null = null) {
  const responsible = !!can.userId && f.responsible_id === can.userId
  return {
    edit: can.write && f.status === 'ABIERTO',
    assign: can.write && (f.status === 'ABIERTO' || f.status === 'EN_CORRECCION'),
    before: can.write && f.status !== 'CERRADO',
    after: (responsible || can.admin) && f.status === 'EN_CORRECCION',
    correct: (responsible || can.admin) && f.status === 'EN_CORRECCION',
    validate: can.validate && f.status === 'PENDIENTE_VALIDACION' && (!lastCorrectorId || lastCorrectorId !== can.userId),
    fixDate: can.validate || can.admin,
  }
}

const PHOTO_MIME = ['image/jpeg', 'image/png', 'image/webp']
export const PHOTO_ACCEPT = 'image/jpeg,image/png,image/webp'
const EXT: Record<string, string> = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' }

/** Comprime (lado mayor 2000 px), sube al bucket privado y registra la evidencia. */
export async function uploadEvidence(supabase: SupabaseClient, findingId: string, phase: Phase, userId: string, raw: File, description: string) {
  const file = await compressPhoto(raw, 2000)
  if (!PHOTO_MIME.includes(file.type)) throw new Error('Solo se aceptan fotos JPG, PNG o WEBP.')
  if (file.size > 10 * 1024 * 1024) throw new Error('La foto supera 10 MB.')
  const path = `${findingId}/${phase}/${userId}/${crypto.randomUUID()}.${EXT[file.type]}`
  const { error } = await supabase.storage.from(FINDINGS_BUCKET).upload(path, file, { contentType: file.type, upsert: false })
  if (error) throw error
  return callRpc(supabase, 'audit_finding_add_evidence', { p_finding: findingId, p_phase: phase, p_file_path: path, p_description: description || null, p_mime: file.type, p_size: file.size })
}

export async function signedUrls(supabase: SupabaseClient, paths: string[]) {
  if (!paths.length) return new Map<string, string>()
  const { data } = await supabase.storage.from(FINDINGS_BUCKET).createSignedUrls(paths, 60 * 30)
  return new Map((data || []).flatMap(x => x.signedUrl && x.path ? [[x.path, x.signedUrl] as [string, string]] : []))
}
