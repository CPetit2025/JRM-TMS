import type { SincEstado, SincMotivo } from './types'

// Sinceramiento APT (almacén virtual SF): textos de motivos y estados
export const SINC_MOTIVO: Record<SincMotivo, string> = {
  DESPACHADO_SIN_GUIA: 'Despachado sin guía en el ERP',
  SALDO_INICIAL_INFERIDO: 'Saldo inicial inferido (no existió)',
  ERROR_DIGITACION: 'Error de digitación',
  MERMA_NO_UBICADO: 'Merma, chatarra o no ubicado',
}
export const SINC_ESTADO: Record<SincEstado, { label: string; cls: string }> = {
  PROPUESTA: { label: 'Por autorizar', cls: 'bg-amber-50 text-amber-800 border-amber-200' },
  AUTORIZADA: { label: 'En almacén SF', cls: 'bg-blue-50 text-[#002855] border-blue-200' },
  REGULARIZADA: { label: 'Regularizada en ERP', cls: 'bg-emerald-50 text-emerald-800 border-emerald-200' },
  RECHAZADA: { label: 'Rechazada', cls: 'bg-red-50 text-red-700 border-red-200' },
  ANULADA: { label: 'Anulada', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
  REVERTIDA: { label: 'Revertida', cls: 'bg-slate-100 text-slate-600 border-slate-200' },
}
export const SF_BODEGA = 'SF-SINCERAMIENTO'
