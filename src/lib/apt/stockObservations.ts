import { createClient } from '@/lib/supabase/client'

export interface StockObservationInput {
  cutoff: string; almacen: string; lote: string; producto: string
  peso_kg: string; source: 'ERP' | 'FISICO'; reference: string; notes?: string
}
export interface StockReconciliationRow {
  id: string; cutoff: string; almacen: string; lote: string; producto: string
  source: 'ERP' | 'FISICO'; reference: string; notes: string | null
  observed_kg: number; documentary_kg: number | null; difference_kg: number | null
  created_at: string; status: 'MODELO_NO_DISPONIBLE' | 'MODELO_PENDIENTE' | 'COINCIDE_DOCUMENTAL' | 'DIFERENCIA'
}
export interface StockReconciliation {
  success: boolean; cutoff: string | null; model_cutoff: string | null
  documentary_available: boolean; model_fresh: boolean; latest_applied_at: string | null; scope: 'OBSERVACIONES_REGISTRADAS'
  certifies_full_inventory: false; rows: StockReconciliationRow[]
  total: number; limit: number; offset: number
}
async function call<T>(fn: string, p: object): Promise<T> {
  const { data, error } = await createClient().rpc(fn, { p })
  if (error || !data?.success) throw new Error(error?.message || data?.error || 'No se pudo consultar la conciliación.')
  return data as T
}
export const stockObservations = {
  list: (p: { cutoff?: string; almacen?: string; lote?: string; source?: string; limit?: number; offset?: number }) => call<StockReconciliation>('apt_stock_reconciliation', p),
  save: (p: StockObservationInput) => call<{ success: true; id: string }>('apt_stock_observation_save', p),
}
