// Catálogos y tipos de hallazgos del WMS (los valores coinciden con los CHECK de wh_findings)
export const FINDING_CATEGORIES: Record<string, string> = {
  FALTANTE: 'Faltante', SOBRANTE: 'Sobrante', CALIDAD: 'Calidad', SKU_INCORRECTO: 'SKU o material incorrecto', ROTULADO: 'Rotulado',
  EMBALAJE: 'Embalaje', DOCUMENTACION: 'Documentación', COMPOSICION: 'Composición / trazabilidad', ESTIBA_SEGURIDAD: 'Estiba / seguridad',
  NO_DECLARADO: 'Componente no declarado', OTRO: 'Otro',
}
export const SEVERITIES: Record<string, string> = { MENOR: 'Menor', MAYOR: 'Mayor', CRITICA: 'Crítica' }
export const AREAS: Record<string, string> = { DESPACHO: 'Despacho', RECEPCION: 'Recepción APT', INVENTARIO: 'Inventario', DOCUMENTARIO: 'Control documentario', TRANSPORTE: 'Transporte', OTRO: 'Otra área' }
export const FINDING_STATUS: Record<string, { label: string; style: string }> = {
  ABIERTO: { label: 'Abierto', style: 'bg-rose-100 text-rose-900' },
  EN_CORRECCION: { label: 'En corrección', style: 'bg-amber-100 text-amber-900' },
  PENDIENTE_VERIFICACION: { label: 'Pendiente de verificación', style: 'bg-blue-100 text-blue-900' },
  CERRADO: { label: 'Cerrado', style: 'bg-emerald-100 text-emerald-900' },
}
export type FindingLine = { id: number; package_code: string; product_code: string | null; contract_code: string | null; unit: string | null; quantity: number; kg: number | null; weight_state: string; declared: boolean; corrected_qty: number; verified_qty: number }
export type FindingEvent = { action: string; from: string | null; to: string | null; comment: string | null; evidence_paths: string[]; by: string | null; by_id: string; at: string }
export type Finding = { id: string; code: string; task_id: string; task_code: string; request_number: string | null; lpn_id: string; lpn_code: string; audit_rev: number; lpn_rev: number
  categories: string[]; severity: string; exceptionable: boolean; description: string; area: string; status: string; cause: string | null; reopen_count: number
  assigned_to: string | null; assigned_name: string | null; due_at: string | null; created_by: string; created_name: string | null; created_at: string; closed_at: string | null; closed_name: string | null
  kg: number | null; kg_sin_peso: number; kg_pendiente: number | null; lines: FindingLine[]; events: FindingEvent[] }
export const ACTIONS: Record<string, string> = { REGISTRAR: 'Registró', START: 'Inició corrección', CORRECTED: 'Registró corrección', VERIFY_OK: 'Verificó conforme', VERIFY_REJECT: 'Verificación no conforme', REOPEN: 'Reabrió', ASSIGN: 'Asignó', COMMENT: 'Comentó', CAUSE: 'Confirmó causa' }
