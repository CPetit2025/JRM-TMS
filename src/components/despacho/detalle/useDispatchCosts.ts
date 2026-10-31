'use client'
import { useEffect, useMemo, useState } from 'react'
import { createClient } from '@/lib/supabase/client'
import type { DispatchCosts, EconomicDetail, RouteExpense } from '@/lib/dispatch-detail'

/**
 * Costos de la ruta (economic_closure_detail, que controla el acceso económico) y gastos de Caja de la ruta (RLS de
 * dispatch_expenses). Se piden solo al abrir la pestaña Costos; sin permiso se informa y no se muestra nada.
 */
export function useDispatchCosts(dispatchId: string, enabled: boolean) {
  const db = useMemo(() => createClient(), [])
  const [state, setState] = useState<{ key: string; costs: DispatchCosts | null }>({ key: '', costs: null })
  const [attempt, setAttempt] = useState(0)
  const key = `${dispatchId}/${attempt}`
  useEffect(() => {
    if (!enabled) return
    let alive = true
    void (async () => {
      const [econ, expenses] = await Promise.all([
        Promise.resolve(db.rpc('economic_closure_detail', { p_dispatch_id: dispatchId })).catch(() => ({ data: null, error: { message: 'No se pudo cargar el cierre económico.' } })),
        Promise.resolve(db.from('dispatch_expenses').select('id,expense_type,amount,status,description,created_at').eq('dispatch_id', dispatchId).order('created_at'))
          .catch(() => ({ data: null, error: { message: 'error' } })),
      ])
      const result = econ.data as (EconomicDetail | { success: false; error?: string }) | null
      const detail = result && result.success ? result as EconomicDetail : null
      if (alive) setState({ key, costs: {
        detail, error: detail ? '' : (result && !result.success && result.error) || econ.error?.message || 'Sin acceso al cierre económico de esta ruta.',
        expenses: ((expenses.data || []) as RouteExpense[]).filter(e => e.status !== 'ANULADO'),
        expensesError: expenses.error ? 'Sin acceso a los gastos de Caja de la ruta.' : '',
      } })
    })()
    return () => { alive = false }
  }, [db, dispatchId, key, enabled])
  const current = state.key === key
  return { costs: current ? state.costs : null, loading: !current, reload: () => setAttempt(n => n + 1) }
}
