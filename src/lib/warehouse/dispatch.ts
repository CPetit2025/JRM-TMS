import type { BoardRow } from './packing-list'

export const DISPATCH_STAGES = {
  picking: { title: 'Picking', path: '/almacen/picking', description: 'Recoja y consolide LPN lógicos conservando las etiquetas existentes. Auditoría revisa en paralelo cada bulto cerrado.', permissions: ['almacen-lectura', 'almacen-picking', 'almacen-packing', 'almacen-supervisor'] },
  auditoria: { title: 'Auditoría', path: '/almacen/auditoria', description: 'Revise cada bulto mientras continúa Picking. Libere cada LPN conforme o registre observaciones y evidencia.', permissions: ['almacen-auditoria', 'almacen-supervisor'] },
  'packing-list': { title: 'Packing List', path: '/almacen/packing-list', description: 'Seleccione LPN liberados por Auditoría y asígnelos a UT1, UT2 o placa, conservando sus etiquetas.', permissions: ['almacen-lectura', 'almacen-picking', 'almacen-packing', 'almacen-carga', 'almacen-auditoria', 'almacen-supervisor'] },
  carga: { title: 'Carga', path: '/almacen/carga', description: 'Seleccione la unidad, escanee los bultos del Packing List liberado y confirme la salida.', permissions: ['almacen-carga', 'almacen-supervisor'] },
} as const
export type DispatchStage = keyof typeof DISPATCH_STAGES
export type TaskStage = 'picking' | 'carga'
export const canViewStage = (stage: DispatchStage, hasAccess: (key: string) => boolean) => DISPATCH_STAGES[stage].permissions.some(hasAccess)
export function taskInStage(task: BoardRow, stage: TaskStage) {
  if (stage === 'picking') return ['PENDING', 'PICKING', 'PACKING', 'PAUSED', 'PARTIAL', 'READY_FOR_LOAD'].includes(task.status) && !task.packing_list
  return task.status === 'READY_FOR_LOAD' && !!task.packing_list
}
