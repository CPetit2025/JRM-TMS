'use client'
import { useCallback } from 'react'
import { createClient } from '@/lib/supabase/client'
import { usePermissions } from '@/hooks/usePermissions'
import { erpState, ingresosState } from '@/lib/update-status'
import { UpdateBanner, type UpdateSource } from './UpdateBanner'

// WMS: ERP (stock y contratos) e ingresos desde su propia base. Los botones agregan una ejecución al robot;
// las cargas automáticas siguen igual. Solo carga o supervisión ven los botones (la base vuelve a comprobarlo).
export function WmsUpdateBanner() {
  const { hasAccess, isLoaded } = usePermissions()
  const canRequest = isLoaded && ['almacen-carga', 'almacen-supervisor'].some(hasAccess)
  const load = useCallback(async () => {
    const db = createClient(), now = new Date()
    const { data, error } = await db.rpc('wh_public_update_status')
    if (error) throw error
    const ask = (rpc: string) => canRequest ? async () => { const { error } = await db.rpc(rpc); if (error) throw error } : undefined
    const sources: UpdateSource[] = [
      { key: 'erp', title: 'ERP: stock y contratos', state: erpState(data.erp, now), request: ask('erp_robot_request') },
      { key: 'ingresos', title: 'Ingresos WMS', state: ingresosState(data.ingresos, now), request: ask('wh_receipt_robot_request') },
    ]
    return sources
  }, [canRequest])
  return <UpdateBanner load={load}/>
}
