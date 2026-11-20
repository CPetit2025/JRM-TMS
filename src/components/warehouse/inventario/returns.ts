// Catálogos de Logística Inversa (los valores coinciden con los CHECK de la base). Motivo, condición y disposición son campos distintos.
export const MOTIVOS: Record<string, string> = { SALDO_OBRA: 'Saldo de obra', DEVOLUCION: 'Devolución', ERROR: 'Error', CALIDAD: 'Calidad', GARANTIA: 'Garantía', REPROCESO: 'Material para reproceso', NO_ANUNCIADO: 'No anunciado', OTRO: 'Otro' }
export const CONDICIONES: Record<string, string> = { UTILIZABLE: 'Utilizable sin intervención', REQUIERE_ACONDICIONAMIENTO: 'Requiere acondicionamiento', REQUIERE_REPROCESO: 'Requiere reproceso', DANADO: 'Dañado', PENDIENTE_EVALUACION: 'Pendiente de evaluación', NO_IDENTIFICADO: 'No identificado' }
export const DISPOSICIONES: Record<string, string> = { REINCORPORAR: 'Reincorporar a stock', ACONDICIONAR: 'Acondicionar', REPROCESAR: 'Reprocesar', TRANSFERIR: 'Transferir', DEVOLVER: 'Devolver a origen', MANTENER_BLOQUEADO: 'Mantener bloqueado', BAJA: 'Dar de baja' }
export const ESTADOS: Record<string, { label: string; style: string }> = {
  RECIBIDO_ERP: { label: 'Ingresado en ERP', style: 'bg-slate-100 text-slate-700' }, PROVISIONAL: { label: 'Provisional', style: 'bg-violet-100 text-violet-900' },
  EN_RECEPCION: { label: 'En recepción', style: 'bg-blue-100 text-blue-900' }, PENDIENTE_INSPECCION: { label: 'Pendiente de inspección', style: 'bg-amber-100 text-amber-900' },
  EN_DISPOSICION: { label: 'En disposición', style: 'bg-amber-100 text-amber-900' }, EN_TRATAMIENTO: { label: 'En reproceso', style: 'bg-orange-100 text-orange-900' },
  RESUELTO: { label: 'Resuelto', style: 'bg-emerald-100 text-emerald-900' }, CERRADO: { label: 'Cerrado', style: 'bg-emerald-200 text-emerald-950' },
}
export const DISP_ESTADO: Record<string, string> = { PROPUESTA: 'Propuesta', AUTORIZADA: 'Autorizada', RECHAZADA: 'Rechazada', EJECUTADA: 'Ejecutada', VERIFICADA: 'Verificada' }
export const fmtQ = (n: number | null | undefined, d = 3) => n == null ? '—' : Number(n).toLocaleString('es-PE', { maximumFractionDigits: d })
export const fmtD = (v: string | null | undefined) => v ? new Date(v).toLocaleString('es-PE', { timeZone: 'America/Lima', dateStyle: 'short', timeStyle: 'short' }) : '—'
