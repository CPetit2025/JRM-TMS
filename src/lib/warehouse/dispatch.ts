import type { BoardRow } from './packing-list'

export const DISPATCH_STAGES = {
  picking: { title: 'Picking', path: '/almacen/picking', description: 'Recoja, consolide y etiquete bultos. Auditoría revisa en paralelo cada bulto cerrado.', permissions: ['almacen-lectura', 'almacen-picking', 'almacen-packing', 'almacen-supervisor'] },
  auditoria: { title: 'Auditoría', path: '/almacen/auditoria', description: 'Revise cada bulto mientras continúa Picking. Registre aprobaciones, observaciones y evidencia.', permissions: ['almacen-auditoria', 'almacen-supervisor'] },
  'packing-list': { title: 'Packing List', path: '/almacen/packing-list', description: 'Consulte el contenido auditado y libere el documento cuando termine Picking y todos los bultos estén aprobados.', permissions: ['almacen-lectura', 'almacen-picking', 'almacen-packing', 'almacen-carga', 'almacen-auditoria', 'almacen-supervisor'] },
  'plan-carga': { title: 'Plan de carga', path: '/almacen/plan-carga', description: 'Distribuya los bultos entre UT1, UT2 o placas. Puede planificar mientras continúan Picking y Auditoría; esto no autoriza la carga.', permissions: ['almacen-packing', 'almacen-carga', 'almacen-supervisor'] },
  carga: { title: 'Carga', path: '/almacen/carga', description: 'Seleccione la unidad, escanee los bultos del Packing List liberado y confirme la salida.', permissions: ['almacen-carga', 'almacen-supervisor'] },
} as const
export type DispatchStage = keyof typeof DISPATCH_STAGES
export type TaskStage = 'picking' | 'plan-carga' | 'carga'
export const canViewStage = (stage: DispatchStage, hasAccess: (key: string) => boolean) => DISPATCH_STAGES[stage].permissions.some(hasAccess)
export function taskInStage(task: BoardRow, stage: TaskStage) {
  if (stage === 'picking') return ['PENDING', 'PICKING', 'PACKING', 'PAUSED', 'PARTIAL', 'READY_FOR_LOAD'].includes(task.status) && !task.packing_list
  if (stage === 'plan-carga') return ['PICKING', 'PACKING', 'READY_FOR_LOAD'].includes(task.status) && task.lpn_total > 0
  return task.status === 'READY_FOR_LOAD' && !!task.packing_list
}
